#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIRECTORY, "../../..");
const FIXTURE_LIFECYCLE = resolve(
  PROJECT_ROOT,
  "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
);
const HARNESS = resolve(HARNESS_DIRECTORY, "harness.mjs");

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function runCommand(command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let result;
  try {
    result = await waitForExit(child);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  if (result.signal !== null) {
    throw new Error(`${command} terminated with signal ${result.signal}`);
  }
  if (result.code !== 0) {
    throw new Error(`${command} exited with status ${result.code}`);
  }
}

async function installDependencies() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npm, ["ci", "--prefix", HARNESS_DIRECTORY]);
}

async function runScenario(scenario, options) {
  if (scenario === "web-calculator") {
    await runCommand(process.execPath, [
      FIXTURE_LIFECYCLE,
      process.execPath,
      HARNESS,
      scenario,
      ...options,
    ]);
    return;
  }
  await runCommand(process.execPath, [HARNESS, scenario, ...options]);
}

async function run() {
  const [task, ...options] = process.argv.slice(2);
  if (!["all", "smoke", "web-calculator"].includes(task)) {
    throw new Error(
      "Usage: task.mjs all|smoke|web-calculator [--browser BROWSER]",
    );
  }

  await installDependencies();
  if (task === "all") {
    await runScenario("smoke", options);
    await runScenario("web-calculator", options);
  } else {
    await runScenario(task, options);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
