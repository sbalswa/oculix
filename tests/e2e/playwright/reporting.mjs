import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(HARNESS_DIRECTORY, "../../..");
const DEFAULT_RESULTS_ROOT = resolve(HARNESS_DIRECTORY, "test-results");
const SCENARIOS = new Set(["smoke", "web-calculator"]);

export const ACCESSIBILITY_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

export const ACCESSIBILITY_POLICY = {
  automatedStandard: "WCAG 2.0, 2.1, and 2.2 Level A/AA",
  blocking: "any-violation",
  incomplete: "retained-nonblocking",
  tags: ACCESSIBILITY_TAGS,
};

function assertScenario(scenario) {
  if (!SCENARIOS.has(scenario)) {
    throw new Error(
      `Unknown Playwright scenario "${scenario}". ` +
        `Expected one of: ${[...SCENARIOS].join(", ")}.`,
    );
  }
  return scenario;
}

export function scenarioPaths(
  scenario,
  {
    repositoryRoot = DEFAULT_REPOSITORY_ROOT,
    resultsRoot = DEFAULT_RESULTS_ROOT,
  } = {},
) {
  assertScenario(scenario);
  const directory = resolve(resultsRoot, scenario);
  return {
    accessibility: resolve(directory, "accessibility.json"),
    accessibilitySummary: resolve(
      directory,
      "accessibility-summary.json",
    ),
    accessibilitySummaryMarkdown: resolve(
      directory,
      "accessibility-summary.md",
    ),
    artifacts: resolve(directory, "artifacts"),
    directory,
    finalScreenshot: resolve(directory, "final.png"),
    harnessDiagnostics: resolve(directory, "harness-diagnostics.json"),
    htmlReport: resolve(directory, "html-report"),
    legacyFinalScreenshot: resolve(resultsRoot, "web-calculator-result.png"),
    nativeJsonReport: resolve(directory, "playwright-report.json"),
    repositoryRoot,
    result: resolve(directory, "result.json"),
  };
}

export function repositoryRelativeArtifact(
  path,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
) {
  const normalizedRoot = resolve(repositoryRoot);
  const normalizedPath = resolve(path);
  const repositoryPath = relative(normalizedRoot, normalizedPath);
  if (
    repositoryPath === "" ||
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `Artifact path "${path}" must be inside repository "${repositoryRoot}".`,
    );
  }
  return repositoryPath.split(sep).join("/");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), {
    recursive: true,
  });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
  await rename(temporaryPath, path);
}

function finding(rule) {
  return {
    description: rule.description,
    help: rule.help,
    helpUrl: rule.helpUrl,
    id: rule.id,
    impact: rule.impact,
    nodes: rule.nodes.map((node) => ({
      failureSummary: node.failureSummary,
      html: node.html,
      impact: node.impact,
      target: node.target,
    })),
    tags: rule.tags,
  };
}

function findingCounts(findings) {
  return {
    nodes: findings.reduce(
      (total, item) => total + (item.nodes?.length ?? 0),
      0,
    ),
    rules: findings.length,
  };
}

export function normalizeAccessibilityResults(results) {
  const violations = results.violations.map(finding);
  const incomplete = results.incomplete.map(finding);
  const counts = {
    incomplete: findingCounts(incomplete),
    inapplicable: findingCounts(results.inapplicable),
    passes: findingCounts(results.passes),
    violations: findingCounts(violations),
  };
  return {
    counts,
    incomplete,
    policy: ACCESSIBILITY_POLICY,
    status: counts.violations.rules === 0 ? "passed" : "failed",
    testEngine: results.testEngine,
    testEnvironment: results.testEnvironment,
    testRunner: results.testRunner,
    timestamp: results.timestamp,
    url: results.url,
    violations,
  };
}

