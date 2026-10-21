import { access, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import chrome from "selenium-webdriver/chrome.js";

import { resolveCapability } from "./configuration.mjs";
import { writeFailureDiagnostics } from "./diagnostics.mjs";
import {
  DIAGNOSTICS_DIRECTORY,
  HARNESS_DIRECTORY,
  runtimeStatePath,
  scenarioLogDirectory,
} from "./runtime.mjs";

async function packageVersion() {
  const packageJson = JSON.parse(
    await readFile(resolve(HARNESS_DIRECTORY, "package.json"), "utf8"),
  );
  return packageJson.dependencies["selenium-webdriver"];
}

function driverVersion(capabilities) {
  const chromeOptions = capabilities.get("chrome");
  if (chromeOptions && typeof chromeOptions.chromedriverVersion === "string") {
    return chromeOptions.chromedriverVersion.split(" ")[0];
  }
  return "unknown";
}

async function browserMetadata(driver, capability, state) {
  const capabilities = await driver.getCapabilities();
  return {
    browser: capability.browser,
    browserBinary: state.browserBinary,
    browserName: capabilities.getBrowserName(),
    browserSource: capability.browserSource,
    browserVersion: capabilities.getBrowserVersion(),
    downloadsAllowed: state.downloadsAllowed,
    driverBinary: state.driverBinary,
    driverVersion: driverVersion(capabilities),
    hostDistribution: capability.hostDistribution,
    hostPlatform: capability.hostPlatform,
    nodeVersion: process.version,
    os: capability.os,
    osSource: capability.osSource,
    platformName: capabilities.getPlatform(),
    provisioner: state.provisioner,
    seleniumVersion: await packageVersion(),
  };
}

async function loadResourceState(capability) {
  const statePath = runtimeStatePath(capability);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Selenium resources are not prepared at ${statePath}. ` +
        "Run the Selenium setup task before the scenario.",
      { cause: error },
    );
  }

  if (
    state.schemaVersion !== 1 ||
    state.browser !== capability.browser ||
    state.os !== capability.os ||
    typeof state.browserBinary !== "string" ||
    typeof state.driverBinary !== "string"
  ) {
    throw new Error(
      `Selenium resource state at ${statePath} does not match ` +
        `${capability.os}/${capability.browser}; rerun setup.`,
    );
  }
  await access(state.browserBinary);
  await access(state.driverBinary);
  return state;
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export async function createDriverWithService({ create, service }) {
  try {
    return await create(service);
  } catch (caughtError) {
    const error = asError(caughtError);
    try {
      await service.kill();
    } catch (cleanupError) {
      if (cleanupError !== error) {
        error.cleanupError = asError(cleanupError);
      }
    }
    throw error;
  }
}

export async function buildAndConfigureDriver({
  build,
  configure = async (driver) => {
    await driver.manage().setTimeouts({
      implicit: 0,
      pageLoad: 15_000,
      script: 5_000,
    });
  },
}) {
  let driver;
  try {
    driver = await build();
    await configure(driver);
    return driver;
  } catch (caughtError) {
    const error = asError(caughtError);
    if (driver !== undefined) {
      try {
        await driver.quit();
      } catch (cleanupError) {
        if (cleanupError !== error) {
          error.cleanupError = asError(cleanupError);
        }
      }
    }
    throw error;
  }
}

async function buildDriver(state, logPaths) {
  const options = new chrome.Options();
  options.addArguments(
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-sync",
    "--headless=new",
    "--no-first-run",
    "--no-sandbox",
    "--window-size=1280,720",
  );
  options.setChromeBinaryPath(state.browserBinary);
  options.setChromeLogFile(logPaths.browser);

  const service = new chrome.ServiceBuilder(state.driverBinary)
    .loggingTo(logPaths.driver)
    .build();

  return buildAndConfigureDriver({
    build: () =>
      createDriverWithService({
        create: () => chrome.Driver.createSession(options, service),
        service,
      }),
  });
}

async function prepareScenarioLogs(capability, scenario) {
  const directory = scenarioLogDirectory(capability, scenario);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  return {
    directory,
    paths: {
      browser: resolve(directory, "browser.log"),
      driver: resolve(directory, "driver.log"),
    },
  };
}

function baseMetadata(capability, state) {
  return {
    browser: capability?.browser ?? process.env.E2E_BROWSER ?? "chrome",
    browserBinary: state?.browserBinary ?? null,
    browserSource: capability?.browserSource ?? null,
    downloadsAllowed: state?.downloadsAllowed ?? null,
    driverBinary: state?.driverBinary ?? null,
    hostDistribution: capability?.hostDistribution ?? null,
    hostPlatform: process.platform,
    os: capability?.os ?? process.env.E2E_OS ?? null,
    osSource: capability?.osSource ?? null,
    phase: state === undefined ? "startup" : "driver-startup",
    provisioner: state?.provisioner ?? null,
  };
}

export async function runScenario(scenario, scenarioFunction) {
  let capability;
  let driver;
  let failure;
  let logDirectory;
  let logPaths = {};
  let metadata;
  let state;

  await rm(resolve(DIAGNOSTICS_DIRECTORY, scenario), {
    force: true,
    recursive: true,
  });

  try {
    capability = resolveCapability();
    state = await loadResourceState(capability);
    const logs = await prepareScenarioLogs(capability, scenario);
    logDirectory = logs.directory;
    logPaths = logs.paths;
    driver = await buildDriver(state, logPaths);
    metadata = await browserMetadata(driver, capability, state);
    console.log(
      [
        `Selenium ${metadata.seleniumVersion}`,
        `Node ${metadata.nodeVersion}`,
        `${metadata.browserName} ${metadata.browserVersion}`,
        `driver ${metadata.driverVersion}`,
        `capability ${metadata.os}/${metadata.browser}`,
        `provisioner ${metadata.provisioner}`,
      ].join(" | "),
    );
    await scenarioFunction(driver, capability);
  } catch (caughtError) {
    failure = asError(caughtError);
    metadata = {
      ...baseMetadata(capability, state),
      ...metadata,
    };
    await writeFailureDiagnostics({
      diagnosticsDirectory: DIAGNOSTICS_DIRECTORY,
      driver,
      error: failure,
      logPaths,
      metadata,
      scenario,
    }).catch((diagnosticError) => {
      console.error(
        `Could not retain Selenium diagnostics: ${diagnosticError}`,
      );
    });
  }

  if (driver !== undefined) {
    try {
      await driver.quit();
    } catch (quitError) {
      if (failure !== undefined) {
        failure.cleanupError = quitError;
      } else {
        failure = quitError;
        await writeFailureDiagnostics({
          diagnosticsDirectory: DIAGNOSTICS_DIRECTORY,
          driver,
          error: quitError,
          logPaths,
          metadata: {
            ...baseMetadata(capability, state),
            ...metadata,
            phase: "cleanup",
          },
          scenario,
        }).catch((diagnosticError) => {
          console.error(
            `Could not retain Selenium diagnostics: ${diagnosticError}`,
          );
        });
      }
    }
  }

  if (logDirectory !== undefined) {
    await rm(logDirectory, { force: true, recursive: true });
  }
  if (failure !== undefined) {
    throw failure;
  }
}
