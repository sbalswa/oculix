import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ACCESSIBILITY_POLICY } from "./accessibility-policy.mjs";

export { ACCESSIBILITY_POLICY } from "./accessibility-policy.mjs";

const SCHEMA_VERSION = 1;
const SCENARIOS = new Set(["smoke", "web-calculator"]);
const ACCESSIBILITY_FILE = "accessibility.json";
const ACCESSIBILITY_MARKDOWN_FILE = "accessibility.md";
const ASSERTION_FILE = "assertion.json";
const RUN_FILE = "run.json";

function assertScenario(scenario) {
  if (!SCENARIOS.has(scenario)) {
    throw new Error(`Unsupported Cypress report scenario "${scenario}"`);
  }
}

function countFindings(findings = []) {
  return {
    nodes: findings.reduce(
      (total, finding) => total + (finding.nodes?.length ?? 0),
      0,
    ),
    rules: findings.length,
  };
}

export function normalizeAccessibilityResult({
  durationMs,
  finishedAt,
  result,
  startedAt,
  state,
}) {
  if (!["final", "initial"].includes(state)) {
    throw new Error(`Unsupported accessibility state "${state}"`);
  }
  if (result === null || typeof result !== "object") {
    throw new TypeError("An axe result object is required");
  }

  return {
    counts: {
      incomplete: countFindings(result.incomplete),
      inapplicable: countFindings(result.inapplicable),
      passes: countFindings(result.passes),
      violations: countFindings(result.violations),
    },
    durationMs,
    finishedAt,
    result,
    startedAt,
    state,
    url: result.url ?? null,
  };
}

function totalCounts(audits) {
  const totals = {
    incomplete: { nodes: 0, rules: 0 },
    inapplicable: { nodes: 0, rules: 0 },
    passes: { nodes: 0, rules: 0 },
    violations: { nodes: 0, rules: 0 },
  };
  for (const audit of audits) {
    for (const category of Object.keys(totals)) {
      totals[category].nodes += audit.counts[category].nodes;
      totals[category].rules += audit.counts[category].rules;
    }
  }
  return totals;
}

export function evaluateAccessibilityPolicy(accessibility) {
  const counts = totalCounts(accessibility?.audits ?? []);
  const blocking =
    counts.violations.rules >=
    ACCESSIBILITY_POLICY.blockingViolationCount;
  return {
    blocking,
    counts,
    status:
      (accessibility?.audits?.length ?? 0) === 0
        ? "not-run"
        : blocking
          ? "failed"
          : "passed",
  };
}

