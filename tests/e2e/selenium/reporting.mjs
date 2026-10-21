import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  ACCESSIBILITY_POLICY,
  accessibilityOutcome,
} from "./accessibility.mjs";
import {
  DIAGNOSTICS_DIRECTORY,
  HARNESS_DIRECTORY,
} from "./runtime.mjs";

const REPOSITORY_DIRECTORY = resolve(HARNESS_DIRECTORY, "../../..");
const RESULT_SCHEMA_VERSION = 1;

function serializedError(error) {
  if (error === null || error === undefined) {
    return null;
  }
  return {
    message: error?.message || String(error),
    stack: error?.stack || String(error),
  };
}

export function repositoryRelativePath(
  path,
  repositoryDirectory = REPOSITORY_DIRECTORY,
) {
  const repositoryPath = relative(repositoryDirectory, resolve(path));
  if (
    repositoryPath === "" ||
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Artifact path is outside the repository: ${path}`);
  }
  return repositoryPath.split(sep).join("/");
}

async function dependencyVersions() {
  const packageJson = JSON.parse(
    await readFile(resolve(HARNESS_DIRECTORY, "package.json"), "utf8"),
  );
  return {
    axeWebdriver: packageJson.dependencies["@axe-core/webdriverjs"],
    selenium: packageJson.dependencies["selenium-webdriver"],
  };
}

async function existingArtifactPath(path, repositoryDirectory) {
  try {
    await access(path);
    return repositoryRelativePath(path, repositoryDirectory);
  } catch {
    return null;
  }
}

export async function createScenarioReporter({
  clock = () => new Date(),
  diagnosticsDirectory = DIAGNOSTICS_DIRECTORY,
  repositoryDirectory = REPOSITORY_DIRECTORY,
  scenario,
} = {}) {
  const directory = resolve(diagnosticsDirectory, scenario);
  const paths = {
    accessibility: resolve(directory, "accessibility.json"),
    failureMetadata: resolve(directory, "metadata.json"),
    failureScreenshot: resolve(directory, "screenshot.png"),
    pageSource: resolve(directory, "page-source.html"),
    result: resolve(directory, "result.json"),
    screenshot: resolve(directory, "result.png"),
  };
  const started = clock();
  const versions = await dependencyVersions();
  const state = {
    accessibility: {
      counts: null,
      engineVersion: null,
      policy: ACCESSIBILITY_POLICY,
      status: "not-run",
    },
    assertion: {
      actual: null,
      expected: "238",
      name: "web-calculator final display",
      status: "not-run",
    },
    capability: {
      browser: process.env.E2E_BROWSER ?? "chrome",
      id: null,
      os: process.env.E2E_OS ?? null,
    },
    environment: {
      browserName: null,
      browserVersion: null,
      driverVersion: null,
      hostDistribution: null,
      hostPlatform: process.platform,
      nodeVersion: process.version,
      platformName: null,
    },
    failure: null,
    scenario,
    status: "running",
  };

  const reporter = {
    directory,
    paths,

    recordAccessibility(results) {
      const outcome = accessibilityOutcome(results);
      state.accessibility = {
        counts: outcome.counts,
        engineVersion: results.testEngine?.version ?? null,
        policy: ACCESSIBILITY_POLICY,
        status: outcome.status,
      };
      if (outcome.blocking) {
        state.status = "failed";
      }
      return outcome;
    },

    recordAccessibilityError(error) {
      state.accessibility = {
        counts: null,
        engineVersion: null,
        error: serializedError(error),
        policy: ACCESSIBILITY_POLICY,
        status: "error",
      };
      state.status = "failed";
    },

    recordAssertion({ actual = null, status }) {
      state.assertion = {
        ...state.assertion,
        actual,
        status,
      };
      if (status === "failed") {
        state.status = "failed";
      }
    },

    recordFailure(phase, error) {
      if (state.failure === null) {
        state.failure = {
          cleanupError: null,
          error: serializedError(error),
          phase,
        };
      } else if (phase === "cleanup") {
        state.failure.cleanupError = serializedError(error);
      }
      state.status = "failed";
    },

    recordMetadata(metadata = {}) {
      const browser = metadata.browser ?? state.capability.browser;
      const os = metadata.os ?? state.capability.os;
      state.capability = {
        browser,
        id: os === null ? null : `${os}-${browser}`,
        os,
      };
      state.environment = {
        browserName: metadata.browserName ?? null,
        browserVersion: metadata.browserVersion ?? null,
        driverVersion: metadata.driverVersion ?? null,
        hostDistribution: metadata.hostDistribution ?? null,
        hostPlatform: metadata.hostPlatform ?? process.platform,
        nodeVersion: metadata.nodeVersion ?? process.version,
        platformName: metadata.platformName ?? null,
      };
    },

    async write({ status } = {}) {
      if (status !== undefined) {
        state.status = status;
      }
      const finished = clock();
      const artifacts = {
        accessibility: await existingArtifactPath(
          paths.accessibility,
          repositoryDirectory,
        ),
        failureMetadata: await existingArtifactPath(
          paths.failureMetadata,
          repositoryDirectory,
        ),
        failureScreenshot: await existingArtifactPath(
          paths.failureScreenshot,
          repositoryDirectory,
        ),
        pageSource: await existingArtifactPath(
          paths.pageSource,
          repositoryDirectory,
        ),
        result: repositoryRelativePath(
          paths.result,
          repositoryDirectory,
        ),
        screenshot: await existingArtifactPath(
          paths.screenshot,
          repositoryDirectory,
        ),
      };
      const result = {
        schemaVersion: RESULT_SCHEMA_VERSION,
        capability: state.capability,
        tool: {
          accessibility: {
            engine: "axe-core",
            engineVersion: state.accessibility.engineVersion,
            integration: "@axe-core/webdriverjs",
            integrationVersion: versions.axeWebdriver,
          },
          name: "selenium",
          version: versions.selenium,
        },
        scenario: state.scenario,
        environment: state.environment,
        status: state.status,
        timestamps: {
          durationMs: Math.max(0, finished.getTime() - started.getTime()),
          finishedAt: finished.toISOString(),
          startedAt: started.toISOString(),
        },
        assertion: state.assertion,
        accessibility: state.accessibility,
        artifacts,
        failure: state.failure,
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        paths.result,
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
      return result;
    },
  };

  return reporter;
}
