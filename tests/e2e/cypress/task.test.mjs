import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertCypressTaskPlatformSupported,
  CleanupError,
  npmInvocation,
  ProcessStoppedError,
  runCommand,
} from "./task.mjs";
import { WINDOWS_UNSUPPORTED_MESSAGE } from "./platform.mjs";

const PROCESS_TREE_FIXTURE = resolve(
  import.meta.dirname,
  "process-tree-fixture.mjs",
);
const POWERSHELL_TASK_DIRECTORY = resolve(
  import.meta.dirname,
  "../../../mise/tasks/e2e/cypress",
);
const PACKAGE_JSON = resolve(import.meta.dirname, "package.json");

async function waitForReadyFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
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

test("keeps a deterministic Windows npm invocation for a future hosted row", () => {
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

test("fails closed on Windows before spawning a Cypress task process", async () => {
  let spawned = false;

  assert.doesNotThrow(() =>
    assertCypressTaskPlatformSupported({ platform: "linux" }),
  );
  assert.throws(
    () => assertCypressTaskPlatformSupported({ platform: "win32" }),
    (error) => error.message === WINDOWS_UNSUPPORTED_MESSAGE,
  );
  await assert.rejects(
    runCommand("example.exe", [], {
      platform: "win32",
      spawnImplementation: () => {
        spawned = true;
      },
    }),
    (error) => error.message === WINDOWS_UNSUPPORTED_MESSAGE,
  );
  assert.equal(spawned, false);
});

test("PowerShell tasks fail closed before invoking a child command", async () => {
  const taskNames = (await readdir(POWERSHELL_TASK_DIRECTORY))
    .filter((name) => name.endsWith(".ps1"))
    .sort();

  assert.ok(taskNames.length > 0, "expected Cypress PowerShell task entries");
  for (const taskName of taskNames) {
    const contents = await readFile(
      resolve(POWERSHELL_TASK_DIRECTORY, taskName),
      "utf8",
    );
    assert.ok(contents.includes(WINDOWS_UNSUPPORTED_MESSAGE));
    assert.doesNotMatch(contents, /(^|\s)&\s*(mise|node)\b/m);
    assert.doesNotMatch(contents, /\b(Start-Process|Set-Location)\b/);
  }
});

test("advertised npm scenarios route through the guarded task runner", async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));

  assert.equal(packageJson.scripts.smoke, "node task.mjs smoke");
  assert.equal(
    packageJson.scripts["web-calculator"],
    "node task.mjs web-calculator",
  );
});

test("readiness parsing retries a partially visible JSON write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cypress-readiness-"));
  const readyFile = join(directory, "ready.json");

  try {
    await writeFile(readyFile, "{", "utf8");
    const readiness = waitForReadyFile(readyFile);
    const completeWrite = new Promise((resolveWrite, rejectWrite) => {
      setTimeout(() => {
        writeFile(readyFile, '{"ready":true}\n', "utf8").then(
          resolveWrite,
          rejectWrite,
        );
      }, 30);
    });
    assert.deepEqual(await readiness, { ready: true });
    await completeWrite;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("surfaces cancellation cleanup failure without awaiting a stuck child", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 1234;
  child.signalCode = null;
  const abortController = new AbortController();
  abortController.abort();
  const startedAt = Date.now();

  await assert.rejects(
    runCommand("stuck.exe", [], {
      abortSignal: abortController.signal,
      platform: "linux",
      spawnImplementation: () => child,
      terminateProcessTreeImplementation: async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        throw new CleanupError("bounded cleanup failed");
      },
    }),
    (error) =>
      error instanceof CleanupError &&
      error.message === "bounded cleanup failed",
  );
  assert.ok(
    Date.now() - startedAt < 500,
    "cleanup failure must not wait for the stuck child",
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

      await assert.rejects(
        command,
        (error) =>
          error instanceof ProcessStoppedError &&
          error.signal === "SIGTERM",
      );
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
