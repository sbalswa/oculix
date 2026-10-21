import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { arch } from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  capabilityId,
  detectLinuxDistribution,
  resolveCapability,
} from "./configuration.mjs";
import { writeFailureDiagnostics } from "./diagnostics.mjs";
import {
  DIAGNOSTICS_DIRECTORY,
  RUNTIME_DIRECTORY,
  runtimeStatePath,
} from "./runtime.mjs";

const require = createRequire(import.meta.url);
const MAX_MANAGER_OUTPUT_BYTES = 1024 * 1024;

function argumentValue(option) {
  const arguments_ = process.argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === option) {
      return arguments_[index + 1] ?? null;
    }
    if (arguments_[index].startsWith(`${option}=`)) {
      return arguments_[index].slice(option.length + 1);
    }
  }
  return null;
}

function bundledManagerPath(platform) {
  const packageDirectory = dirname(
    require.resolve("selenium-webdriver/package.json"),
  );
  const directory = {
    darwin: "macos",
    linux: arch === "arm64" ? "linux-arm64" : "linux-x86_64",
    win32: "windows",
  }[platform];
  if (directory === undefined) {
    throw new Error(`Selenium Manager is unavailable for "${platform}"`);
  }
  const executable =
    directory === "windows" ? "selenium-manager.exe" : "selenium-manager";
  return resolve(packageDirectory, "bin", directory, executable);
}

async function requireExecutable(path, label, platform) {
  const mode =
    platform === "win32"
      ? fsConstants.F_OK
      : fsConstants.F_OK | fsConstants.X_OK;
  try {
    await access(path, mode);
  } catch (error) {
    throw new Error(`${label} is not an executable file: ${path}`, {
      cause: error,
    });
  }
}

async function executablePath(path, platform) {
  if (!path) {
    return null;
  }
  const mode =
    platform === "win32"
      ? fsConstants.F_OK
      : fsConstants.F_OK | fsConstants.X_OK;
  try {
    await access(path, mode);
    return await realpath(path);
  } catch {
    return null;
  }
}

