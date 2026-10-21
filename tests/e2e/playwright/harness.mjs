#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedPlatform,
  npmInvocation,
  ProcessStoppedError,
  runProcess,
  signalExitCode,
} from "./process-runner.mjs";
import {
  scenarioPaths,
  writeHarnessFailureResult,
} from "./reporting.mjs";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HARNESS_DIRECTORY, "../../..");
const FIXTURE_LIFECYCLE = resolve(
  REPOSITORY_ROOT,
  "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
);
const LOCKFILE = resolve(HARNESS_DIRECTORY, "package-lock.json");
const INSTALL_STAMP = resolve(
  HARNESS_DIRECTORY,
  "node_modules/.oculix-package-lock.sha256",
);
const PROJECTS = new Set(["chromium", "firefox", "webkit"]);
const OPERATING_SYSTEMS = new Map([
  [
    "linux",
    {
      aliases: ["linux", "ubuntu", "ubuntu-latest"],
      pattern: /^ubuntu-\d{2}\.\d{2}$/,
    },
  ],
  [
    "darwin",
    {
      aliases: ["macos", "macos-latest"],
      pattern: /^macos-\d+$/,
    },
  ],
]);
const SCENARIOS = new Map([
  ["smoke", "smoke.spec.mjs"],
  ["web-calculator", "web-calculator.spec.mjs"],
]);
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 2 * 60_000;
const FIXTURE_TIMEOUT_MS = 3 * 60_000;

function fail(message) {
  throw new Error(message);
}

function normalize(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function selectProject(argument) {
  const sources = [
    ["task argument", normalize(argument)],
    ["PLAYWRIGHT_PROJECT", normalize(process.env.PLAYWRIGHT_PROJECT)],
    ["E2E_BROWSER", normalize(process.env.E2E_BROWSER)],
  ].filter(([, value]) => value !== null);

  const distinct = new Set(sources.map(([, value]) => value));
  if (distinct.size > 1) {
    fail(
      `Conflicting Playwright selections: ${sources
        .map(([source, value]) => `${source}=${value}`)
        .join(", ")}`,
    );
  }

  const selected = sources[0]?.[1] ?? "chromium";
  if (!PROJECTS.has(selected)) {
    fail(
      `Unknown Playwright browser/project "${selected}". ` +
        `Expected one of: ${[...PROJECTS].join(", ")}.`,
    );
  }
  return selected;
}

export function validateOperatingSystem(
  selected,
  {
    arch = process.arch,
    linuxRelease = null,
    platform = process.platform,
  } = {},
) {
  assertSupportedPlatform(platform);
  const family = OPERATING_SYSTEMS.get(platform);
  if (family === undefined) {
    fail(`Unsupported host platform "${platform}".`);
  }

  if (
    !family.aliases.includes(selected) &&
    !family.pattern.test(selected)
  ) {
    fail(
      `E2E_OS "${selected}" does not describe the current ` +
        `${platform}/${arch} host. Expected one of: ` +
        `${family.aliases.join(", ")} or ${family.pattern}.`,
    );
  }
  if (
    platform === "linux" &&
    selected.startsWith("ubuntu") &&
    linuxRelease?.id !== "ubuntu"
  ) {
    fail(
      `E2E_OS "${selected}" requires an Ubuntu host, but ` +
        `/etc/os-release reports ${linuxRelease?.id ?? "no distribution ID"}.`,
    );
  }
  const versionedUbuntu = /^ubuntu-(\d{2}\.\d{2})$/.exec(selected);
  if (
    versionedUbuntu !== null &&
    linuxRelease?.versionId !== versionedUbuntu[1]
  ) {
    fail(
      `E2E_OS "${selected}" requires Ubuntu ${versionedUbuntu[1]}, but ` +
        `/etc/os-release reports ${linuxRelease?.versionId ?? "no VERSION_ID"}.`,
    );
  }
  return selected;
}

function releaseValue(contents, key) {
  const match = new RegExp(`^${key}="?([^"\\n]+)"?$`, "m").exec(contents);
  return match?.[1]?.toLowerCase() ?? null;
}

async function linuxRelease() {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const release = await readFile("/etc/os-release", "utf8");
    return {
      id: releaseValue(release, "ID"),
      versionId: releaseValue(release, "VERSION_ID"),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function selectedOperatingSystem() {
  return validateOperatingSystem(
    normalize(process.env.E2E_OS) ?? process.platform,
    {
      linuxRelease: await linuxRelease(),
    },
  );
}

async function currentLockHash() {
  const lockContents = await readFile(LOCKFILE);
  return createHash("sha256").update(lockContents).digest("hex");
}

function preparationStamp(project) {
  return resolve(
    HARNESS_DIRECTORY,
    `node_modules/.oculix-playwright-${process.platform}-${process.arch}-${project}.json`,
  );
}

async function runNpm(arguments_, options = {}) {
  const invocation = npmInvocation(arguments_);
  await runProcess(invocation.command, invocation.arguments_, {
    cwd: HARNESS_DIRECTORY,
    ...options,
  });
}

async function prepare(project, operatingSystem) {
  const lockHash = await currentLockHash();
  let installedHash = null;
  try {
    installedHash = (await readFile(INSTALL_STAMP, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (installedHash !== lockHash) {
    await runNpm([
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], {
      timeoutMs: PREPARE_TIMEOUT_MS,
    });
    await writeFile(INSTALL_STAMP, `${lockHash}\n`);
  }

  const installArguments = ["exec", "--", "playwright", "install"];
  if ((await linuxRelease())?.id === "ubuntu") {
    installArguments.push("--with-deps");
  }
  installArguments.push(project);
  await runNpm(installArguments, {
    timeoutMs: PREPARE_TIMEOUT_MS,
  });
  await writeFile(
    preparationStamp(project),
    `${JSON.stringify({
      arch: process.arch,
      lockHash,
      operatingSystem,
      platform: process.platform,
      project,
    })}\n`,
  );
}

export function validatePreparationRecord(record, expected) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record)
  ) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, value]) => record[key] === value,
  );
}

