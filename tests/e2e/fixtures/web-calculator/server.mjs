#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(FIXTURE_DIRECTORY, "index.html");

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...COMMON_HEADERS,
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function handleRequest(request, response) {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendText(response, 405, "Method not allowed\n");
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  if (requestUrl.pathname === "/healthz") {
    sendText(response, 200, method === "HEAD" ? "" : "ready\n");
    return;
  }

  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
    sendText(response, 404, "Not found\n");
    return;
  }

  response.writeHead(200, {
    ...COMMON_HEADERS,
    "content-type": "text/html; charset=utf-8",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(INDEX_PATH);
  stream.on("error", (error) => {
    response.destroy(error);
  });
  stream.pipe(response);
}

export async function startFixtureServer({ port = 0 } = {}) {
  await access(INDEX_PATH);

  const server = createServer(handleRequest);
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("Fixture server did not receive a TCP address");
  }

  return {
    server,
    url: `http://${LOOPBACK_HOST}:${address.port}`,
  };
}

function parsePort(arguments_) {
  if (arguments_.length === 0) {
    return 0;
  }
  if (arguments_.length !== 2 || arguments_[0] !== "--port") {
    throw new Error("Usage: server.mjs [--port PORT]");
  }

  const port = Number(arguments_[1]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${arguments_[1]}`);
  }
  return port;
}

async function runCli() {
  const port = parsePort(process.argv.slice(2));
  const { server, url } = await startFixtureServer({ port });
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, status: "ready", url })}\n`,
  );

  let closing = false;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
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
