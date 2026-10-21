import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_TEXT_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 32 * 1024;

export function truncateUtf8(
  value,
  maximumBytes = MAX_TEXT_DIAGNOSTIC_BYTES,
) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maximumBytes) {
    return value;
  }

  return (
    buffer.subarray(0, maximumBytes).toString("utf8") +
    `\n<!-- truncated after ${maximumBytes} bytes -->\n`
  );
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function serializedError(error) {
  return {
    cleanupError:
      error?.cleanupError === undefined
        ? undefined
        : truncateUtf8(String(error.cleanupError), MAX_ERROR_BYTES),
    message: truncateUtf8(error?.message || String(error), MAX_ERROR_BYTES),
    stack: truncateUtf8(error?.stack || String(error), MAX_ERROR_BYTES),
  };
}

export async function writeFailureDiagnostics({
  diagnosticsDirectory,
  driver,
  error,
  logPaths = {},
  metadata = {},
  scenario,
}) {
  const scenarioDirectory = resolve(diagnosticsDirectory, scenario);
  await rm(scenarioDirectory, { force: true, recursive: true });
  await mkdir(scenarioDirectory, { recursive: true });

  const diagnosticMetadata = {
    ...metadata,
    error: serializedError(error),
    gitRevision: gitRevision(),
    scenario,
    timestamp: new Date().toISOString(),
  };

  const capture = async (name, operation) => {
    try {
      await operation();
    } catch (captureError) {
      diagnosticMetadata[`${name}CaptureError`] = String(captureError);
    }
  };

  for (const [name, path] of Object.entries(logPaths)) {
    if (path === null || path === undefined) {
      continue;
    }
    await capture(`${name}Log`, async () => {
      const contents = await readFile(path, "utf8");
      await writeFile(
        resolve(scenarioDirectory, `${name}.log`),
        truncateUtf8(contents),
        "utf8",
      );
    });
  }

  if (driver !== undefined && driver !== null) {
    await capture("screenshot", async () => {
      const screenshot = await driver.takeScreenshot();
      await writeFile(
        resolve(scenarioDirectory, "screenshot.png"),
        screenshot,
        "base64",
      );
    });
    await capture("pageSource", async () => {
      const source = await driver.getPageSource();
      await writeFile(
        resolve(scenarioDirectory, "page-source.html"),
        truncateUtf8(source),
        "utf8",
      );
    });
    await capture("currentUrl", async () => {
      diagnosticMetadata.currentUrl = await driver.getCurrentUrl();
    });
    await capture("title", async () => {
      diagnosticMetadata.title = await driver.getTitle();
    });
  }

  const metadataPath = resolve(scenarioDirectory, "metadata.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify(diagnosticMetadata, null, 2)}\n`,
    "utf8",
  );
  console.error(`Selenium failure diagnostics: ${scenarioDirectory}`);
  return scenarioDirectory;
}
