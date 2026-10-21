import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cypress from "cypress";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HARNESS_DIRECTORY, "cypress.config.mjs");
const DIAGNOSTICS_DIRECTORY = resolve(HARNESS_DIRECTORY, "diagnostics");
// Electron is the approved Phase-1 matrix cell, not a spec-level assumption.
const DEFAULT_BROWSER = "electron";
const SUPPORTED_BROWSERS = new Set([
  "chrome",
  "chromium",
  "edge",
  "electron",
  "firefox",
]);
const OPERATING_SYSTEMS = new Map([
  ["linux", "linux"],
  ["macos", "darwin"],
  ["ubuntu", "linux"],
  ["windows", "win32"],
]);
const DEFAULT_OPERATING_SYSTEMS = new Map([
  ["darwin", "macos"],
  ["linux", "linux"],
  ["win32", "windows"],
]);
const SCENARIOS = new Map([
  ["smoke", "specs/smoke.cy.mjs"],
  ["web-calculator", "specs/web-calculator.cy.mjs"],
]);

function parseArguments(arguments_) {
  const [scenario, ...options] = arguments_;
  let browser;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--browser") {
      browser = options[index + 1];
      if (browser === undefined) {
        throw new Error("--browser requires a value");
      }
      index += 1;
    } else if (option.startsWith("--browser=")) {
      browser = option.slice("--browser=".length);
    } else {
      throw new Error(
        `Unknown argument: ${option}\n` +
          "Usage: harness.mjs smoke|web-calculator " +
          "[--browser electron|chrome|chromium|firefox|edge]",
      );
    }
  }

  return { browser, scenario };
}

export function resolveBrowserSelection({
  arguments_ = process.argv.slice(2),
  environment = process.env,
} = {}) {
  const { browser: argumentBrowser, scenario } = parseArguments(arguments_);
  if (!SCENARIOS.has(scenario)) {
    throw new Error(
      `Unknown Cypress scenario: ${scenario ?? "(missing)"}\n` +
        "Usage: harness.mjs smoke|web-calculator " +
        "[--browser electron|chrome|chromium|firefox|edge]",
    );
  }

  const requestedBrowser =
    argumentBrowser ?? environment.E2E_BROWSER ?? DEFAULT_BROWSER;
  const browser = requestedBrowser.trim().toLowerCase();
  if (!SUPPORTED_BROWSERS.has(browser)) {
    throw new Error(
      `Unsupported E2E browser "${requestedBrowser}". ` +
        `Supported values: ${[...SUPPORTED_BROWSERS].join(", ")}`,
    );
  }

  return {
    browser,
    scenario,
    source:
      argumentBrowser !== undefined
        ? "--browser"
        : environment.E2E_BROWSER !== undefined
          ? "E2E_BROWSER"
          : "local default",
  };
}

function detectLinuxDistribution() {
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const id = osRelease.match(/^ID=(?:"([^"]+)"|'([^']+)'|(.+))$/m);
    return (id?.[1] ?? id?.[2] ?? id?.[3] ?? "unknown").toLowerCase();
  } catch {
    return "unknown";
  }
}

export function resolveOperatingSystemSelection({
  environment = process.env,
  platform = process.platform,
  linuxDistribution =
    platform === "linux" ? detectLinuxDistribution() : undefined,
} = {}) {
  const defaultOperatingSystem = DEFAULT_OPERATING_SYSTEMS.get(platform);
  if (defaultOperatingSystem === undefined) {
    throw new Error(`Unsupported host platform "${platform}"`);
  }

  const requestedOperatingSystem =
    environment.E2E_OS ?? defaultOperatingSystem;
  const operatingSystem = requestedOperatingSystem.trim().toLowerCase();
  const expectedPlatform = OPERATING_SYSTEMS.get(operatingSystem);
  if (expectedPlatform === undefined) {
    throw new Error(
      `Unsupported E2E operating system "${requestedOperatingSystem}". ` +
        `Supported values: ${[...OPERATING_SYSTEMS.keys()].join(", ")}`,
    );
  }
  if (expectedPlatform !== platform) {
    throw new Error(
      `E2E_OS="${requestedOperatingSystem}" requires host platform ` +
        `"${expectedPlatform}", but the current host is "${platform}"`,
    );
  }
  if (operatingSystem === "ubuntu" && linuxDistribution !== "ubuntu") {
    throw new Error(
      `E2E_OS="${requestedOperatingSystem}" requires Ubuntu, but the ` +
        `current Linux distribution is "${linuxDistribution}"`,
    );
  }

  return {
    hostDistribution: linuxDistribution ?? null,
    hostPlatform: platform,
    operatingSystem,
    operatingSystemSource:
      environment.E2E_OS === undefined ? "local default" : "E2E_OS",
  };
}

