import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  npmInvocation,
  runCommand,
  taskkillExitAccepted,
  terminateProcessTree,
} from "./task.mjs";

const PROCESS_TREE_FIXTURE = resolve(
  import.meta.dirname,
  "process-tree-fixture.mjs",
);

async function waitForReadyFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Process fixture did not create ${path}`);
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(processId) {
  const deadline = Date.now() + 5_000;
  while (processExists(processId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return true;
}

test("uses cmd.exe explicitly for npm.cmd on Windows", () => {
  assert.deepEqual(
    npmInvocation(["ci"], {
      environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
    }),
    {
      arguments_: ["/d", "/s", "/c", "npm.cmd ci"],
      command: "C:\\Windows\\System32\\cmd.exe",
    },
  );
});

test("rejects Windows npm arguments that require shell quoting", () => {
  assert.throws(
    () => npmInvocation(["ci", "value&unexpected"], { platform: "win32" }),
    /Unsafe Windows command token/,
  );
});

test("uses npm directly on non-Windows hosts", () => {
  assert.deepEqual(npmInvocation(["ci"], { platform: "linux" }), {
    arguments_: ["ci"],
    command: "npm",
  });
});

test("accepts the taskkill already-gone exit code", () => {
  assert.equal(taskkillExitAccepted(0), true);
  assert.equal(taskkillExitAccepted(128), true);
  assert.equal(taskkillExitAccepted(1), false);
});

test("bounds Windows graceful and forced process-tree waits", async () => {
  const taskkillCalls = [];
  const waitDurations = [];
  const child = {
    exitCode: null,
    pid: 1234,
    signalCode: null,
  };
  const waitResults = [false, true];

  await terminateProcessTree(child, {
    platform: "win32",
    runTaskkillImplementation: async (processId, { force }) => {
      taskkillCalls.push({ force, processId });
      return true;
    },
    timeoutMilliseconds: 5_000,
    waitForExitWithinImplementation: async (_child, timeoutMilliseconds) => {
      waitDurations.push(timeoutMilliseconds);
      return waitResults.shift();
    },
  });

  assert.deepEqual(taskkillCalls, [
    { force: false, processId: 1234 },
    { force: true, processId: 1234 },
  ]);
  assert.deepEqual(waitDurations, [5_000, 1_000]);
});

test("fails after the bounded forced Windows process-tree wait", async () => {
  const child = {
    exitCode: null,
    pid: 1234,
    signalCode: null,
  };

  await assert.rejects(
    terminateProcessTree(child, {
      platform: "win32",
      runTaskkillImplementation: async () => true,
      timeoutMilliseconds: 50,
      waitForExitWithinImplementation: async () => false,
    }),
    /did not exit after forced taskkill/,
  );
});

test(
  "aborting the process runner terminates its entire process group",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cypress-process-tree-"));
    const readyFile = join(directory, "ready.json");
    const abortController = new AbortController();
    let processIds;

    try {
      const command = runCommand(
        process.execPath,
        [PROCESS_TREE_FIXTURE, readyFile],
        {
          abortSignal: abortController.signal,
          timeoutMilliseconds: 200,
        },
      );
      processIds = await waitForReadyFile(readyFile);
      abortController.abort();

      await assert.rejects(command, /terminated with signal SIGKILL/);
      assert.equal(
        await waitForProcessExit(processIds.childPid),
        true,
        "managed child must terminate",
      );
      assert.equal(
        await waitForProcessExit(processIds.grandchildPid),
        true,
        "managed grandchild must terminate",
      );
    } finally {
      if (processIds && processExists(processIds.childPid)) {
        process.kill(-processIds.childPid, "SIGKILL");
      }
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  "a failed direct child cannot leave its descendant running",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cypress-process-tree-"));
    const readyFile = join(directory, "ready.json");
    let processIds;

    try {
      const command = runCommand(
        process.execPath,
        [PROCESS_TREE_FIXTURE, readyFile, "exit"],
        {
          timeoutMilliseconds: 200,
        },
      );
      processIds = await waitForReadyFile(readyFile);

      await assert.rejects(command, /exited with status 1/);
      assert.equal(
        await waitForProcessExit(processIds.childPid),
        true,
        "failed direct child must terminate",
      );
      assert.equal(
        await waitForProcessExit(processIds.grandchildPid),
        true,
        "abandoned grandchild must terminate",
      );
    } finally {
      if (processIds && processExists(processIds.grandchildPid)) {
        process.kill(processIds.grandchildPid, "SIGKILL");
      }
      await rm(directory, { force: true, recursive: true });
    }
  },
);
