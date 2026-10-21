import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CleanupError,
  npmInvocation,
  ProcessStoppedError,
  runProcess,
  stopProcessTree,
  WINDOWS_UNSUPPORTED_MESSAGE,
} from "./process-runner.mjs";

const FIXTURE = resolve(
  import.meta.dirname,
  "test-support/process-tree-fixture.mjs",
);
const RUNNER_FIXTURE = resolve(
  import.meta.dirname,
  "test-support/run-process-fixture.mjs",
);

async function waitForPidFile(path) {
  const deadline = Date.now() + 5_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        Number.isInteger(value.parent) &&
        Number.isInteger(value.descendant)
      ) {
        return value;
      }
      lastError = new Error(`Incomplete PID readiness payload at ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    `Timed out waiting for an atomic PID readiness payload at ${path}: ` +
      `${lastError?.message ?? "no payload"}`,
  );
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

test("constructs the POSIX npm invocation without a shell", () => {
  assert.deepEqual(
    npmInvocation(["exec", "--offline", "--", "playwright"], {
      platform: "linux",
    }),
    {
      command: "npm",
      arguments_: ["exec", "--offline", "--", "playwright"],
    },
  );
});

test("rejects Windows npm execution", () => {
  assert.throws(
    () => npmInvocation(["ci"], { platform: "win32" }),
    (error) => error.message === WINDOWS_UNSUPPORTED_MESSAGE,
  );
});

test("rejects Windows before spawning any child process", async () => {
  let spawned = false;
  await assert.rejects(
    runProcess("npm.cmd", ["ci"], {
      platform: "win32",
      spawnImplementation: () => {
        spawned = true;
        throw new Error("spawn must not be reached");
      },
    }),
    (error) => error.message === WINDOWS_UNSUPPORTED_MESSAGE,
  );
  assert.equal(spawned, false);
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

      const pids = await waitForPidFile(pidFile);
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
      const pids = await waitForPidFile(pidFile);
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

      const pids = await waitForPidFile(pidFile);
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
