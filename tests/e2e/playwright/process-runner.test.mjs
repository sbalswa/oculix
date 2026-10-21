import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CleanupError,
  createWindowsProcessTracker,
  npmInvocation,
  ProcessStoppedError,
  runProcess,
  runTaskkill,
  stopProcessTree,
} from "./process-runner.mjs";

const FIXTURE = resolve(
  import.meta.dirname,
  "test-support/process-tree-fixture.mjs",
);
const RUNNER_FIXTURE = resolve(
  import.meta.dirname,
  "test-support/run-process-fixture.mjs",
);

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) =>
      resolveExit({
        code,
        signal,
      }),
    );
  });
}

test("constructs a deterministic Windows npm command through cmd.exe", () => {
  assert.deepEqual(
    npmInvocation(["exec", "--", "playwright", "test"], {
      platform: "win32",
      environment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments_: [
        "/d",
        "/s",
        "/c",
        "npm.cmd exec -- playwright test",
      ],
    },
  );
});

test("rejects Windows npm arguments that would require shell quoting", () => {
  assert.throws(
    () =>
      npmInvocation(["exec", "--", "value&unexpected"], {
        platform: "win32",
      }),
    /Unsafe Windows command token/,
  );
});

test("escalates a Windows process tree to forced taskkill after grace", async () => {
  const calls = [];
  const child = {
    exitCode: null,
    pid: 1234,
    signalCode: null,
  };
  const waitResults = [false, true];

  await stopProcessTree(child, {
    graceMs: 50,
    platform: "win32",
    runTaskkillImplementation: async (processId, force) => {
      calls.push({
        force,
        processId,
      });
      return true;
    },
    waitForExitWithinImplementation: async () => waitResults.shift(),
  });

  assert.deepEqual(calls, [
    {
      force: false,
      processId: 1234,
    },
    {
      force: true,
      processId: 1234,
    },
  ]);
});

test("cleans tracked Windows descendants after the direct child exited", async () => {
  const calls = [];
  const child = {
    exitCode: 1,
    pid: 1234,
    signalCode: null,
  };

  await stopProcessTree(child, {
    ownedProcessIds: [5678],
    platform: "win32",
    runTaskkillImplementation: async (processId, force) => {
      calls.push({
        force,
        processId,
      });
      return true;
    },
  });

  assert.deepEqual(calls, [
    {
      force: false,
      processId: 1234,
    },
    {
      force: true,
      processId: 5678,
    },
  ]);
});

test("Windows tracking retains descendants after their original parent exits", async () => {
  const probes = [];
  const responses = [
    [1234, 5678],
    [5678, 9012],
  ];
  const tracker = createWindowsProcessTracker(1234, {
    intervalMs: 60_000,
    probeImplementation: async (roots) => {
      probes.push(roots);
      return responses.shift();
    },
  });

  assert.deepEqual(await tracker.finish(), [5678, 9012]);
  assert.deepEqual(probes, [
    [1234],
    [1234, 5678],
  ]);
});

test("runProcess forwards tracked Windows descendants after nonzero exit", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 1234;
  child.signalCode = null;
  const cleanups = [];

  const run = runProcess("example.exe", [], {
    platform: "win32",
    spawnImplementation: () => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
      return child;
    },
    stopProcessTreeImplementation: async (_child, options) => {
      cleanups.push(options);
    },
    timeoutMs: 1_000,
    windowsTrackerFactory: () => ({
      finish: async () => [1234, 5678],
    }),
  });

  await assert.rejects(run, /example\.exe exited with code 1/);
  assert.deepEqual(cleanups, [
    {
      ownedProcessIds: [5678],
      platform: "win32",
      signal: "SIGTERM",
    },
  ]);
});