function markdownFindings(title, findings) {
  const lines = [`## ${title}`, ""];
  if (findings.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  for (const item of findings) {
    lines.push(
      `- \`${item.id}\` (${item.impact ?? "impact unknown"}): ` +
        `${item.help} — ${item.nodes.length} node(s)`,
    );
  }
  lines.push("");
  return lines;
}

function accessibilityMarkdown(summary) {
  return [
    "# Playwright accessibility audit",
    "",
    `- Status: **${summary.status}**`,
    `- Policy: ${summary.policy.automatedStandard}`,
    `- Violations: ${summary.counts.violations.rules} rule(s) / ` +
      `${summary.counts.violations.nodes} affected node(s) (blocking)`,
    `- Incomplete/manual review: ${summary.counts.incomplete.rules} ` +
      `rule(s) / ${summary.counts.incomplete.nodes} affected node(s) ` +
      "(nonblocking)",
    `- Passes: ${summary.counts.passes.rules} rule(s) / ` +
      `${summary.counts.passes.nodes} affected node(s)`,
    `- Inapplicable: ${summary.counts.inapplicable.rules} rule(s) / ` +
      `${summary.counts.inapplicable.nodes} affected node(s)`,
    "",
    ...markdownFindings("Violations", summary.violations),
    ...markdownFindings(
      "Incomplete findings requiring manual review",
      summary.incomplete,
    ),
    "Automated auditing supplements rather than replaces manual accessibility review.",
    "",
  ].join("\n");
}

export async function writeAccessibilityReports(
  scenario,
  results,
  options = {},
) {
  const paths = scenarioPaths(scenario, options);
  const summary = normalizeAccessibilityResults(results);
  await writeJson(paths.accessibility, results);
  await writeJson(paths.accessibilitySummary, summary);
  await writeFile(
    paths.accessibilitySummaryMarkdown,
    accessibilityMarkdown(summary),
  );
  return {
    paths,
    summary,
  };
}

export function enforceAccessibilityPolicy(summary) {
  if (summary.counts.violations.rules > 0) {
    throw new Error(
      `Accessibility audit found ${summary.counts.violations.rules} ` +
        "blocking violation rule(s) across " +
        `${summary.counts.violations.nodes} affected node(s); reports ` +
        "were written before this failure.",
    );
  }
}

function matrixOperatingSystem(operatingSystem) {
  const normalized = operatingSystem.trim().toLowerCase();
  if (normalized === "ubuntu" || normalized.startsWith("ubuntu-")) {
    return "ubuntu";
  }
  if (normalized === "macos" || normalized.startsWith("macos-")) {
    return "macos";
  }
  return normalized;
}

export function playwrightCapabilityId(operatingSystem, browser) {
  return [
    "playwright",
    matrixOperatingSystem(operatingSystem),
    browser.trim().toLowerCase(),
  ].join("-");
}

async function packageVersion(path) {
  return JSON.parse(await readFile(path, "utf8")).version;
}

export async function writeRuntimeMetadata({
  browserName,
  browserVersion,
  scenario,
  options = {},
}) {
  const paths = scenarioPaths(scenario, options);
  const metadataPath = resolve(paths.directory, "runtime.json");
  await writeJson(metadataPath, {
    arch: process.arch,
    browser: {
      name: browserName,
      project: process.env.PLAYWRIGHT_PROJECT ?? browserName,
      version: browserVersion,
    },
    operatingSystem: process.env.E2E_OS ?? process.platform,
    platform: process.platform,
    scenario,
    versions: {
      axe: await packageVersion(
        resolve(
          HARNESS_DIRECTORY,
          "node_modules/@axe-core/playwright/package.json",
        ),
      ),
      node: process.version,
      playwright: await packageVersion(
        resolve(
          HARNESS_DIRECTORY,
          "node_modules/@playwright/test/package.json",
        ),
      ),
    },
  });
  return metadataPath;
}

function artifactPath(path, repositoryRoot) {
  return repositoryRelativeArtifact(path, repositoryRoot);
}

function knownArtifacts(paths, scenario) {
  const artifacts = {
    htmlReport: artifactPath(
      resolve(paths.htmlReport, "index.html"),
      paths.repositoryRoot,
    ),
    nativeJsonReport: artifactPath(
      paths.nativeJsonReport,
      paths.repositoryRoot,
    ),
    result: artifactPath(paths.result, paths.repositoryRoot),
  };
  if (scenario === "web-calculator") {
    Object.assign(artifacts, {
      accessibility: artifactPath(
        paths.accessibility,
        paths.repositoryRoot,
      ),
      accessibilitySummary: artifactPath(
        paths.accessibilitySummary,
        paths.repositoryRoot,
      ),
      accessibilitySummaryMarkdown: artifactPath(
        paths.accessibilitySummaryMarkdown,
        paths.repositoryRoot,
      ),
      finalScreenshot: artifactPath(
        paths.finalScreenshot,
        paths.repositoryRoot,
      ),
    });
  }
  return artifacts;
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function errorDetails(errors) {
  return errors.map((error) => ({
    message: error.message,
    stack: error.stack,
  }));
}

export async function writePlaywrightResult({
  scenario,
  test,
  testResult,
  options = {},
}) {
  const paths = scenarioPaths(scenario, options);
  const runtime = await readJsonOrNull(
    resolve(paths.directory, "runtime.json"),
  );
  const accessibility = await readJsonOrNull(paths.accessibilitySummary);
  const environment = runtime ?? {
    arch: process.arch,
    browser: {
      name: process.env.PLAYWRIGHT_PROJECT ?? "unknown",
      project: process.env.PLAYWRIGHT_PROJECT ?? "unknown",
      version: null,
    },
    operatingSystem: process.env.E2E_OS ?? process.platform,
    platform: process.platform,
    versions: {
      axe: "4.14.0",
      node: process.version,
      playwright: "1.64.1",
    },
  };
  const startedAt = testResult.startTime;
  const completedAt = new Date(
    startedAt.getTime() + testResult.duration,
  );
  const attachments = testResult.attachments
    .filter((attachment) => attachment.path !== undefined)
    .map((attachment) => ({
      contentType: attachment.contentType,
      name: attachment.name,
      path: artifactPath(attachment.path, paths.repositoryRoot),
    }));
  const status =
    testResult.status === "passed" &&
    testResult.status === test.expectedStatus
      ? "passed"
      : testResult.status;
  const report = {
    schemaVersion: 1,
    capabilityId: playwrightCapabilityId(
      environment.operatingSystem,
      environment.browser.project,
    ),
    tool: "playwright",
    scenario,
    environment,
    status,
    timestamps: {
      completedAt: completedAt.toISOString(),
      durationMs: testResult.duration,
      startedAt: startedAt.toISOString(),
    },
    assertion: {
      errors: errorDetails(testResult.errors),
      expectedStatus: test.expectedStatus,
      status: status === "passed" ? "passed" : "failed",
    },
    accessibility:
      accessibility ?? {
        counts: null,
        policy: ACCESSIBILITY_POLICY,
        status: "not-run",
      },
    artifacts: {
      ...knownArtifacts(paths, scenario),
      attachments,
    },
  };
  await writeJson(paths.result, report);
  return report;
}

export async function writeHarnessFailureResult(
  scenario,
  {
    browser,
    error,
    operatingSystem,
    options = {},
  },
) {
  const paths = scenarioPaths(scenario, options);
  const existing = await readJsonOrNull(paths.result);
  const now = new Date();
  const report = existing ?? {
    schemaVersion: 1,
    capabilityId: playwrightCapabilityId(operatingSystem, browser),
    tool: "playwright",
    scenario,
    environment: {
      arch: process.arch,
      browser: {
        name: browser,
        project: browser,
        version: null,
      },
      operatingSystem,
      platform: process.platform,
      versions: {
        axe: "4.14.0",
        node: process.version,
        playwright: "1.64.1",
      },
    },
    timestamps: {
      completedAt: now.toISOString(),
      durationMs: 0,
      startedAt: now.toISOString(),
    },
    assertion: {
      errors: [],
      expectedStatus: "passed",
      status: "not-run",
    },
    accessibility: {
      counts: null,
      policy: ACCESSIBILITY_POLICY,
      status: "not-run",
    },
    artifacts: knownArtifacts(paths, scenario),
  };
  report.status = "failed";
  report.timestamps.completedAt = now.toISOString();
  report.timestamps.durationMs = Math.max(
    0,
    now.getTime() - Date.parse(report.timestamps.startedAt),
  );
  report.harness = {
    error: error.message,
    status: "failed",
  };
  report.artifacts.harnessDiagnostics = artifactPath(
    paths.harnessDiagnostics,
    paths.repositoryRoot,
  );
  await writeJson(paths.result, report);
  return report;
}
