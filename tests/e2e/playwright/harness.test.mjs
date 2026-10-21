import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { WINDOWS_UNSUPPORTED_MESSAGE } from "./process-runner.mjs";
import {
  playwrightTestArguments,
  validateOperatingSystem,
  validatePreparationRecord,
} from "./harness.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const POWERSHELL_TASKS = [
  "_default.ps1",
  "setup.ps1",
  "smoke.ps1",
  "web-calculator.ps1",
].map((name) =>
  resolve(REPOSITORY_ROOT, "mise/tasks/e2e/playwright", name),
);
const expected = {
  arch: "x64",
  lockHash: "expected-lock-hash",
  operatingSystem: "ubuntu",
  platform: "linux",
  project: "chromium",
};

test("accepts a preparation stamp matching lock and matrix dimensions", () => {
  assert.equal(validatePreparationRecord({ ...expected }, expected), true);
});

test("rejects a preparation stamp with a stale lock hash", () => {
  assert.equal(
    validatePreparationRecord(
      {
        ...expected,
        lockHash: "stale-lock-hash",
      },
      expected,
    ),
    false,
  );
});

test("rejects a preparation stamp from a different OS alias", () => {
  assert.equal(
    validatePreparationRecord(
      {
        ...expected,
        operatingSystem: "linux",
      },
      expected,
    ),
    false,
  );
});

test("accepts an Ubuntu matrix alias on an Ubuntu host", () => {
  assert.equal(
    validateOperatingSystem("ubuntu-latest", {
      arch: "x64",
      linuxRelease: {
        id: "ubuntu",
        versionId: "26.04",
      },
      platform: "linux",
    }),
    "ubuntu-latest",
  );
});

test("rejects an Ubuntu matrix alias on another Linux distribution", () => {
  assert.throws(
    () =>
      validateOperatingSystem("ubuntu-24.04", {
        arch: "arm64",
        linuxRelease: {
          id: "amzn",
          versionId: "2023",
        },
        platform: "linux",
      }),
    /requires an Ubuntu host/,
  );
});

test("accepts a versioned Ubuntu alias only at the matching VERSION_ID", () => {
  assert.equal(
    validateOperatingSystem("ubuntu-24.04", {
      arch: "x64",
      linuxRelease: {
        id: "ubuntu",
        versionId: "24.04",
      },
      platform: "linux",
    }),
    "ubuntu-24.04",
  );
  assert.throws(
    () =>
      validateOperatingSystem("ubuntu-24.04", {
        arch: "x64",
        linuxRelease: {
          id: "ubuntu",
          versionId: "26.04",
        },
        platform: "linux",
      }),
    /requires Ubuntu 24.04/,
  );
});

test("constructs scenario npm execution in offline mode", () => {
  assert.deepEqual(
    playwrightTestArguments("smoke.spec.mjs", "chromium"),
    [
      "exec",
      "--offline",
      "--",
      "playwright",
      "test",
      "smoke.spec.mjs",
      "--project=chromium",
    ],
  );
});

test("rejects Windows as unsupported until native hosted validation", () => {
  assert.throws(
    () =>
      validateOperatingSystem("windows-latest", {
        arch: "x64",
        platform: "win32",
      }),
    (error) => error.message === WINDOWS_UNSUPPORTED_MESSAGE,
  );
});

test("PowerShell tasks fail closed before invoking a child command", async () => {
  for (const path of POWERSHELL_TASKS) {
    const contents = await readFile(path, "utf8");
    assert.match(contents, new RegExp(WINDOWS_UNSUPPORTED_MESSAGE));
    assert.doesNotMatch(contents, /(^|\s)&\s*(mise|node)\b/m);
    assert.doesNotMatch(contents, /\b(Start-Process|Set-Location)\b/);
  }
});
