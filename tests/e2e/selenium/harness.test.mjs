import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeFailureDiagnostics } from "./diagnostics.mjs";
import {
  buildAndConfigureDriver,
  createDriverWithService,
} from "./harness.mjs";
import { resolveResources } from "./setup.mjs";

test("kills the driver service when session creation fails", async () => {
  let killCalled = false;
  const service = {
    async kill() {
      killCalled = true;
    },
  };

  await assert.rejects(
    createDriverWithService({
      create: async () => {
        throw new Error("session creation failed");
      },
      service,
    }),
    /session creation failed/,
  );
  assert.equal(killCalled, true);
});

test("does not attach the same startup error as its own cleanup error", async () => {
  const startupError = new Error("service terminated");
  const service = {
    async kill() {
      throw startupError;
    },
  };

  let error;
  try {
    await createDriverWithService({
      create: async () => {
        throw startupError;
      },
      service,
    });
    assert.fail("session creation failure must reject");
  } catch (caughtError) {
    error = caughtError;
  }

  assert.equal(error, startupError);
  assert.equal(error.cleanupError, undefined);
});

test("quits a built driver when post-build configuration fails", async () => {
  let quitCalled = false;
  const driver = {
    manage() {
      return {
        async setTimeouts() {
          throw new Error("timeout configuration failed");
        },
      };
    },
    async quit() {
      quitCalled = true;
    },
  };

  await assert.rejects(
    buildAndConfigureDriver({ build: async () => driver }),
    /timeout configuration failed/,
  );
  assert.equal(quitCalled, true);
});

test("retains a cleanup error when configuration and quit both fail", async () => {
  const driver = {
    manage() {
      return {
        async setTimeouts() {
          throw new Error("configuration failed");
        },
      };
    },
    async quit() {
      throw new Error("quit failed");
    },
  };

  let error;
  try {
    await buildAndConfigureDriver({ build: async () => driver });
    assert.fail("configuration failure must reject");
  } catch (caughtError) {
    error = caughtError;
  }
  assert.match(String(error), /configuration failed/);
  assert.match(String(error.cleanupError), /quit failed/);
});

test("startup diagnostics work without a driver and retain bounded logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selenium-diagnostics-"));
  const driverLog = join(directory, "driver-source.log");
  await writeFile(driverLog, "x".repeat(300 * 1024), "utf8");

  try {
    const outputDirectory = await writeFailureDiagnostics({
      diagnosticsDirectory: directory,
      error: new Error("browser launch failed"),
      logPaths: { driver: driverLog },
      metadata: {
        browser: "chrome",
        os: "ubuntu",
        phase: "driver-startup",
      },
      scenario: "startup",
    });

    const metadata = JSON.parse(
      await readFile(join(outputDirectory, "metadata.json"), "utf8"),
    );
    const retainedLog = await readFile(
      join(outputDirectory, "driver.log"),
      "utf8",
    );
    assert.equal(metadata.browser, "chrome");
    assert.equal(metadata.os, "ubuntu");
    assert.equal(metadata.phase, "driver-startup");
    assert.match(metadata.error.message, /browser launch failed/);
    assert.ok(Buffer.byteLength(retainedLog) < 257 * 1024);
    assert.match(retainedLog, /truncated after 262144 bytes/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("Chromium resolution never falls back to Selenium Manager", async () => {
  let managerCalled = false;
  const capability = {
    browser: "chromium",
    browserBinary: null,
    driverBinary: null,
  };

  await assert.rejects(
    resolveResources(capability, {
      findBrowser: async () => null,
      findDriver: async () => "/opt/chromedriver",
      invokeManager: async () => {
        managerCalled = true;
        return {};
      },
    }),
    /deterministic Chromium executable mapping/,
  );
  assert.equal(managerCalled, false);
});

test("Chromium accepts deterministic browser and driver paths", async () => {
  const resources = await resolveResources(
    {
      browser: "chromium",
      browserBinary: null,
      driverBinary: null,
    },
    {
      findBrowser: async () => "/usr/bin/chromium",
      findDriver: async () => "/usr/bin/chromedriver",
      invokeManager: async () => {
        throw new Error("manager must not run");
      },
    },
  );

  assert.deepEqual(resources, {
    browserBinary: "/usr/bin/chromium",
    driverBinary: "/usr/bin/chromedriver",
    managerPath: null,
    provisioner: "resolved-paths",
  });
});
