import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const DEFAULT_STOP_GRACE_MS = 5_000;
const FORCE_STOP_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 25;
const SAFE_CMD_TOKEN = /^[A-Za-z0-9_./:=\\-]+$/;
const UTILITY_TIMEOUT_MS = 5_000;
const WINDOWS_PROBE_INTERVAL_MS = 250;
const WINDOWS_PROCESS_QUERY =
  "$ErrorActionPreference = 'Stop'; " +
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  "[Console]::Out.WriteLine(('{0},{1}' -f " +
  "$_.ProcessId, $_.ParentProcessId)) }";

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

export async function runTaskkill(
  processId,
  force,
  {
    forceWaitMs = FORCE_STOP_GRACE_MS,
    spawnImplementation = spawn,
    timeoutMs = UTILITY_TIMEOUT_MS,
    waitForExitWithinImplementation = waitForExitWithin,
  } = {},
) {
  const arguments_ = ["/pid", String(processId), "/t"];
  if (force) {
    arguments_.push("/f");
  }

  const taskkill = spawnImplementation("taskkill.exe", arguments_, {
    stdio: "ignore",
    windowsHide: true,
  });
  const stopped = await waitForExitWithinImplementation(
    taskkill,
    timeoutMs,
  );
  if (!stopped) {
    taskkill.kill("SIGKILL");
    const forced = await waitForExitWithinImplementation(
      taskkill,
      forceWaitMs,
    );
    if (!forced) {
      throw new CleanupError(
        `taskkill.exe for process tree ${processId} did not exit ` +
          `within ${timeoutMs + forceWaitMs}ms.`,
      );
    }
    throw new CleanupError(
      `taskkill.exe for process tree ${processId} timed out after ` +
        `${timeoutMs}ms.`,
    );
  }
  return taskkill.exitCode === 0 || taskkill.exitCode === 128;
}

async function captureWindowsProcessTable({
  forceWaitMs = FORCE_STOP_GRACE_MS,
  spawnImplementation = spawn,
  timeoutMs = UTILITY_TIMEOUT_MS,
  waitForExitWithinImplementation = waitForExitWithin,
} = {}) {
  const utility = spawnImplementation(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_PROCESS_QUERY,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let errorOutput = "";
  utility.stdout.setEncoding("utf8");
  utility.stderr.setEncoding("utf8");
  utility.stdout.on("data", (chunk) => {
    output += chunk;
  });
  utility.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });

  const stopped = await waitForExitWithinImplementation(utility, timeoutMs);
  if (!stopped) {
    utility.kill("SIGKILL");
    const forced = await waitForExitWithinImplementation(
      utility,
      forceWaitMs,
    );
    if (!forced) {
      throw new CleanupError(
        `Windows process-tree probe did not exit within ` +
          `${timeoutMs + forceWaitMs}ms.`,
      );
    }
    throw new CleanupError(
      `Windows process-tree probe timed out after ${timeoutMs}ms.`,
    );
  }
  if (utility.exitCode !== 0) {
    throw new CleanupError(
      `Windows process-tree probe exited with code ${utility.exitCode}: ` +
        `${errorOutput.trim() || "no diagnostic output"}`,
    );
  }

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [processId, parentProcessId, ...extra] = line.split(",");
      if (
        extra.length !== 0 ||
        !/^\d+$/.test(processId) ||
        !/^\d+$/.test(parentProcessId)
      ) {
        throw new CleanupError(
          `Unexpected Windows process-tree probe output: ${line}`,
        );
      }
      return {
        parentProcessId: Number(parentProcessId),
        processId: Number(processId),
      };
    });
}

async function probeWindowsDescendants(
  rootProcessIds,
  options = {},
) {
  const roots = new Set(rootProcessIds);
  const descendants = new Set();
  const processes = await captureWindowsProcessTable(options);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (
        (roots.has(process.parentProcessId) ||
          descendants.has(process.parentProcessId)) &&
        !roots.has(process.processId) &&
        !descendants.has(process.processId)
      ) {
        descendants.add(process.processId);
        changed = true;
      }
    }
  }
  const activeRoots = processes
    .map((process) => process.processId)
    .filter((processId) => roots.has(processId));
  return [...new Set([...activeRoots, ...descendants])];
}

export function createWindowsProcessTracker(
  rootProcessId,
  {
    intervalMs = WINDOWS_PROBE_INTERVAL_MS,
    probeImplementation = probeWindowsDescendants,
  } = {},
) {
  const roots = new Set([rootProcessId]);
  let activeProcessIds = [];
  let failure = null;
  let finishPromise = null;
  let inFlight = Promise.resolve();
  let stopped = false;
  let timer = null;

  const sample = async () => {
    activeProcessIds = await probeImplementation([...roots]);
    for (const processId of activeProcessIds) {
      roots.add(processId);
    }
  };
  const schedule = () => {
    inFlight = sample()
      .catch((error) => {
        failure ??= error;
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(schedule, intervalMs);
          timer.unref?.();
        }
      });
  };
  schedule();

  return {
    finish() {
      finishPromise ??= (async () => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        await inFlight;
        if (failure !== null) {
          throw failure;
        }
        await sample();
        return activeProcessIds;
      })();
      return finishPromise;
    },
  };
}

