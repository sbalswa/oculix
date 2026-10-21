import assert from "node:assert/strict";
import test from "node:test";

import { resolveBrowserSelection } from "./harness.mjs";

test("defaults local runs to Chromium", () => {
  const selection = resolveBrowserSelection({
    arguments_: [],
    environment: {},
  });

  assert.equal(selection.name, "chromium");
  assert.equal(selection.source, "local default");
});

test("accepts an environment selection and binary", () => {
  const selection = resolveBrowserSelection({
    arguments_: [],
    environment: {
      E2E_BROWSER: "chrome",
      E2E_BROWSER_BINARY: "/opt/google/chrome",
    },
  });

  assert.equal(selection.name, "chrome");
  assert.equal(selection.binary, "/opt/google/chrome");
  assert.equal(selection.source, "E2E_BROWSER");
});

test("task arguments override the environment selection", () => {
  const selection = resolveBrowserSelection({
    arguments_: ["--browser", "chrome"],
    environment: { E2E_BROWSER: "chromium" },
  });

  assert.equal(selection.name, "chrome");
  assert.equal(selection.source, "--browser");
});

for (const requestedBrowser of ["", "firefox", "safari"]) {
  test(`rejects unsupported browser value "${requestedBrowser}"`, () => {
    assert.throws(
      () =>
        resolveBrowserSelection({
          arguments_: [`--browser=${requestedBrowser}`],
          environment: {},
        }),
      /Unsupported E2E browser/,
    );
  });
}

test("rejects duplicate browser arguments", () => {
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["--browser", "chromium", "--browser=chrome"],
        environment: {},
      }),
    /Browser selection may only be provided once/,
  );
});

test("rejects unrelated task arguments", () => {
  assert.throws(
    () =>
      resolveBrowserSelection({
        arguments_: ["--headed"],
        environment: {},
      }),
    /Unknown argument/,
  );
});
