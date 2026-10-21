import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

const readyFile = process.argv[2];
const mode = process.argv[3];
if (!readyFile) {
  throw new Error("A readiness file path is required");
}

const grandchild = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);',
  ],
  { stdio: "ignore" },
);

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const temporaryReadyFile = `${readyFile}.${process.pid}.tmp`;
await writeFile(
  temporaryReadyFile,
  `${JSON.stringify({
    childPid: process.pid,
    grandchildPid: grandchild.pid,
  })}\n`,
  "utf8",
);
await rename(temporaryReadyFile, readyFile);

if (mode === "exit") {
  process.exit(1);
}

setInterval(() => {}, 1_000);
