#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIRECTORY, "../../..");
const FIXTURE_LIFECYCLE = resolve(
  PROJECT_ROOT,
  "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
);
const HARNESS = resolve(HARNESS_DIRECTORY, "harness.mjs");
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000;
const FORCE_STOP_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 25;
const SAFE_CMD_TOKEN = /^[A-Za-z0-9_./:=\\-]+$/;

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child) {
  if (exited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolveExit, rejectExit) => {
    const finish = (callback, value) => {
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onError = (error) => finish(rejectExit, error);
    const onExit = (code, signal) =>
      finish(resolveExit, {
        code,
        signal,
      });

    child.once("error", onError);
    child.once("exit", onExit);
  });
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

export function taskkillExitAccepted(exitCode) {
  return exitCode === 0 || exitCode === 128;
}

export async function runTaskkill(
  processId,
  {
    environment = process.env,
    force = false,
    forceStopGraceMilliseconds = FORCE_STOP_GRACE_MS,
    spawnImplementation = spawn,
    timeoutMilliseconds = DEFAULT_TASKKILL_TIMEOUT_MS,
    waitForExitResultWithinImplementation = waitForExitResultWithin,
  } = {},
) {
  const arguments_ = ["/pid", String(processId), "/t"];
  if (force) {
    arguments_.push("/f");
  }
  const taskkill = spawnImplementation("taskkill.exe", arguments_, {
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
  const result = await waitForExitResultWithinImplementation(
    taskkill,
    timeoutMilliseconds,
  );
  if (result === null) {
    // This kill targets only the taskkill helper whose own execution window
    // expired; Cypress and browser descendants remain the outer operation's
    // responsibility.
    taskkill.kill("SIGKILL");
    const reaped = await waitForExitResultWithinImplementation(
      taskkill,
      forceStopGraceMilliseconds,
    );
    if (reaped === null) {
      throw new Error(
        `taskkill.exe for process tree ${processId} did not exit after SIGKILL`,
      );
    }
    return false;
  }
  return taskkillExitAccepted(result.code);
}

async function stopWindowsProcessTree(
  child,
  force,
  graceMilliseconds,
  environment,
  runTaskkillImplementation,
  taskkillTimeoutMilliseconds,
  waitForExitWithinImplementation,
) {
  if (child.pid === undefined) {
    return true;
  }

  const accepted = await runTaskkillImplementation(child.pid, {
    environment,
    force,
    timeoutMilliseconds: taskkillTimeoutMilliseconds,
  });
  if (!accepted) {
    return false;
  }
  return waitForExitWithinImplementation(child, graceMilliseconds);
}

async function stopPosixProcessTree(child, signal, graceMilliseconds) {
  if (child.pid === undefined) {
    return;
  }

  const processGroupId = child.pid;
  const directChildExit = waitForExit(child);
  if (!processGroupHasLiveMembers(processGroupId)) {
    await directChildExit;
    return;
  }

  signalProcessGroup(processGroupId, signal);
  const stopped = await waitForProcessGroupExit(
    processGroupId,
    graceMilliseconds,
  );
  if (!stopped) {
    signalProcessGroup(processGroupId, "SIGKILL");
    const forced = await waitForProcessGroupExit(
      processGroupId,
      Math.min(graceMilliseconds, FORCE_STOP_GRACE_MS),
    );
    if (!forced) {
      throw new Error(
        `Process group ${processGroupId} still has live descendants after SIGKILL`,
      );
    }
  }
  await directChildExit;
}

export async function terminateProcessTree(
  child,
  {
    environment = process.env,
    platform = process.platform,
    runTaskkillImplementation = runTaskkill,
    signal = "SIGTERM",
    taskkillTimeoutMilliseconds = DEFAULT_TASKKILL_TIMEOUT_MS,
    timeoutMilliseconds = DEFAULT_STOP_GRACE_MS,
    waitForExitWithinImplementation = waitForExitWithin,
  } = {},
) {
  if (child.pid === undefined) {
    return;
  }

  if (platform === "win32") {
    const stopped = await stopWindowsProcessTree(
      child,
      false,
      timeoutMilliseconds,
      environment,
      runTaskkillImplementation,
      taskkillTimeoutMilliseconds,
      waitForExitWithinImplementation,
    );
    if (!stopped) {
      const forced = await stopWindowsProcessTree(
        child,
        true,
        Math.min(timeoutMilliseconds, FORCE_STOP_GRACE_MS),
        environment,
        runTaskkillImplementation,
        taskkillTimeoutMilliseconds,
        waitForExitWithinImplementation,
      );
      if (!forced) {
        throw new Error(
          `Process tree ${child.pid} did not exit after forced taskkill`,
        );
      }
    }
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
    terminateProcessTreeImplementation = terminateProcessTree,
    timeoutMilliseconds = DEFAULT_STOP_GRACE_MS,
  } = {},
) {
  const child = spawn(command, arguments_, {
    cwd,
    detached: platform !== "win32",
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  let termination;
  let terminationError;

  const requestTermination = (signal) => {
    if (termination === undefined) {
      termination = terminateProcessTreeImplementation(child, {
        environment,
        platform,
        signal,
        timeoutMilliseconds,
      }).catch((error) => {
        terminationError = error;
      });
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

  let result;
  try {
    result = await waitForExit(child);
    if (termination !== undefined) {
      await termination;
    } else if (
      child.pid !== undefined &&
      (platform === "win32" || processGroupHasLiveMembers(child.pid))
    ) {
      await terminateProcessTreeImplementation(child, {
        environment,
        platform,
        timeoutMilliseconds,
      });
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    abortSignal?.removeEventListener("abort", onAbort);
  }
  if (terminationError !== undefined) {
    throw terminationError;
  }
  if (result.signal !== null) {
    throw new Error(`${command} terminated with signal ${result.signal}`);
  }
  if (result.code !== 0) {
    throw new Error(`${command} exited with status ${result.code}`);
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