async function cypressVersion() {
  const packageJson = JSON.parse(
    await readFile(resolve(HARNESS_DIRECTORY, "package.json"), "utf8"),
  );
  return packageJson.dependencies.cypress;
}

async function retainFailureDiagnostics(selection, result, error) {
  const scenarioDirectory = resolve(
    DIAGNOSTICS_DIRECTORY,
    selection.scenario,
  );
  await mkdir(scenarioDirectory, { recursive: true });
  await writeFile(
    resolve(scenarioDirectory, "run.json"),
    `${JSON.stringify(
      {
        browser: selection.browser,
        cypressVersion: await cypressVersion(),
        error: error?.stack ?? null,
        failures: result?.failures ?? null,
        hostDistribution: selection.hostDistribution,
        message: result?.message ?? null,
        nodeVersion: process.version,
        operatingSystem: selection.operatingSystem,
        operatingSystemSource: selection.operatingSystemSource,
        hostPlatform: selection.hostPlatform,
        scenario: selection.scenario,
        selectionSource: selection.source,
        totalFailed: result?.totalFailed ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function failureMessage(selection, result) {
  if (result?.failures && result.totalFailed === undefined) {
    return (
      `Cypress could not launch the requested browser ` +
      `"${selection.browser}". Verify that it is installed on this runner. ` +
      `${result.message ?? ""}`.trim()
    );
  }
  if (result?.message) {
    return result.message;
  }
  if (result?.failures) {
    return `Cypress could not run ${selection.browser}: ${result.failures}`;
  }
  return (
    `Cypress ${selection.scenario} failed in ${selection.browser} ` +
    `with ${result?.totalFailed ?? "an unknown number of"} failed tests`
  );
}

async function run() {
  const selection = {
    ...resolveBrowserSelection(),
    ...resolveOperatingSystemSelection(),
  };
  const baseUrl =
    selection.scenario === "web-calculator"
      ? process.env.WEB_CALCULATOR_URL
      : undefined;
  if (selection.scenario === "web-calculator" && !baseUrl) {
    throw new Error(
      "WEB_CALCULATOR_URL is required; run through the fixture lifecycle task",
    );
  }

  await rm(DIAGNOSTICS_DIRECTORY, { force: true, recursive: true });
  process.stdout.write(
    `Cypress ${await cypressVersion()} with Node ${process.version}; ` +
      `os=${selection.operatingSystem} ` +
      `(${selection.operatingSystemSource}, host=${selection.hostPlatform}` +
      `${selection.hostDistribution === null ? "" : `/${selection.hostDistribution}`}); ` +
      `browser=${selection.browser} (${selection.source})\n`,
  );

  let result;
  try {
    result = await cypress.run({
      browser: selection.browser,
      config: baseUrl === undefined ? {} : { baseUrl },
      configFile: CONFIG_PATH,
      project: HARNESS_DIRECTORY,
      spec: resolve(HARNESS_DIRECTORY, SCENARIOS.get(selection.scenario)),
    });
  } catch (error) {
    await retainFailureDiagnostics(selection, result, error);
    throw error;
  }

  if (result.failures || result.totalFailed > 0) {
    await retainFailureDiagnostics(selection, result);
    throw new Error(failureMessage(selection, result));
  }

  process.stdout.write(
    `Cypress ${selection.scenario} passed in ` +
      `${result.browserName} ${result.browserVersion} on ` +
      `${result.osName} ${result.osVersion}.\n`,
  );
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
