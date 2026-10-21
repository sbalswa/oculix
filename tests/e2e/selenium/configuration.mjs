import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_BROWSER = "chrome";
const HOST_OS = new Map([
  ["darwin", "macos"],
  ["linux", "linux"],
  ["win32", "windows"],
]);
const OS_PLATFORMS = new Map([
  ["linux", "linux"],
  ["macos", "darwin"],
  ["ubuntu", "linux"],
  ["windows", "win32"],
]);
const SUPPORTED_BROWSERS = new Set(["chrome", "chromium"]);

function assignOnce(currentValue, nextValue, option) {
  if (currentValue !== undefined) {
    throw new Error(`${option} may only be provided once`);
  }
  return nextValue;
}

function parseArguments(arguments_) {
  let browser;
  let os;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browser" || argument === "--os") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--browser") {
        browser = assignOnce(browser, value, "--browser");
      } else {
        os = assignOnce(os, value, "--os");
      }
      index += 1;
    } else if (argument.startsWith("--browser=")) {
      browser = assignOnce(
        browser,
        argument.slice("--browser=".length),
        "--browser",
      );
    } else if (argument.startsWith("--os=")) {
      os = assignOnce(os, argument.slice("--os=".length), "--os");
    } else {
      throw new Error(
        `Unknown argument: ${argument}\n` +
          "Usage: [--browser chrome|chromium] " +
          "[--os ubuntu|linux|windows|macos]",
      );
    }
  }

  return { browser, os };
}

function parseBoolean(value, name) {
  if (value === undefined) {
    return false;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new Error(`${name} must be one of: 0, 1, false, true`);
}

function resolveOptionalPath(value) {
  return value ? resolve(value) : null;
}

export function detectLinuxDistribution(platform) {
  if (platform !== "linux") {
    return null;
  }
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const match = osRelease.match(/^ID=(?:"([^"]+)"|([^\s]+))$/m);
    return match?.[1] ?? match?.[2] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveCapability({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  linuxDistribution = detectLinuxDistribution(platform),
} = {}) {
  const parsed = parseArguments(arguments_);
  const browserValue =
    parsed.browser ?? environment.E2E_BROWSER ?? DEFAULT_BROWSER;
  const browser = browserValue.toLowerCase();
  if (!SUPPORTED_BROWSERS.has(browser)) {
    throw new Error(
      `Unsupported E2E browser "${browserValue}". ` +
        `Supported values: ${[...SUPPORTED_BROWSERS].join(", ")}`,
    );
  }

  const defaultOs = HOST_OS.get(platform);
  if (defaultOs === undefined) {
    throw new Error(`Unsupported host platform "${platform}"`);
  }
  const osValue = parsed.os ?? environment.E2E_OS ?? defaultOs;
  const os = osValue.toLowerCase();
  const expectedPlatform = OS_PLATFORMS.get(os);
  if (expectedPlatform === undefined) {
    throw new Error(
      `Unsupported E2E OS "${osValue}". ` +
        `Supported values: ${[...OS_PLATFORMS.keys()].join(", ")}`,
    );
  }
  if (expectedPlatform !== platform) {
    throw new Error(
      `E2E_OS "${os}" requires host platform "${expectedPlatform}", ` +
        `but this host reports "${platform}"`,
    );
  }
  if (os === "ubuntu" && linuxDistribution !== "ubuntu") {
    throw new Error(
      `E2E_OS "ubuntu" requires an Ubuntu host, but /etc/os-release ` +
        `reports "${linuxDistribution}"`,
    );
  }

  return {
    browser,
    browserBinary: resolveOptionalPath(environment.E2E_BROWSER_BINARY),
    browserSource:
      parsed.browser !== undefined
        ? "--browser"
        : environment.E2E_BROWSER !== undefined
          ? "E2E_BROWSER"
          : "local default",
    cachePath: resolveOptionalPath(environment.E2E_SELENIUM_CACHE),
    downloadsAllowed: parseBoolean(
      environment.E2E_SELENIUM_ALLOW_DOWNLOADS,
      "E2E_SELENIUM_ALLOW_DOWNLOADS",
    ),
    driverBinary: resolveOptionalPath(environment.E2E_DRIVER_BINARY),
    hostDistribution: linuxDistribution,
    hostPlatform: platform,
    managerBinary: resolveOptionalPath(
      environment.E2E_SELENIUM_MANAGER_BINARY,
    ),
    os,
    osSource:
      parsed.os !== undefined
        ? "--os"
        : environment.E2E_OS !== undefined
          ? "E2E_OS"
          : "host default",
  };
}

export function capabilityId(capability) {
  return `${capability.os}-${capability.browser}`;
}
