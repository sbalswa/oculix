import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const DEFAULT_STOP_GRACE_MS = 5_000;
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
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return true;
}

function waitForExitWithin(child, timeoutMs) {
  if (exited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolveStopped, rejectStopped) => {
    const timeout = setTimeout(() => finish(resolveStopped, false), timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onError = (error) => finish(rejectStopped, error);
    const onExit = () => finish(resolveStopped, true);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function runTaskkill(processId, force) {
  const arguments_ = ["/pid", String(processId), "/t"];
  if (force) {
    arguments_.push("/f");
  }

  const taskkill = spawn("taskkill.exe", arguments_, {
    stdio: "ignore",
    windowsHide: true,
  });
  const result = await waitForExit(taskkill);
  return result.code === 0 || result.code === 128;
}

async function stopWindowsProcessTree(
  child,
  force,
  graceMs,
  runTaskkillImplementation,
  waitForExitWithinImplementation,
) {
  if (child.pid === undefined || exited(child)) {
    return true;
  }

  try {
    const accepted = await runTaskkillImplementation(child.pid, force);
    if (accepted === false) {
      if (!force) {
        return false;
      }
      child.kill("SIGKILL");
    }
  } catch (error) {
    if (!exited(child)) {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return waitForExitWithinImplementation(child, graceMs);
}

async function stopPosixProcessTree(child, signal, graceMs) {
  if (child.pid === undefined) {
    return;
  }

  const directChildExit = waitForExit(child);
  signalProcessGroup(child.pid, signal);
  const stopped = await waitForProcessGroupExit(child.pid, graceMs);
  if (!stopped) {
    signalProcessGroup(child.pid, "SIGKILL");
    await waitForProcessGroupExit(
      child.pid,
      Math.min(graceMs, FORCE_STOP_GRACE_MS),
    );
  }
  await directChildExit;
}

export async function stopProcessTree(
  child,
  {
    platform = process.platform,
    signal = "SIGTERM",
    graceMs = DEFAULT_STOP_GRACE_MS,
    runTaskkillImplementation = runTaskkill,
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
      graceMs,
      runTaskkillImplementation,
      waitForExitWithinImplementation,
    );
    if (!stopped) {
      const forced = await stopWindowsProcessTree(
        child,
        true,
        Math.min(graceMs, FORCE_STOP_GRACE_MS),
        runTaskkillImplementation,
        waitForExitWithinImplementation,
      );
      if (!forced) {
        throw new Error(
          `Process tree ${child.pid} did not exit after forced taskkill.`,
        );
      }
    }
    return;
  }
  await stopPosixProcessTree(child, signal, graceMs);
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
  { platform = process.platform, environment = process.env } = {},
) {
  if (platform !== "win32") {
    return {
      command: "npm",
      arguments_,
    };
  }

  const commandProcessor = environment.ComSpec || "cmd.exe";
  const commandLine = ["npm.cmd", ...arguments_].map(safeCmdToken).join(" ");
  return {
    command: commandProcessor,
    arguments_: ["/d", "/s", "/c", commandLine],
  };
}

export function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

export class ProcessStoppedError extends Error {
  constructor(command, reason) {
    const description =
      reason.kind === "signal"
        ? `received ${reason.signal}`
        : `timed out after ${reason.timeoutMs}ms`;
    super(`${command} stopped because the harness ${description}`);
    this.name = "ProcessStoppedError";
    this.reason = reason;
  }
}

export async function runProcess(
  command,
  arguments_,
  {
    cwd,
    env,
    stdio = "inherit",
    timeoutMs,
    platform = process.platform,
  } = {},
) {
  const child = spawn(command, arguments_, {
    cwd,
    detached: platform !== "win32",
    env,
    stdio,
    windowsHide: true,
  });
  let reason = null;
  let stopPromise = null;

  const requestStop = (nextReason) => {
    reason ??= nextReason;
    stopPromise ??= stopProcessTree(child, {
      platform,
      signal: nextReason.signal ?? "SIGTERM",
    });
  };
  const onSigint = () =>
    requestStop({
      kind: "signal",
      signal: "SIGINT",
    });
  const onSigterm = () =>
    requestStop({
      kind: "signal",
      signal: "SIGTERM",
    });
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(
          () =>
            requestStop({
              kind: "timeout",
              timeoutMs,
            }),
          timeoutMs,
        );
  timeout?.unref?.();

  try {
    const result = await waitForExit(child);
    if (stopPromise !== null) {
      await stopPromise;
    } else if (
      platform !== "win32" &&
      child.pid !== undefined &&
      processGroupExists(child.pid)
    ) {
      await stopProcessTree(child, {
        platform,
      });
    }
    if (reason !== null) {
      throw new ProcessStoppedError(command, reason);
    }
    if (result.code !== 0) {
      throw new Error(
        `${command} exited with ${
          result.signal === null
            ? `code ${result.code}`
            : `signal ${result.signal}`
        }`,
      );
    }
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
