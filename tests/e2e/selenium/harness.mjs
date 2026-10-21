import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Builder } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS_DIRECTORY = resolve(HARNESS_DIRECTORY, "diagnostics");
const DEFAULT_BROWSER = "chromium";
const MAX_TEXT_DIAGNOSTIC_BYTES = 256 * 1024;

const BROWSERS = new Map([
  [
    "chromium",
    {
      driverBrowser: "chrome",
      description: "Chromium-compatible browser",
    },
  ],
  [
    "chrome",
    {
      driverBrowser: "chrome",
      description: "Google Chrome",
    },
  ],
]);

function parseArguments(arguments_) {
  let browser;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browser") {
      if (browser !== undefined) {
        throw new Error("Browser selection may only be provided once");
      }
      browser = arguments_[index + 1];
      if (browser === undefined) {
        throw new Error("--browser requires a value");
      }
      index += 1;
    } else if (argument.startsWith("--browser=")) {
      if (browser !== undefined) {
        throw new Error("Browser selection may only be provided once");
      }
      browser = argument.slice("--browser=".length);
    } else {
      throw new Error(
        `Unknown argument: ${argument}\nUsage: [--browser chromium|chrome]`,
      );
    }
  }

  return { browser };
}

export function resolveBrowserSelection({
  arguments_ = process.argv.slice(2),
  environment = process.env,
} = {}) {
  const { browser: argumentBrowser } = parseArguments(arguments_);
  const requestedBrowser =
    argumentBrowser ?? environment.E2E_BROWSER ?? DEFAULT_BROWSER;
  const name = requestedBrowser.toLowerCase();
  const configuration = BROWSERS.get(name);

  if (configuration === undefined) {
    throw new Error(
      `Unsupported E2E browser "${requestedBrowser}". ` +
        `Supported values: ${[...BROWSERS.keys()].join(", ")}`,
    );
  }

  return {
    ...configuration,
    binary: environment.E2E_BROWSER_BINARY || null,
    name,
    source:
      argumentBrowser !== undefined
        ? "--browser"
        : environment.E2E_BROWSER
          ? "E2E_BROWSER"
          : "local default",
  };
}

function truncateUtf8(value, maximumBytes = MAX_TEXT_DIAGNOSTIC_BYTES) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maximumBytes) {
    return value;
  }

  return (
    buffer.subarray(0, maximumBytes).toString("utf8") +
    `\n<!-- truncated after ${maximumBytes} bytes -->\n`
  );
}

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

async function browserMetadata(driver, selection) {
  const capabilities = await driver.getCapabilities();
  return {
    browser: selection.name,
    browserBinary: selection.binary,
    browserName: capabilities.getBrowserName(),
    browserVersion: capabilities.getBrowserVersion(),
    driverVersion: driverVersion(capabilities),
    nodeVersion: process.version,
    platformName: capabilities.getPlatform(),
    selectionSource: selection.source,
    seleniumVersion: await packageVersion(),
  };
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function retainFailureDiagnostics(driver, scenario, error, metadata) {
  const scenarioDirectory = resolve(DIAGNOSTICS_DIRECTORY, scenario);
  await rm(scenarioDirectory, { force: true, recursive: true });
  await mkdir(scenarioDirectory, { recursive: true });

  const diagnosticMetadata = {
    ...metadata,
    error: truncateUtf8(error?.stack || String(error), 32 * 1024),
    gitRevision: gitRevision(),
    scenario,
    timestamp: new Date().toISOString(),
  };

  const capture = async (name, operation) => {
    try {
      await operation();
    } catch (captureError) {
      diagnosticMetadata[`${name}CaptureError`] = String(captureError);
    }
  };

  await capture("screenshot", async () => {
    const screenshot = await driver.takeScreenshot();
    await writeFile(
      resolve(scenarioDirectory, "screenshot.png"),
      screenshot,
      "base64",
    );
  });
  await capture("pageSource", async () => {
    const source = await driver.getPageSource();
    await writeFile(
      resolve(scenarioDirectory, "page-source.html"),
      truncateUtf8(source),
      "utf8",
    );
  });
  await capture("currentUrl", async () => {
    diagnosticMetadata.currentUrl = await driver.getCurrentUrl();
  });
  await capture("title", async () => {
    diagnosticMetadata.title = await driver.getTitle();
  });

  const metadataPath = resolve(scenarioDirectory, "metadata.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify(diagnosticMetadata, null, 2)}\n`,
    "utf8",
  );
  console.error(`Selenium failure diagnostics: ${scenarioDirectory}`);
}

async function buildDriver(selection) {
  const options = new chrome.Options();
  options.addArguments(
    "--disable-dev-shm-usage",
    "--headless=new",
    "--no-sandbox",
    "--window-size=1280,720",
  );
  if (selection.binary !== null) {
    options.setChromeBinaryPath(selection.binary);
  }

  const driver = await new Builder()
    .forBrowser(selection.driverBrowser)
    .setChromeOptions(options)
    .build();
  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: 15_000,
    script: 5_000,
  });
  return driver;
}

export async function runScenario(scenario, scenarioFunction) {
  const selection = resolveBrowserSelection();
  let driver;
  let primaryError;

  try {
    driver = await buildDriver(selection);
    const metadata = await browserMetadata(driver, selection);
    console.log(
      [
        `Selenium ${metadata.seleniumVersion}`,
        `Node ${metadata.nodeVersion}`,
        `${metadata.browserName} ${metadata.browserVersion}`,
        `driver ${metadata.driverVersion}`,
        `selection ${selection.name} (${selection.source})`,
      ].join(" | "),
    );
    await scenarioFunction(driver, selection);
  } catch (error) {
    primaryError = error;
    if (driver !== undefined) {
      const metadata = await browserMetadata(driver, selection).catch(() => ({
        browser: selection.name,
        browserBinary: selection.binary,
        selectionSource: selection.source,
      }));
      await retainFailureDiagnostics(driver, scenario, error, metadata).catch(
        (diagnosticError) => {
          console.error(
            `Could not retain Selenium diagnostics: ${diagnosticError}`,
          );
        },
      );
    }
    throw error;
  } finally {
    if (driver !== undefined) {
      try {
        await driver.quit();
      } catch (quitError) {
        if (primaryError !== undefined) {
          console.error(`Could not quit Selenium browser: ${quitError}`);
        } else {
          throw quitError;
        }
      }
    }
  }
}
