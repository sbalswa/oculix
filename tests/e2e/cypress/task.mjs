#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCypressPlatformSupported } from "./platform.mjs";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIRECTORY, "../../..");
const FIXTURE_LIFECYCLE = resolve(
  PROJECT_ROOT,
  "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
);
const HARNESS = resolve(HARNESS_DIRECTORY, "harness.mjs");
const DEFAULT_STOP_GRACE_MS = 5_000;
const FORCE_STOP_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 25;
const SAFE_CMD_TOKEN = /^[A-Za-z0-9_./:=\\-]+$/;

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function observeExit(child) {
  if (exited(child)) {
    return {
      dispose() {},
      promise: Promise.resolve({
        code: child.exitCode,
        signal: child.signalCode,
      }),
    };
  }

  let disposed = false;
  let onError;
  let onExit;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    child.off("error", onError);
    child.off("exit", onExit);
  };
  const promise = new Promise((resolveExit, rejectExit) => {
    const finish = (callback, value) => {
      dispose();
      callback(value);
    };
    onError = (error) => finish(rejectExit, error);
    onExit = (code, signal) =>
      finish(resolveExit, {
        code,
        signal,
      });

    child.once("error", onError);
    child.once("exit", onExit);
  });
  return {
    dispose,
    promise,
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function processGroupHasLiveMembers(processGroupId) {
  if (!processGroupExists(processGroupId)) {
    return false;
  }

  const processes = spawnSync("ps", ["-Ao", "pgid=,stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (processes.status !== 0) {
    return true;
  }

  let foundMember = false;
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    if (match === null || Number(match[1]) !== processGroupId) {
      continue;
    }
    foundMember = true;
    if (!match[2].startsWith("Z")) {
      return true;
    }
  }
  return foundMember ? false : processGroupExists(processGroupId);
}

async function waitForProcessGroupExit(processGroupId, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupHasLiveMembers(processGroupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return true;
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function waitForExitResultWithin(child, timeoutMilliseconds) {
  if (exited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(
      () => finish(resolveResult, null),
      timeoutMilliseconds,
    );
    const finish = (callback, value) => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onError = (error) => finish(rejectResult, error);
    const onExit = (code, signal) =>
      finish(resolveResult, {
        code,
        signal,
      });

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExitWithin(child, timeoutMilliseconds) {
  return (
    (await waitForExitResultWithin(child, timeoutMilliseconds)) !== null
  );
}

export class CleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = "CleanupError";
  }
}

export class ProcessStoppedError extends Error {
  constructor(command, signal) {
    super(`${command} stopped after the harness received ${signal}`);
    this.name = "ProcessStoppedError";
    this.signal = signal;
  }
}

export function assertCypressTaskPlatformSupported({
  platform = process.platform,
} = {}) {
  assertCypressPlatformSupported({ platform });
}

async function stopPosixProcessTree(child, signal, graceMilliseconds) {
  if (child.pid === undefined) {
    return;
  }

  const processGroupId = child.pid;
  if (!processGroupHasLiveMembers(processGroupId) && exited(child)) {
    return;
  }

  signalProcessGroup(processGroupId, signal);
  const [groupStopped, directChildStopped] = await Promise.all([
    waitForProcessGroupExit(processGroupId, graceMilliseconds),
    waitForExitWithin(child, graceMilliseconds),
  ]);
  if (groupStopped && directChildStopped) {
    return;
  }

  signalProcessGroup(processGroupId, "SIGKILL");
  const forceGraceMilliseconds = Math.min(
    graceMilliseconds,
    FORCE_STOP_GRACE_MS,
  );
  const [groupForced, directChildForced] = await Promise.all([
    waitForProcessGroupExit(processGroupId, forceGraceMilliseconds),
    waitForExitWithin(child, forceGraceMilliseconds),
  ]);
  if (!groupForced) {
    throw new CleanupError(
      `POSIX process group ${processGroupId} still has live descendants ` +
        `after SIGKILL`,
    );
  }
  if (!directChildForced) {
    throw new CleanupError(
      `Direct child ${processGroupId} did not exit after SIGKILL`,
    );
  }
}

export async function terminateProcessTree(
  child,
  {
    platform = process.platform,
    signal = "SIGTERM",
    timeoutMilliseconds = DEFAULT_STOP_GRACE_MS,
  } = {},
) {
  assertCypressTaskPlatformSupported({ platform });
  if (child.pid === undefined) {
    return;
  }
  await stopPosixProcessTree(child, signal, timeoutMilliseconds);
}

function safeCmdToken(value) {
  if (!SAFE_CMD_TOKEN.test(value)) {
    throw new Error(
      `Unsafe Windows command token ${JSON.stringify(value)}; ` +
        "npm arguments must not require cmd.exe quoting.",
    );
  }
  return value;
}

export function npmInvocation(
  arguments_,
  { environment = process.env, platform = process.platform } = {},
) {
  if (platform !== "win32") {
    return {
      arguments_,
      command: "npm",
    };
  }

  const commandProcessor =
    environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe";
  const commandLine = ["npm.cmd", ...arguments_]
    .map(safeCmdToken)
    .join(" ");
  return {
    arguments_: ["/d", "/s", "/c", commandLine],
    command: commandProcessor,
  };
}

export async function runCommand(
  command,
  arguments_,
  {
    abortSignal,
    cwd = PROJECT_ROOT,
    environment = process.env,
    platform = process.platform,
    spawnImplementation = spawn,
    terminateProcessTreeImplementation = terminateProcessTree,
    timeoutMilliseconds = DEFAULT_STOP_GRACE_MS,
  } = {},
) {
  assertCypressTaskPlatformSupported({ platform });
  const child = spawnImplementation(command, arguments_, {
    cwd,
    detached: true,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitObserver = observeExit(child);
  let resolveStopRequested;
  let cleanupPromise;
  let stopSignal;
  let stopPromise;
  const stopRequested = new Promise((resolveStop) => {
    resolveStopRequested = resolveStop;
  });
  const performCleanup = (signal) =>
    terminateProcessTreeImplementation(child, {
      environment,
      platform,
      signal,
      timeoutMilliseconds,
    });
  const startCleanup = (signal = "SIGTERM") => {
    cleanupPromise ??= performCleanup(signal);
    return cleanupPromise;
  };
  const requestTermination = (signal) => {
    if (stopPromise === undefined) {
      stopSignal = signal;
      stopPromise = startCleanup(signal);
      resolveStopRequested();
    }
  };
  const onSigint = () => requestTermination("SIGINT");
  const onSigterm = () => requestTermination("SIGTERM");
  const onAbort = () => requestTermination("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (abortSignal?.aborted) {
    onAbort();
  }

  try {
    const outcome = await Promise.race([
      exitObserver.promise.then((result) => ({
        kind: "exit",
        result,
      })),
      stopRequested.then(() => ({
        kind: "stop",
      })),
    ]);
    if (outcome.kind === "stop" || stopPromise !== undefined) {
      await stopPromise;
      throw new ProcessStoppedError(command, stopSignal);
    }

    if (
      child.pid !== undefined &&
      processGroupHasLiveMembers(child.pid)
    ) {
      await startCleanup();
    }
    if (stopPromise !== undefined) {
      await stopPromise;
      throw new ProcessStoppedError(command, stopSignal);
    }
    if (outcome.result.signal !== null) {
      throw new Error(
        `${command} terminated with signal ${outcome.result.signal}`,
      );
    }
    if (outcome.result.code !== 0) {
      throw new Error(
        `${command} exited with status ${outcome.result.code}`,
      );
    }
  } finally {
    exitObserver.dispose();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function installDependencies() {
  const invocation = npmInvocation(["ci"]);
  await runCommand(invocation.command, invocation.arguments_, {
    cwd: HARNESS_DIRECTORY,
  });
}

async function runScenario(scenario, options) {
  if (scenario === "web-calculator") {
    await runCommand(process.execPath, [
      FIXTURE_LIFECYCLE,
      process.execPath,
      HARNESS,
      scenario,
      ...options,
    ]);
    return;
  }
  await runCommand(process.execPath, [HARNESS, scenario, ...options]);
}

async function run() {
  assertCypressTaskPlatformSupported();
  const [task, ...options] = process.argv.slice(2);
  if (!["all", "smoke", "web-calculator"].includes(task)) {
    throw new Error(
      "Usage: task.mjs all|smoke|web-calculator [--browser BROWSER]",
    );
  }

  await installDependencies();
  if (task === "all") {
    await runScenario("smoke", options);
    await runScenario("web-calculator", options);
  } else {
    await runScenario(task, options);
  }
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
