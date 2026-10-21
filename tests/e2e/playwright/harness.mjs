#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const SCENARIOS = new Map([
  ["smoke", "smoke.spec.mjs"],
  ["web-calculator", "web-calculator.spec.mjs"],
]);

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

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: HARNESS_DIRECTORY,
      stdio: "inherit",
      ...options,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}`,
        ),
      );
    });
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function prepare(project) {
  const lockContents = await readFile(LOCKFILE);
  const lockHash = createHash("sha256").update(lockContents).digest("hex");
  let installedHash = null;
  try {
    installedHash = (await readFile(INSTALL_STAMP, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (installedHash !== lockHash) {
    await run(npmCommand(), [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    await writeFile(INSTALL_STAMP, `${lockHash}\n`);
  }

  await run(npmCommand(), [
    "exec",
    "--",
    "playwright",
    "install",
    project,
  ]);
}

async function runTest(scenario, project) {
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
    PLAYWRIGHT_PROJECT: project,
  };
  await run(
    npmCommand(),
    [
      "exec",
      "--",
      "playwright",
      "test",
      specification,
      `--project=${project}`,
    ],
    { env: environment },
  );
}

async function runScenario(scenario, project) {
  if (!SCENARIOS.has(scenario)) {
    fail(
      `Unknown Playwright scenario "${scenario}". ` +
        `Expected one of: ${[...SCENARIOS.keys()].join(", ")}.`,
    );
  }

  await prepare(project);
  process.stdout.write(
    `Playwright selection: project=${project} ` +
      `os=${process.env.E2E_OS ?? process.platform}\n`,
  );

  if (scenario === "web-calculator") {
    await run(process.execPath, [
      FIXTURE_LIFECYCLE,
      process.execPath,
      fileURLToPath(import.meta.url),
      "test",
      scenario,
      project,
    ]);
    return;
  }
  await runTest(scenario, project);
}

async function main() {
  const [command, scenario, selection, ...extra] = process.argv.slice(2);
  if (extra.length !== 0) {
    fail(
      "Usage: harness.mjs scenario SCENARIO [BROWSER] or " +
        "harness.mjs test SCENARIO PROJECT",
    );
  }

  if (command === "scenario") {
    await runScenario(scenario, selectProject(selection));
    return;
  }
  if (command === "test") {
    const project = selectProject(selection);
    await runTest(scenario, project);
    return;
  }
  fail("Usage: harness.mjs scenario SCENARIO [BROWSER]");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
