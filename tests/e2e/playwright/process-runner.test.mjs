import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  npmInvocation,
  ProcessStoppedError,
  runProcess,
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