async function findOnPath(name, platform) {
  const pathDirectories = (process.env.PATH ?? "").split(delimiter);
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const directory of pathDirectories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      const found = await executablePath(candidate, platform);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

async function firstExecutable(candidates, platform) {
  for (const candidate of candidates) {
    const found = isAbsolute(candidate)
      ? await executablePath(candidate, platform)
      : await findOnPath(candidate, platform);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

async function discoverBrowser(capability) {
  const candidates = {
    chrome: {
      darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "google-chrome",
      ],
      linux: [
        "google-chrome",
        "google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
      ],
      win32: ["chrome"],
    },
    chromium: {
      linux: [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "chromium",
        "chromium-browser",
      ],
    },
  }[capability.browser]?.[capability.hostPlatform];

  return candidates
    ? firstExecutable(candidates, capability.hostPlatform)
    : null;
}

async function discoverDriver(capability) {
  return findOnPath("chromedriver", capability.hostPlatform);
}

function managerError(message, result) {
  const error = new Error(message);
  error.managerStatus = result.status;
  error.managerStdout = result.stdout || "";
  error.managerStderr = result.stderr || "";
  return error;
}

function parseManagerOutput(result, managerPath) {
  if (result.error !== undefined) {
    throw managerError(
      `Could not execute Selenium Manager at ${managerPath}: ${result.error}`,
      result,
    );
  }
  if (result.status !== 0) {
    throw managerError(
      `Selenium Manager exited with status ${result.status}`,
      result,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw managerError(
      `Selenium Manager returned invalid JSON: ${error}`,
      result,
    );
  }
}

async function runManager(capability, logPaths) {
  const managerPath =
    capability.managerBinary ?? bundledManagerPath(capability.hostPlatform);
  await requireExecutable(
    managerPath,
    "Selenium Manager",
    capability.hostPlatform,
  );

  const arguments_ = [
    "--browser",
    "chrome",
    "--language-binding",
    "javascript",
    "--output",
    "json",
    "--avoid-stats",
  ];
  if (!capability.downloadsAllowed) {
    arguments_.push("--offline");
  }
  if (capability.browserBinary !== null) {
    arguments_.push("--browser-path", capability.browserBinary);
  }
  if (capability.cachePath !== null) {
    arguments_.push("--cache-path", capability.cachePath);
  }

  console.log(
    capability.downloadsAllowed
      ? "Selenium setup network policy: downloads explicitly enabled; " +
          "Selenium Manager may query vendor metadata and populate its cache."
      : "Selenium setup network policy: offline; only explicit paths, PATH, " +
          "and the existing Selenium cache may be used.",
  );

  const result = spawnSync(managerPath, arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_MANAGER_OUTPUT_BYTES,
  });
  await writeFile(logPaths.managerStdout, result.stdout || "", "utf8");
  await writeFile(logPaths.managerStderr, result.stderr || "", "utf8");
  const output = parseManagerOutput(result, managerPath);

  return {
    browserBinary: capability.browserBinary ?? output.result?.browser_path,
    driverBinary: capability.driverBinary ?? output.result?.driver_path,
    managerPath,
  };
}

export async function resolveResources(
  capability,
  {
    findBrowser = discoverBrowser,
    findDriver = discoverDriver,
    invokeManager = runManager,
    logPaths,
  } = {},
) {
  const browserBinary =
    capability.browserBinary ?? (await findBrowser(capability));
  const driverBinary =
    capability.driverBinary ?? (await findDriver(capability));

  if (capability.browser === "chromium") {
    if (browserBinary === null) {
      throw new Error(
        'E2E_BROWSER="chromium" requires E2E_BROWSER_BINARY or a ' +
          "deterministic Chromium executable mapping for this OS.",
      );
    }
    if (driverBinary === null) {
      throw new Error(
        'E2E_BROWSER="chromium" requires E2E_DRIVER_BINARY or a ' +
          "provisioned chromedriver on PATH; Selenium Manager fallback is " +
          "disabled to preserve browser identity.",
      );
    }
    return {
      browserBinary,
      driverBinary,
      managerPath: null,
      provisioner: "resolved-paths",
    };
  }

  if (browserBinary !== null && driverBinary !== null) {
    return {
      browserBinary,
      driverBinary,
      managerPath: null,
      provisioner:
        capability.browserBinary !== null &&
        capability.driverBinary !== null
          ? "explicit-paths"
          : "resolved-paths",
    };
  }

  const managed = await invokeManager(
    {
      ...capability,
      browserBinary,
      driverBinary,
    },
    logPaths,
  );
  return {
    ...managed,
    provisioner: "manager",
  };
}

export async function provisionCapability(capability) {
  const setupLogDirectory = resolve(RUNTIME_DIRECTORY, "logs", "setup");
  await rm(setupLogDirectory, { force: true, recursive: true });
  await mkdir(setupLogDirectory, { recursive: true });
  const logPaths = {
    managerStderr: resolve(setupLogDirectory, "manager-stderr.log"),
    managerStdout: resolve(setupLogDirectory, "manager-stdout.log"),
  };

  const resources = await resolveResources(capability, { logPaths });
  if (resources.managerPath === null) {
    console.log(
      "Selenium setup network policy: no manager invocation; using " +
        `${resources.provisioner}.`,
    );
  }

  if (!resources.browserBinary) {
    throw new Error(
      "Selenium setup did not resolve a browser executable. Install Chrome " +
        "or set E2E_BROWSER_BINARY.",
    );
  }
  if (!resources.driverBinary) {
    throw new Error(
      "Selenium setup did not resolve a driver executable. Install " +
        "ChromeDriver or set E2E_DRIVER_BINARY.",
    );
  }
  await requireExecutable(
    resources.browserBinary,
    `${capability.browser} browser`,
    capability.hostPlatform,
  );
  await requireExecutable(
    resources.driverBinary,
    "ChromeDriver",
    capability.hostPlatform,
  );

  const state = {
    browser: capability.browser,
    browserBinary: resources.browserBinary,
    browserSource: capability.browserSource,
    downloadsAllowed: capability.downloadsAllowed,
    driverBinary: resources.driverBinary,
    hostDistribution: capability.hostDistribution,
    hostPlatform: capability.hostPlatform,
    managerBinary: resources.managerPath,
    os: capability.os,
    osSource: capability.osSource,
    provisionedAt: new Date().toISOString(),
    provisioner: resources.provisioner,
    schemaVersion: 1,
  };

  await mkdir(RUNTIME_DIRECTORY, { recursive: true });
  const statePath = runtimeStatePath(capability);
  const temporaryStatePath = `${statePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryStatePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryStatePath, statePath);
  await rm(setupLogDirectory, { force: true, recursive: true });

  console.log(
    `Selenium resources ready for ${capabilityId(capability)}: ` +
      `browser=${state.browserBinary} driver=${state.driverBinary}`,
  );
  return state;
}

async function runCli() {
  let capability;
  try {
    capability = resolveCapability();
    await provisionCapability(capability);
  } catch (error) {
    const setupLogDirectory = resolve(RUNTIME_DIRECTORY, "logs", "setup");
    const managerStdoutPath = resolve(
      setupLogDirectory,
      "manager-stdout.log",
    );
    const managerStderrPath = resolve(
      setupLogDirectory,
      "manager-stderr.log",
    );
    if (error.managerStdout !== undefined) {
      await mkdir(setupLogDirectory, { recursive: true });
      await writeFile(managerStdoutPath, error.managerStdout, "utf8");
      await writeFile(managerStderrPath, error.managerStderr, "utf8");
    }
    await writeFailureDiagnostics({
      diagnosticsDirectory: DIAGNOSTICS_DIRECTORY,
      error,
      logPaths: {
        "manager-stderr": managerStderrPath,
        "manager-stdout": managerStdoutPath,
      },
      metadata: {
        arguments: process.argv.slice(2),
        browser:
          capability?.browser ??
          argumentValue("--browser") ??
          process.env.E2E_BROWSER ??
          "chrome",
        hostDistribution:
          capability?.hostDistribution ??
          detectLinuxDistribution(process.platform),
        hostPlatform: process.platform,
        os:
          capability?.os ??
          argumentValue("--os") ??
          process.env.E2E_OS ??
          null,
        phase: "setup",
      },
      scenario: "setup",
    });
    throw error;
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