async function stopWindowsProcessTree(
  child,
  ownedProcessIds,
  graceMs,
  runTaskkillImplementation,
  waitForExitWithinImplementation,
) {
  if (child.pid === undefined) {
    return;
  }

  const directChildAlreadyExited = exited(child);
  let accepted;
  try {
    accepted = await runTaskkillImplementation(child.pid, false);
  } catch (error) {
    if (!directChildAlreadyExited) {
      child.kill("SIGKILL");
      const stopped = await waitForExitWithinImplementation(
        child,
        Math.min(graceMs, FORCE_STOP_GRACE_MS),
      );
      if (!stopped) {
        throw new CleanupError(
          `Windows process tree ${child.pid} and its taskkill utility ` +
            `both missed their forced deadlines.`,
        );
      }
    }
    throw error;
  }
  if (!directChildAlreadyExited) {
    const stopped =
      accepted &&
      (await waitForExitWithinImplementation(child, graceMs));
    if (!stopped) {
      const forced = await runTaskkillImplementation(child.pid, true);
      if (!forced) {
        child.kill("SIGKILL");
      }
      const directChildStopped = await waitForExitWithinImplementation(
        child,
        Math.min(graceMs, FORCE_STOP_GRACE_MS),
      );
      if (!directChildStopped) {
        throw new CleanupError(
          `Windows process tree ${child.pid} did not exit after forced ` +
            `termination.`,
        );
      }
    }
  }

  for (const processId of new Set(ownedProcessIds)) {
    if (processId === child.pid) {
      continue;
    }
    const forced = await runTaskkillImplementation(processId, true);
    if (!forced) {
      throw new CleanupError(
        `Tracked Windows descendant ${processId} could not be terminated.`,
      );
    }
  }
}

async function stopPosixProcessTree(
  child,
  signal,
  graceMs,
  {
    signalProcessGroupImplementation = signalProcessGroup,
    waitForExitWithinImplementation = waitForExitWithin,
    waitForProcessGroupExitImplementation = waitForProcessGroupExit,
  } = {},
) {
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
    waitForProcessGroupExitImplementation(
      child.pid,
      forceGraceMs,
    ),
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

export async function stopProcessTree(
  child,
  {
    platform = process.platform,
    signal = "SIGTERM",
    graceMs = DEFAULT_STOP_GRACE_MS,
    ownedProcessIds = [],
    runTaskkillImplementation = runTaskkill,
    signalProcessGroupImplementation = signalProcessGroup,
    waitForExitWithinImplementation = waitForExitWithin,
    waitForProcessGroupExitImplementation = waitForProcessGroupExit,
  } = {},
) {
  if (child.pid === undefined) {
    return;
  }

  if (platform === "win32") {
    await stopWindowsProcessTree(
      child,
      ownedProcessIds,
      graceMs,
      runTaskkillImplementation,
      waitForExitWithinImplementation,
    );
    return;
  }
  await stopPosixProcessTree(child, signal, graceMs, {
    signalProcessGroupImplementation,
    waitForExitWithinImplementation,
    waitForProcessGroupExitImplementation,
  });
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
    spawnImplementation = spawn,
    stdio = "inherit",
    stopProcessTreeImplementation = stopProcessTree,
    timeoutMs,
    platform = process.platform,
    windowsTrackerFactory = createWindowsProcessTracker,
  } = {},
) {
  const child = spawnImplementation(command, arguments_, {
    cwd,
    detached: platform !== "win32",
    env,
    stdio,
    windowsHide: true,
  });
  const exitObserver = observeExit(child);
  const windowsTracker =
    platform === "win32" && child.pid !== undefined
      ? windowsTrackerFactory(child.pid)
      : null;
  let ownedProcessIdsPromise = null;
  let reason = null;
  let resolveStopRequested;
  let stopPromise = null;
  const stopRequested = new Promise((resolveStop) => {
    resolveStopRequested = resolveStop;
  });
  const finishWindowsTracking = () => {
    ownedProcessIdsPromise ??=
      windowsTracker === null
        ? Promise.resolve([])
        : windowsTracker
            .finish()
            .then((processIds) =>
              processIds.filter((processId) => processId !== child.pid),
            );
    return ownedProcessIdsPromise;
  };
  const cleanupProcessTree = async (signal = "SIGTERM") => {
    let ownedProcessIds = [];
    let trackingError = null;
    try {
      ownedProcessIds = await finishWindowsTracking();
    } catch (error) {
      trackingError = error;
    }

    await stopProcessTreeImplementation(child, {
      ownedProcessIds,
      platform,
      signal,
    });
    if (trackingError !== null) {
      throw new CleanupError(
        `Windows process-tree tracking failed before cleanup: ` +
          `${trackingError.message}`,
      );
    }
  };

  const requestStop = (nextReason) => {
    reason ??= nextReason;
    stopPromise ??= cleanupProcessTree(
      nextReason.signal ?? "SIGTERM",
    );
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

    if (platform === "win32") {
      await cleanupProcessTree();
    } else if (
      platform !== "win32" &&
      child.pid !== undefined &&
      processGroupExists(child.pid)
    ) {
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
