import assert from "node:assert/strict";
import test from "node:test";

import { resolveCapability } from "./configuration.mjs";

test("defaults local Linux runs to Chrome with an honest OS label", () => {
  const capability = resolveCapability({
    arguments_: [],
    environment: {},
    linuxDistribution: "amzn",
    platform: "linux",
  });

  assert.equal(capability.browser, "chrome");
  assert.equal(capability.browserSource, "local default");
  assert.equal(capability.os, "linux");
  assert.equal(capability.osSource, "host default");
  assert.equal(capability.downloadsAllowed, false);
});

test("accepts an explicit Ubuntu Chromium capability and binary", () => {
  const capability = resolveCapability({
    arguments_: [],
    environment: {
      E2E_BROWSER: "chromium",
      E2E_BROWSER_BINARY: "/usr/bin/chromium",
      E2E_DRIVER_BINARY: "/usr/bin/chromedriver",
      E2E_OS: "ubuntu",
    },
    linuxDistribution: "ubuntu",
    platform: "linux",
  });

  assert.equal(capability.browser, "chromium");
  assert.equal(capability.browserBinary, "/usr/bin/chromium");
  assert.equal(capability.driverBinary, "/usr/bin/chromedriver");
  assert.equal(capability.os, "ubuntu");
});

test("task arguments override environment capability fields", () => {
  const capability = resolveCapability({
    arguments_: ["--browser", "chrome", "--os", "ubuntu"],
    environment: {
      E2E_BROWSER: "chromium",
      E2E_OS: "linux",
    },
    linuxDistribution: "ubuntu",
    platform: "linux",
  });

  assert.equal(capability.browser, "chrome");
  assert.equal(capability.browserSource, "--browser");
  assert.equal(capability.os, "ubuntu");
  assert.equal(capability.osSource, "--os");
});

for (const requestedBrowser of ["", "firefox", "safari"]) {
  test(`rejects unsupported browser value "${requestedBrowser}"`, () => {
    assert.throws(
      () =>
        resolveCapability({
          arguments_: [`--browser=${requestedBrowser}`],
          environment: {},
          linuxDistribution: "ubuntu",
          platform: "linux",
        }),
      /Unsupported E2E browser/,
    );
  });
}

test("rejects unsupported and host-incompatible OS values", () => {
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--os", "solaris"],
        environment: {},
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /Unsupported E2E OS/,
  );
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--os", "windows"],
        environment: {},
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /requires host platform "win32"/,
  );
});

test("rejects an Ubuntu capability on another Linux distribution", () => {
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--os", "ubuntu"],
        environment: {},
        linuxDistribution: "amzn",
        platform: "linux",
      }),
    /requires an Ubuntu host/,
  );
});

test("rejects duplicate capability arguments", () => {
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--browser", "chromium", "--browser=chrome"],
        environment: {},
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /--browser may only be provided once/,
  );
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--os", "linux", "--os=ubuntu"],
        environment: {},
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /--os may only be provided once/,
  );
});

test("requires an explicit downloads policy value", () => {
  assert.throws(
    () =>
      resolveCapability({
        arguments_: [],
        environment: { E2E_SELENIUM_ALLOW_DOWNLOADS: "sometimes" },
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /must be one of/,
  );
  assert.equal(
    resolveCapability({
      arguments_: [],
      environment: { E2E_SELENIUM_ALLOW_DOWNLOADS: "true" },
      linuxDistribution: "ubuntu",
      platform: "linux",
    }).downloadsAllowed,
    true,
  );
});

test("rejects unrelated task arguments", () => {
  assert.throws(
    () =>
      resolveCapability({
        arguments_: ["--headed"],
        environment: {},
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    /Unknown argument/,
  );
});
