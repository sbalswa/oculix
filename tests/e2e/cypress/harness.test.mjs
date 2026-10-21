import assert from "node:assert/strict";
import test from "node:test";

import { resolveBrowserSelection } from "./harness.mjs";

test("defaults local runs to Electron", () => {
  assert.deepEqual(
    resolveBrowserSelection({
      arguments_: ["smoke"],
      environment: {},
    }),
    {
      browser: "electron",
      scenario: "smoke",
      source: "local default",
    },
  );
});

test("accepts an explicit matrix browser from E2E_BROWSER", () => {
  assert.deepEqual(
    resolveBrowserSelection({
      arguments_: ["web-calculator"],
      environment: { E2E_BROWSER: "Chromium" },
    }),
    {
      browser: "chromium",
      scenario: "web-calculator",
      source: "E2E_BROWSER",
    },
  );
});

test("--browser overrides the environment", () => {
  assert.deepEqual(
    resolveBrowserSelection({
      arguments_: ["smoke", "--browser", "Firefox"],
      environment: { E2E_BROWSER: "chrome" },
    }),
    {
      browser: "firefox",
      scenario: "smoke",
      source: "--browser",
    },
  );
});

test("rejects unknown browsers before starting Cypress", () => {
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["smoke", "--browser=safari"],
        environment: {},
      }),
    /Unsupported E2E browser "safari"/,
  );
});

test("rejects missing browser values and unknown options", () => {
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["smoke", "--browser"],
        environment: {},
      }),
    /--browser requires a value/,
  );
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["smoke", "--headed"],
        environment: {},
      }),
    /Unknown argument: --headed/,
  );
});

test("rejects unknown scenarios", () => {
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["calculator"],
        environment: {},
      }),
    /Unknown Cypress scenario: calculator/,
  );
});