async function requirePreparation(project, operatingSystem) {
  const stamp = preparationStamp(project);
  try {
    const record = JSON.parse(await readFile(stamp, "utf8"));
    const expected = {
      arch: process.arch,
      lockHash: await currentLockHash(),
      operatingSystem,
      platform: process.platform,
      project,
    };
    if (!validatePreparationRecord(record, expected)) {
      fail(
        `Playwright ${project} preparation is stale for ` +
          `${operatingSystem}/${process.platform}/${process.arch}. Run ` +
          `"mise run e2e:playwright:setup ${project}" again.`,
      );
    }
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      fail(
        `Playwright ${project} is not prepared for ` +
          `${operatingSystem}/${process.platform}/${process.arch}. Run ` +
          `"mise run e2e:playwright:setup ${project}" before offline scenarios.`,
      );
    }
    throw error;
  }
}

async function runTest(scenario, project, operatingSystem) {
  const specification = SCENARIOS.get(scenario);
  if (specification === undefined) {
    fail(
      `Unknown Playwright scenario "${scenario}". ` +
        `Expected one of: ${[...SCENARIOS.keys()].join(", ")}.`,
    );
  }

  const environment = {
    ...process.env,
    E2E_BROWSER: project,
    E2E_OS: operatingSystem,
    PLAYWRIGHT_PROJECT: project,
    PLAYWRIGHT_SCENARIO: scenario,
  };
  await runNpm(
    playwrightTestArguments(specification, project),
    {
      env: environment,
      timeoutMs: TEST_TIMEOUT_MS,
    },
  );
}

export function playwrightTestArguments(specification, project) {
  return [
    "exec",
    "--offline",
    "--",
    "playwright",
    "test",
    specification,
    `--project=${project}`,
  ];
}

async function writeDiagnostics(scenario, project, operatingSystem, error) {
  const paths = scenarioPaths(scenario);
  await mkdir(paths.directory, {
    recursive: true,
  });
  await writeFile(
    paths.harnessDiagnostics,
    `${JSON.stringify(
      {
        arch: process.arch,
        browser: project,
        error: error.message,
        node: process.version,
        operatingSystem,
        platform: process.platform,
        scenario,
      },
      null,
      2,
    )}\n`,
  );
  await writeHarnessFailureResult(scenario, {
    browser: project,
    error,
    operatingSystem,
  });
  process.stderr.write(
    `Playwright harness diagnostics: ${paths.harnessDiagnostics}\n`,
  );
}

async function runScenario(scenario, project, operatingSystem) {
  if (!SCENARIOS.has(scenario)) {
    fail(
      `Unknown Playwright scenario "${scenario}". ` +
        `Expected one of: ${[...SCENARIOS.keys()].join(", ")}.`,
    );
  }

  try {
    await requirePreparation(project, operatingSystem);
    process.stdout.write(
      `Playwright selection: project=${project} ` +
        `os=${operatingSystem} host=${process.platform}/${process.arch}\n`,
    );

    if (scenario === "web-calculator") {
      await runProcess(
        process.execPath,
        [
          FIXTURE_LIFECYCLE,
          process.execPath,
          fileURLToPath(import.meta.url),
          "test",
          scenario,
          project,
        ],
        {
          cwd: HARNESS_DIRECTORY,
          timeoutMs: FIXTURE_TIMEOUT_MS,
        },
      );
      return;
    }
    await runTest(scenario, project, operatingSystem);
  } catch (error) {
    await writeDiagnostics(scenario, project, operatingSystem, error);
    throw error;
  }
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);

  const operatingSystem = await selectedOperatingSystem();
  if (command === "prepare") {
    if (arguments_.length > 1) {
      fail("Usage: harness.mjs prepare BROWSER");
    }
    await prepare(selectProject(arguments_[0]), operatingSystem);
    return;
  }
  if (command === "scenario") {
    if (arguments_.length < 1 || arguments_.length > 2) {
      fail("Usage: harness.mjs scenario SCENARIO [BROWSER]");
    }
    const [scenario, selection] = arguments_;
    await runScenario(
      scenario,
      selectProject(selection),
      operatingSystem,
    );
    return;
  }
  if (command === "test") {
    if (arguments_.length !== 2) {
      fail("Usage: harness.mjs test SCENARIO PROJECT");
    }
    const [scenario, selection] = arguments_;
    const project = selectProject(selection);
    await runTest(scenario, project, operatingSystem);
    return;
  }
  fail(
    "Usage: harness.mjs prepare [BROWSER], " +
      "harness.mjs scenario SCENARIO [BROWSER], or " +
      "harness.mjs test SCENARIO PROJECT",
  );
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode =
      error instanceof ProcessStoppedError &&
      error.reason.kind === "signal"
        ? signalExitCode(error.reason.signal)
        : 1;
  });
}
