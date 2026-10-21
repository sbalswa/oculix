#!/usr/bin/env node

import { constants as osConstants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(FIXTURE_DIRECTORY, "server.mjs");
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child) {
  if (exited(child)) {
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

async function stopProcess(child) {
  if (exited(child)) {
    return;
  }

  child.kill("SIGTERM");
  const stopped = await new Promise((resolveStopped, rejectStopped) => {
    const timeout = setTimeout(
      () => resolveStopped(false),
      STOP_TIMEOUT_MS,
    );
    waitForExit(child).then(
      () => {
        clearTimeout(timeout);
        resolveStopped(true);
      },
      (error) => {
        clearTimeout(timeout);
        rejectStopped(error);
      },
    );
  });

  if (!stopped && !exited(child)) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

function waitForReady(server) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(`Fixture server was not ready within ${READY_TIMEOUT_MS}ms`),
      );
    }, READY_TIMEOUT_MS);

    const finish = (callback, value) => {
      clearTimeout(timeout);
      server.stdout.off("data", onData);
      server.off("error", onError);
      server.off("exit", onExit);
      callback(value);
    };
    const onError = (error) => finish(rejectReady, error);
    const onExit = (code, signal) => {
      finish(
        rejectReady,
        new Error(
          `Fixture server exited before readiness (code=${code}, signal=${signal})`,
        ),
      );
    };
    const onData = (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = output.slice(0, newline);
      try {
        const message = JSON.parse(line);
        if (
          message.status !== "ready" ||
          typeof message.url !== "string" ||
          new URL(message.url).hostname !== "127.0.0.1"
        ) {
          throw new Error(`Unexpected readiness message: ${line}`);
        }
        finish(resolveReady, message.url);
      } catch (error) {
        finish(rejectReady, error);
      }
    };

    server.stdout.setEncoding("utf8");
    server.stdout.on("data", onData);
    server.once("error", onError);
    server.once("exit", onExit);
  });
}

async function verifyHealth(url) {
  const response = await fetch(`${url}/healthz`, {
    signal: AbortSignal.timeout(READY_TIMEOUT_MS),
  });
  if (!response.ok || (await response.text()) !== "ready\n") {
    throw new Error(`Fixture readiness check failed at ${url}/healthz`);
  }
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

export async function runWithFixture(command, arguments_ = []) {
  if (!command) {
    throw new Error(
      "Usage: lifecycle.mjs COMMAND [ARG ...]\n" +
        "The child receives WEB_CALCULATOR_URL in its environment.",
    );
  }

  const server = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let child = null;
  let forwardedSignal = null;

  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    if (child !== null && !exited(child)) {
      child.kill(signal);
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const url = await waitForReady(server);
    await verifyHealth(url);
    process.stdout.write(`Web calculator ready at ${url}\n`);

    child = spawn(command, arguments_, {
      env: {
        ...process.env,
        WEB_CALCULATOR_URL: url,
      },
      stdio: "inherit",
    });
    const result = await waitForExit(child);

    return {
      ...result,
      url,
      forwardedSignal,
    };
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (child !== null && forwardedSignal !== null && !exited(child)) {
      child.kill(forwardedSignal);
      await waitForExit(child);
    }
    await stopProcess(server);
  }
}

async function runCli() {
  const [command, ...arguments_] = process.argv.slice(2);
  const result = await runWithFixture(command, arguments_);

  if (result.forwardedSignal !== null) {
    process.exitCode = signalExitCode(result.forwardedSignal);
  } else if (result.signal !== null) {
    process.exitCode = signalExitCode(result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