test("bounds taskkill.exe itself and reports its timeout", async () => {
  const utility = new EventEmitter();
  utility.exitCode = null;
  utility.signalCode = null;
  utility.kill = (signal) => {
    utility.exitCode = 1;
    utility.signalCode = signal;
    queueMicrotask(() => utility.emit("exit", 1, signal));
    return true;
  };

  await assert.rejects(
    runTaskkill(1234, true, {
      forceWaitMs: 10,
      spawnImplementation: () => utility,
      timeoutMs: 10,
    }),
    (error) =>
      error instanceof CleanupError &&
      /taskkill\.exe.*timed out after 10ms/.test(error.message),
  );
});

test("fails within a bounded interval when taskkill cannot be reaped", async () => {
  const utility = new EventEmitter();
  utility.exitCode = null;
  utility.signalCode = null;
  utility.kill = () => true;

  await assert.rejects(
    runTaskkill(1234, true, {
      forceWaitMs: 10,
      spawnImplementation: () => utility,
      timeoutMs: 10,
    }),
    (error) =>
      error instanceof CleanupError &&
      /did not exit within 20ms/.test(error.message),
  );
});

test("fails clearly when a POSIX process group survives SIGKILL", async () => {
  const signals = [];
  const child = {
    exitCode: null,
    pid: 1234,
    signalCode: null,
  };

  await assert.rejects(
    stopProcessTree(child, {
      graceMs: 10,
      platform: "linux",
      signalProcessGroupImplementation: (processId, signal) => {
        signals.push({
          processId,
          signal,
        });
        return true;
      },
      waitForExitWithinImplementation: async () => true,
      waitForProcessGroupExitImplementation: async () => false,
    }),
    (error) =>
      error instanceof CleanupError &&
      /still exists after SIGKILL/.test(error.message),
  );
  assert.deepEqual(signals, [
    {
      processId: 1234,
      signal: "SIGTERM",
    },
    {
      processId: 1234,
      signal: "SIGKILL",
    },
  ]);
});

test("fails clearly when the direct child misses its forced deadline", async () => {
  const child = {
    exitCode: null,
    pid: 1234,
    signalCode: null,
  };

  await assert.rejects(
    stopProcessTree(child, {
      graceMs: 10,
      platform: "linux",
      signalProcessGroupImplementation: () => true,
      waitForExitWithinImplementation: async () => false,
      waitForProcessGroupExitImplementation: async () => true,
    }),
    (error) =>
      error instanceof CleanupError &&
      /Direct child 1234 did not exit after SIGKILL/.test(error.message),
  );
});

test(
  "timeout terminates the spawned process group and its descendant",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "oculix-playwright-timeout-"),
    );
    const pidFile = resolve(directory, "pids.json");
    try {
      await assert.rejects(
        runProcess(process.execPath, [FIXTURE, pidFile], {
          timeoutMs: 250,
        }),
        (error) =>
          error instanceof ProcessStoppedError &&
          error.reason.kind === "timeout",
      );

      const pids = JSON.parse(await waitForFile(pidFile));
      assert.equal(processExists(pids.parent), false);
      assert.equal(processExists(pids.descendant), false);
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }
  },
);

test(
  "SIGTERM is propagated and the descendant process group is reaped",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "oculix-playwright-signal-"),
    );
    const pidFile = resolve(directory, "pids.json");
    try {
      const runner = spawn(process.execPath, [RUNNER_FIXTURE, pidFile], {
        stdio: "ignore",
      });
      const pids = JSON.parse(await waitForFile(pidFile));
      runner.kill("SIGTERM");
      const result = await waitForExit(runner);

      assert.deepEqual(result, {
        code: 143,
        signal: null,
      });
      assert.equal(processExists(pids.parent), false);
      assert.equal(processExists(pids.descendant), false);
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }
  },
);

test(
  "a failed direct child cannot leave its descendant running",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "oculix-playwright-failure-"),
    );
    const pidFile = resolve(directory, "pids.json");
    try {
      await assert.rejects(
        runProcess(process.execPath, [FIXTURE, pidFile, "exit"], {
          timeoutMs: 5_000,
        }),
        /exited with code 1/,
      );

      const pids = JSON.parse(await waitForFile(pidFile));
      assert.equal(processExists(pids.parent), false);
      assert.equal(processExists(pids.descendant), false);
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }
  },
);
