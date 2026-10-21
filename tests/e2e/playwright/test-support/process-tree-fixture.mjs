import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

const [pidFile, mode] = process.argv.slice(2);
if (pidFile === undefined) {
  throw new Error("PID file argument is required");
}

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
const temporaryPidFile = `${pidFile}.${process.pid}.tmp`;
await writeFile(
  temporaryPidFile,
  `${JSON.stringify({
    descendant: descendant.pid,
    parent: process.pid,
  })}\n`,
);
await rename(temporaryPidFile, pidFile);
if (mode === "exit") {
  setTimeout(() => {
    process.exit(1);
  }, 50);
} else {
  setInterval(() => {}, 1_000);
}
