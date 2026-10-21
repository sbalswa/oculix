import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const DEFAULT_STOP_GRACE_MS = 5_000;
const FORCE_STOP_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 25;

export const WINDOWS_UNSUPPORTED_MESSAGE =
  "Playwright E2E is unsupported on Windows until #15 adds native hosted " +
  "validation; no child process was started.";

export function assertSupportedPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new Error(WINDOWS_UNSUPPORTED_MESSAGE);
  }
}

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

export class CleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = "CleanupError";
  }
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

export async function stopProcessTree(
  child,
  {
    platform = process.platform,
    signal = "SIGTERM",
    graceMs = DEFAULT_STOP_GRACE_MS,
    signalProcessGroupImplementation = signalProcessGroup,
    waitForExitWithinImplementation = waitForExitWithin,
    waitForProcessGroupExitImplementation = waitForProcessGroupExit,
  } = {},
) {
  assertSupportedPlatform(platform);
  if (child.pid === undefined) {
    return;
  }

  signalProcessGroupImplementation(child.pid, signal);
  const [groupStopped, directChildStopped] = await Promise.all([
    waitForProcessGroupExitImplementation(child.pid, graceMs),
    waitForExitWithinImplementation(child, graceMs),
  ]);
  if (groupStopped && directChildStopped) {
    return;
  }

  signalProcessGroupImplementation(child.pid, "SIGKILL");
  const forceGraceMs = Math.min(graceMs, FORCE_STOP_GRACE_MS);
  const [groupForced, directChildForced] = await Promise.all([
    waitForProcessGroupExitImplementation(child.pid, forceGraceMs),
    waitForExitWithinImplementation(child, forceGraceMs),
  ]);
  if (!groupForced) {
    throw new CleanupError(
      `POSIX process group ${child.pid} still exists after SIGKILL.`,
    );
  }
  if (!directChildForced) {
    throw new CleanupError(
      `Direct child ${child.pid} did not exit after SIGKILL.`,
    );
  }
}

export function npmInvocation(
  arguments_,
  { platform = process.platform } = {},
) {
  assertSupportedPlatform(platform);
  return {
    command: "npm",
    arguments_,
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
    spawnImplementation = spawn,
    stdio = "inherit",
    stopProcessTreeImplementation = stopProcessTree,
    timeoutMs,
    platform = process.platform,
  } = {},
) {
  assertSupportedPlatform(platform);
  const child = spawnImplementation(command, arguments_, {
    cwd,
    detached: true,
    env,
    stdio,
  });
  const exitObserver = observeExit(child);
  let reason = null;
  let resolveStopRequested;
  let stopPromise = null;
  const stopRequested = new Promise((resolveStop) => {
    resolveStopRequested = resolveStop;
  });

  const requestStop = (nextReason) => {
    reason ??= nextReason;
    stopPromise ??= stopProcessTreeImplementation(child, {
      platform,
      signal: nextReason.signal ?? "SIGTERM",
    });
    resolveStopRequested();
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
    const outcome = await Promise.race([
      exitObserver.promise.then((result) => ({
        kind: "exit",
        result,
      })),
      stopRequested.then(() => ({
        kind: "stop",
      })),
    ]);
    if (outcome.kind === "stop") {
      await stopPromise;
      throw new ProcessStoppedError(command, reason);
    }

    if (child.pid !== undefined && processGroupExists(child.pid)) {
      await stopProcessTreeImplementation(child, {
        platform,
      });
    }
    if (outcome.result.code !== 0) {
      throw new Error(
        `${command} exited with ${
          outcome.result.signal === null
            ? `code ${outcome.result.code}`
            : `signal ${outcome.result.signal}`
        }`,
      );
    }
  } finally {
    exitObserver.dispose();
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