export function toRepositoryRelativePath(path, repositoryRoot) {
  const repositoryRelative = relative(repositoryRoot, path);
  if (
    repositoryRelative === ".." ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error(`${path} is outside repository root ${repositoryRoot}`);
  }
  return repositoryRelative.split(sep).join("/");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJsonIfPresent(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeFileAtomically(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

async function writeJson(path, value) {
  await writeFileAtomically(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function accessibilityMarkdown(accessibility) {
  const evaluation = evaluateAccessibilityPolicy(accessibility);
  const rows = accessibility.audits
    .map(
      (audit) =>
        `| ${markdownCell(audit.state)} | ` +
        `${audit.counts.violations.rules} | ` +
        `${audit.counts.violations.nodes} | ` +
        `${audit.counts.incomplete.rules} | ` +
        `${audit.counts.incomplete.nodes} |`,
    )
    .join("\n");
  const findings = accessibility.audits.flatMap((audit) =>
    ["violations", "incomplete"].flatMap((category) =>
      (audit.result[category] ?? []).map(
        (finding) =>
          `| ${markdownCell(audit.state)} | ${category} | ` +
          `\`${markdownCell(finding.id)}\` | ` +
          `${markdownCell(finding.impact ?? "unknown")} | ` +
          `${finding.nodes?.length ?? 0} | ` +
          `${markdownCell(finding.help ?? "")} |`,
      ),
    ),
  );
  return `# Cypress accessibility report

- Scenario: \`${accessibility.scenario}\`
- axe-core: \`${accessibility.axeCoreVersion}\`
- Policy: WCAG 2.0/2.1/2.2 A and AA supported rules
- Automated violations: blocking
- Incomplete/manual-review findings: retained, nonblocking
- Status: **${evaluation.status}**

| State | Violation rules | Violation nodes | Incomplete rules | Incomplete nodes |
| --- | ---: | ---: | ---: | ---: |
${rows}

## Findings requiring attention

| State | Category | Rule | Impact | Nodes | Help |
| --- | --- | --- | --- | ---: | --- |
${findings.length === 0 ? "| - | - | - | - | 0 | None |" : findings.join("\n")}

Automated results supplement rather than replace manual accessibility review.
`;
}

export async function prepareScenarioDiagnostics(
  diagnosticsDirectory,
  scenario,
) {
  assertScenario(scenario);
  await mkdir(diagnosticsDirectory, { recursive: true });
  await rm(resolve(diagnosticsDirectory, scenario), {
    force: true,
    recursive: true,
  });
  await mkdir(resolve(diagnosticsDirectory, scenario), {
    recursive: true,
  });
}

export function createCypressReportingTasks({
  axeCoreVersion,
  axeSource,
  diagnosticsDirectory,
  scenario,
}) {
  assertScenario(scenario);
  const scenarioDirectory = resolve(diagnosticsDirectory, scenario);
  const accessibilityPath = resolve(
    scenarioDirectory,
    ACCESSIBILITY_FILE,
  );
  const accessibilityMarkdownPath = resolve(
    scenarioDirectory,
    ACCESSIBILITY_MARKDOWN_FILE,
  );
  const assertionPath = resolve(scenarioDirectory, ASSERTION_FILE);

  return {
    axeSource() {
      return axeSource;
    },

    async enforceAccessibility() {
      const accessibility = await readJsonIfPresent(accessibilityPath);
      return evaluateAccessibilityPolicy(accessibility);
    },

    async recordAccessibility(payload) {
      const audit = normalizeAccessibilityResult(payload);
      const existing = await readJsonIfPresent(accessibilityPath);
      const audits = (existing?.audits ?? []).filter(
        (candidate) => candidate.state !== audit.state,
      );
      audits.push(audit);
      audits.sort(
        (left, right) =>
          ["initial", "final"].indexOf(left.state) -
          ["initial", "final"].indexOf(right.state),
      );
      const accessibility = {
        audits,
        axeCoreVersion,
        policy: ACCESSIBILITY_POLICY,
        scenario,
        schemaVersion: SCHEMA_VERSION,
        tool: "cypress",
      };
      await writeJson(accessibilityPath, accessibility);
      await writeFileAtomically(
        accessibilityMarkdownPath,
        accessibilityMarkdown(accessibility),
      );
      return evaluateAccessibilityPolicy(accessibility);
    },

    async recordAssertion(assertion) {
      const normalized = {
        description: assertion.description,
        finishedAt: assertion.finishedAt,
        status: assertion.status,
      };
      await writeJson(assertionPath, normalized);
      return normalized;
    },
  };
}

async function collectFiles(directory) {
  if (!(await pathExists(directory))) {
    return [];
  }
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function resultFailed(result, error) {
  return Boolean(
    error ||
      result?.failures ||
      (result?.totalFailed ?? 0) > 0,
  );
}

function resultMessage(result, error) {
  if (error) {
    return error.stack ?? error.message ?? String(error);
  }
  return result?.message ?? null;
}

function browserDetails(selection, result) {
  return {
    name: result?.browserName ?? selection.browser,
    requested: selection.browser,
    selectionSource: selection.source,
    version: result?.browserVersion ?? null,
  };
}

function operatingSystemDetails(selection, result) {
  return {
    distribution: selection.hostDistribution,
    hostPlatform: selection.hostPlatform,
    name: result?.osName ?? selection.operatingSystem,
    requested: selection.operatingSystem,
    selectionSource: selection.operatingSystemSource,
    version: result?.osVersion ?? null,
  };
}

function matrixCapabilityId(selection) {
  return [
    "cypress",
    selection.operatingSystem,
    selection.browser,
  ].join("-");
}

async function artifactPaths({
  diagnosticsDirectory,
  repositoryRoot,
  scenario,
}) {
  const scenarioDirectory = resolve(diagnosticsDirectory, scenario);
  const files = await collectFiles(scenarioDirectory);
  const relativeFiles = files.map((path) =>
    toRepositoryRelativePath(path, repositoryRoot),
  );
  const prefix = toRepositoryRelativePath(
    scenarioDirectory,
    repositoryRoot,
  );
  const relative = (name) => `${prefix}/${name}`;
  return {
    accessibilityJson: relativeFiles.includes(
      relative(ACCESSIBILITY_FILE),
    )
      ? relative(ACCESSIBILITY_FILE)
      : null,
    accessibilityMarkdown: relativeFiles.includes(
      relative(ACCESSIBILITY_MARKDOWN_FILE),
    )
      ? relative(ACCESSIBILITY_MARKDOWN_FILE)
      : null,
    assertion: relativeFiles.includes(relative(ASSERTION_FILE))
      ? relative(ASSERTION_FILE)
      : null,
    runJson: relative(RUN_FILE),
    screenshots: relativeFiles.filter((path) =>
      path.includes("/screenshots/"),
    ),
    videos: relativeFiles.filter((path) => path.includes("/videos/")),
  };
}

export async function writeScenarioResult({
  axeCoreVersion,
  cypressVersion,
  diagnosticsDirectory,
  error,
  finishedAt,
  repositoryRoot,
  result,
  selection,
  startedAt,
}) {
  const scenarioDirectory = resolve(
    diagnosticsDirectory,
    selection.scenario,
  );
  await mkdir(scenarioDirectory, { recursive: true });
  const accessibility =
    (await readJsonIfPresent(
      resolve(scenarioDirectory, ACCESSIBILITY_FILE),
    )) ?? {
      audits: [],
      axeCoreVersion,
      policy: ACCESSIBILITY_POLICY,
      scenario: selection.scenario,
      schemaVersion: SCHEMA_VERSION,
      tool: "cypress",
    };
  const accessibilityEvaluation =
    evaluateAccessibilityPolicy(accessibility);
  const recordedAssertion = await readJsonIfPresent(
    resolve(scenarioDirectory, ASSERTION_FILE),
  );
  const failed = resultFailed(result, error);
  const assertion =
    recordedAssertion ??
    (result === undefined
      ? {
          description: null,
          finishedAt: null,
          status: "not-run",
        }
      : {
          description: "Cypress scenario assertions",
          finishedAt,
          status: failed ? "failed" : "passed",
        });
  const report = {
    accessibility: {
      ...accessibilityEvaluation,
      audits: accessibility.audits.map((audit) => audit.state),
      policy: ACCESSIBILITY_POLICY,
    },
    artifacts: await artifactPaths({
      diagnosticsDirectory,
      repositoryRoot,
      scenario: selection.scenario,
    }),
    assertion,
    browser: browserDetails(selection, result),
    capabilityId: matrixCapabilityId(selection),
    error: resultMessage(result, error),
    operatingSystem: operatingSystemDetails(selection, result),
    scenario: selection.scenario,
    schemaVersion: SCHEMA_VERSION,
    status: failed ? "failed" : "passed",
    timestamps: {
      durationMs:
        new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      finishedAt,
      startedAt,
    },
    tool: {
      name: "cypress",
      version: cypressVersion,
    },
    versions: {
      axeCore: axeCoreVersion,
      node: process.version,
    },
  };
  await writeJson(resolve(scenarioDirectory, RUN_FILE), report);
  await writeAggregateSummary({
    diagnosticsDirectory,
    repositoryRoot,
  });
  return report;
}

function summaryMarkdown(summary) {
  const rows = summary.scenarios
    .map(
      (scenario) =>
        `| \`${markdownCell(scenario.capabilityId)}\` | ` +
        `${markdownCell(scenario.scenario)} | ` +
        `${scenario.status} | ${scenario.assertionStatus} | ` +
        `${scenario.accessibilityStatus} | ` +
        `${scenario.violationRules} | ${scenario.incompleteRules} | ` +
        `\`${scenario.runJson}\` |`,
    )
    .join("\n");
  return `# Cypress E2E summary

- Capability: \`${summary.capabilityId ?? "mixed"}\`

| Capability | Scenario | Status | Assertion | Accessibility | Violations | Incomplete | Report |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
${rows}
`;
}

export async function writeAggregateSummary({
  diagnosticsDirectory,
  repositoryRoot,
}) {
  const scenarios = [];
  for (const scenario of [...SCENARIOS].sort()) {
    const runPath = resolve(diagnosticsDirectory, scenario, RUN_FILE);
    const run = await readJsonIfPresent(runPath);
    if (run === null) {
      continue;
    }
    scenarios.push({
      accessibilityStatus: run.accessibility.status,
      assertionStatus: run.assertion.status,
      capabilityId: run.capabilityId,
      incompleteRules: run.accessibility.counts.incomplete.rules,
      runJson: toRepositoryRelativePath(runPath, repositoryRoot),
      scenario: run.scenario,
      status: run.status,
      violationRules: run.accessibility.counts.violations.rules,
    });
  }
  const capabilityIds = [
    ...new Set(scenarios.map((scenario) => scenario.capabilityId)),
  ];
  const summary = {
    capabilityId: capabilityIds.length === 1 ? capabilityIds[0] : null,
    generatedAt: new Date().toISOString(),
    scenarios,
    schemaVersion: SCHEMA_VERSION,
    status: scenarios.some((scenario) => scenario.status === "failed")
      ? "failed"
      : "passed",
    tool: "cypress",
  };
  await writeJson(resolve(diagnosticsDirectory, "summary.json"), summary);
  await writeFileAtomically(
    resolve(diagnosticsDirectory, "summary.md"),
    summaryMarkdown(summary),
  );
  return summary;
}
