import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateOperatingSystem,
  validatePreparationRecord,
} from "./harness.mjs";

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
      linuxDistribution: "ubuntu",
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
        linuxDistribution: "amzn",
        platform: "linux",
      }),
    /requires an Ubuntu host/,
  );
});
