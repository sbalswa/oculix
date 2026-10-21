import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCypressPlatformSupported } from "./platform.mjs";
import {
  prepareScenarioDiagnostics,
  writeScenarioResult,
} from "./reporting.mjs";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HARNESS_DIRECTORY, "cypress.config.mjs");
const DIAGNOSTICS_DIRECTORY = resolve(HARNESS_DIRECTORY, "diagnostics");
// Chrome is the approved Phase-1 matrix cell, not a spec-level assumption.
const DEFAULT_BROWSER = "chrome";
const SUPPORTED_BROWSERS = new Set([
  "chrome",
  "chromium",
  "edge",
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
          "[--browser chrome|chromium|firefox|edge]",
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
        "[--browser chrome|chromium|firefox|edge]",
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

async function dependencyVersions() {
  const packageJson = JSON.parse(
    await readFile(resolve(HARNESS_DIRECTORY, "package.json"), "utf8"),
  );
  return {
    axeCore: packageJson.dependencies["axe-core"],
    cypress: packageJson.dependencies.cypress,
  };
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

export async function runHarness({
  importCypress = () => import("cypress"),
  platform = process.platform,
} = {}) {
  assertCypressPlatformSupported({ platform });
  const { default: cypress } = await importCypress();
  const selection = {
    ...resolveBrowserSelection(),
    ...resolveOperatingSystemSelection({ platform }),
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

  const versions = await dependencyVersions();
  const startedAt = new Date().toISOString();
  await prepareScenarioDiagnostics(
    DIAGNOSTICS_DIRECTORY,
    selection.scenario,
  );
  process.stdout.write(
    `Cypress ${await cypressVersion()} with Node ${process.version}; ` +
      `os=${selection.operatingSystem} ` +
      `(${selection.operatingSystemSource}, host=${selection.hostPlatform}` +
      `${selection.hostDistribution === null ? "" : `/${selection.hostDistribution}`}); ` +
      `browser=${selection.browser} (${selection.source})\n`,
  );

  let result;
  let runError;
  try {
    const scenarioDirectory = resolve(
      DIAGNOSTICS_DIRECTORY,
      selection.scenario,
    );
    result = await cypress.run({
      browser: selection.browser,
      config: {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        downloadsFolder: resolve(scenarioDirectory, "downloads"),
        env: {
          axeCoreVersion: versions.axeCore,
          diagnosticsDirectory: DIAGNOSTICS_DIRECTORY,
          reportScenario: selection.scenario,
        },
        screenshotsFolder: resolve(scenarioDirectory, "screenshots"),
        videosFolder: resolve(scenarioDirectory, "videos"),
      },
      configFile: CONFIG_PATH,
      project: HARNESS_DIRECTORY,
      spec: resolve(HARNESS_DIRECTORY, SCENARIOS.get(selection.scenario)),
    });
  } catch (error) {
    runError = error;
  }

  const finishedAt = new Date().toISOString();
  await writeScenarioResult({
    axeCoreVersion: versions.axeCore,
    cypressVersion: versions.cypress,
    diagnosticsDirectory: DIAGNOSTICS_DIRECTORY,
    error: runError,
    finishedAt,
    repositoryRoot: resolve(HARNESS_DIRECTORY, "../../.."),
    result,
    selection,
    startedAt,
  });
  if (runError) {
    throw runError;
  }
  if (result.failures || result.totalFailed > 0) {
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
  runHarness().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
