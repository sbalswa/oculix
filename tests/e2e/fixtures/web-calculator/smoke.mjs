#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { spawn } from "node:child_process";

const FIXTURE_DIRECTORY = resolve(fileURLToPath(new URL(".", import.meta.url)));
const LIFECYCLE_PATH = resolve(FIXTURE_DIRECTORY, "lifecycle.mjs");

class FixtureButton {
  constructor(dataset) {
    this.dataset = dataset;
    this.listeners = new Map();
  }

  addEventListener(eventName, listener) {
    this.listeners.set(eventName, listener);
  }

  click() {
    const listener = this.listeners.get("click");
    assert.ok(listener, "button must register a click listener");
    listener();
  }
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match?.[1];
}

function executeCalculator(html) {
  const display = { textContent: "0" };
  const buttons = [];
  const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;

  for (const match of html.matchAll(buttonPattern)) {
    const attributes = match[1];
    const action = attribute(attributes, "data-action");
    if (action !== undefined) {
      buttons.push(
        new FixtureButton({
          action,
          value: attribute(attributes, "data-value"),
        }),
      );
    }
  }

  const scriptMatch = html.match(
    /<script id="calculator-script">([\s\S]*?)<\/script>/,
  );
  assert.ok(scriptMatch, "calculator script must be present");
  assert.ok(buttons.length > 0, "calculator buttons must be present");

  const document = {
    querySelector(selector) {
      assert.equal(selector, "#display");
      return display;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "button[data-action]");
      return buttons;
    },
  };
  vm.runInNewContext(scriptMatch[1], { document });

  const click = (action, value) => {
    const button = buttons.find(
      (candidate) =>
        candidate.dataset.action === action &&
        (value === undefined || candidate.dataset.value === value),
    );
    assert.ok(button, `missing ${action} button${value ? ` ${value}` : ""}`);
    button.click();
  };

  click("clear");
  click("digit", "7");
  click("operator", "multiply");
  click("digit", "3");
  click("digit", "4");
  click("equals");
  assert.equal(display.textContent, "238");
}

async function probe(urlFile, exitCode) {
  const url = process.env.WEB_CALCULATOR_URL;
  assert.ok(url, "lifecycle wrapper must expose WEB_CALCULATOR_URL");
  const parsedUrl = new URL(url);
  assert.equal(parsedUrl.hostname, "127.0.0.1");
  assert.notEqual(parsedUrl.port, "");

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html; charset=utf-8$/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");

  const html = await response.text();
  assert.match(html, /aria-label="Calculator display"/);
  assert.match(html, /data-testid="display"/);
  assert.match(html, /data-action="clear"/);
  assert.match(html, /aria-label="Multiply"/);
  assert.match(html, /aria-label="Equals"/);
  assert.doesNotMatch(html, /https?:\/\/|<link\b|<img\b/i);
  executeCalculator(html);

  const missingResponse = await fetch(`${url}/not-a-fixture-path`);
  assert.equal(missingResponse.status, 404);
  await writeFile(urlFile, url, "utf8");
  process.exitCode = exitCode;
}

async function holdProbe(urlFile) {
  const url = process.env.WEB_CALCULATOR_URL;
  assert.ok(url, "lifecycle wrapper must expose WEB_CALCULATOR_URL");
  await writeFile(urlFile, url, "utf8");
  await new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForUrlFile(urlFile) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(urlFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Lifecycle probe did not create ${urlFile}`);
}

async function assertStopped(url) {
  try {
    await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.fail(`fixture server is still reachable at ${url}`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") {
      throw error;
    }
  }
}

async function runLifecycleCase(directory, name, expectedExitCode) {
  const urlFile = join(directory, `${name}.url`);
  const child = spawn(
    process.execPath,
    [
      LIFECYCLE_PATH,
      process.execPath,
      fileURLToPath(import.meta.url),
      "--probe",
      urlFile,
      String(expectedExitCode),
    ],
    { stdio: "inherit" },
  );
  const result = await waitForExit(child);
  assert.equal(result.signal, null);
  assert.equal(
    result.code,
    expectedExitCode,
    `${name} lifecycle must preserve the child exit code`,
  );

  const url = await readFile(urlFile, "utf8");
  await assertStopped(url);
}

async function runInterruptionCase(directory) {
  const urlFile = join(directory, "interruption.url");
  const child = spawn(
    process.execPath,
    [
      LIFECYCLE_PATH,
      process.execPath,
      fileURLToPath(import.meta.url),
      "--hold-probe",
      urlFile,
    ],
    { stdio: "inherit" },
  );

  const url = await waitForUrlFile(urlFile);
  child.kill("SIGTERM");
  const result = await waitForExit(child);
  assert.equal(result.signal, null);
  assert.equal(
    result.code,
    143,
    "interrupted lifecycle must report the SIGTERM exit code",
  );
  await assertStopped(url);
}

async function runSmoke() {
  const directory = await mkdtemp(join(tmpdir(), "web-calculator-smoke-"));
  try {
    await runLifecycleCase(directory, "success", 0);
    await runLifecycleCase(directory, "failure", 23);
    await runInterruptionCase(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  process.stdout.write("Web calculator fixture smoke check passed.\n");
}

if (process.argv[2] === "--probe") {
  const [, , , urlFile, exitCodeText] = process.argv;
  probe(urlFile, Number(exitCodeText)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "--hold-probe") {
  holdProbe(process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  runSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
