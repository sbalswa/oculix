import { fileURLToPath } from "node:url";
import {
  ProcessStoppedError,
  runProcess,
  signalExitCode,
} from "../process-runner.mjs";

const [pidFile] = process.argv.slice(2);
if (pidFile === undefined) {
  throw new Error("PID file argument is required");
}

try {
  await runProcess(process.execPath, [
    fileURLToPath(new URL("process-tree-fixture.mjs", import.meta.url)),
    pidFile,
  ]);
} catch (error) {
  if (
    error instanceof ProcessStoppedError &&
    error.reason.kind === "signal"
  ) {
    process.exitCode = signalExitCode(error.reason.signal);
  } else {
    throw error;
  }
}
