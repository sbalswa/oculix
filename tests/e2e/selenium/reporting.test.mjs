import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ACCESSIBILITY_TAGS,
  accessibilityOutcome,
  enforceAccessibilityPolicy,
  normalizeAccessibilityResults,
} from "./accessibility.mjs";
import { writeFailureDiagnostics } from "./diagnostics.mjs";
import {
  createScenarioReporter,
  repositoryRelativePath,
} from "./reporting.mjs";

function axeResults({
  incomplete = [],
  inapplicable = [],
  passes = [],
  violations = [],
} = {}) {
  return { incomplete, inapplicable, passes, violations };
}

test("uses supported WCAG 2.0, 2.1, and 2.2 A/AA tags", () => {
  assert.deepEqual(ACCESSIBILITY_TAGS, [
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22a",
    "wcag22aa",
  ]);
});

test("normalizes rule and node counts", () => {
  assert.deepEqual(
    normalizeAccessibilityResults(
      axeResults({
        incomplete: [{ nodes: [{}, {}] }],
        inapplicable: [{ nodes: [] }, { nodes: [] }],
        passes: [{ nodes: [{}] }],
        violations: [{ nodes: [{}, {}, {}] }, { nodes: [{}] }],
      }),
    ),
    {
      inapplicable: 2,
      incomplete: 1,
      incompleteNodes: 2,
      passes: 1,
      violations: 2,
      violationNodes: 4,
    },
  );
});

test("any violation is blocking", () => {
  const results = axeResults({
    violations: [{ id: "color-contrast", nodes: [{}] }],
  });

  assert.equal(accessibilityOutcome(results).status, "failed");
  assert.throws(
    () => enforceAccessibilityPolicy(results),
    /1 violation rules across 1 nodes/,
  );
});

test("incomplete findings are retained and nonblocking", () => {
  const results = axeResults({
    incomplete: [{ id: "aria-prohibited-attr", nodes: [{}, {}] }],
  });

  const outcome = enforceAccessibilityPolicy(results);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.counts.incomplete, 1);
  assert.equal(outcome.counts.incompleteNodes, 2);
});

test("normalizes repository-relative artifact paths", () => {
  const repository = resolve("/tmp", "repository");
  const artifact = resolve(
    repository,
    "tests",
    "e2e",
    "selenium",
    "diagnostics",
    "result.json",
  );

  assert.equal(
    repositoryRelativePath(artifact, repository),
    "tests/e2e/selenium/diagnostics/result.json",
  );
  assert.throws(
    () => repositoryRelativePath("/tmp/outside.json", repository),
    /outside the repository/,
  );
});

test("writes the schema-versioned result contract and artifact paths", async () => {
  const repository = await mkdtemp(join(tmpdir(), "selenium-report-"));
  const diagnosticsDirectory = join(
    repository,
    "tests",
    "e2e",
    "selenium",
    "diagnostics",
  );
  const times = [
    new Date("2026-10-21T10:00:00.000Z"),
    new Date("2026-10-21T10:00:01.250Z"),
  ];

  try {
    const reporter = await createScenarioReporter({
      clock: () => times.shift(),
      diagnosticsDirectory,
      repositoryDirectory: repository,
      scenario: "web-calculator",
    });
    reporter.recordMetadata({
      browser: "chromium",
      browserName: "chrome",
      browserVersion: "141.0.0.0",
      driverVersion: "141.0.0.0",
      hostDistribution: "ubuntu",
      hostPlatform: "linux",
      nodeVersion: "v24.10.0",
      os: "ubuntu",
      platformName: "linux",
    });
    reporter.recordAssertion({ actual: "238", status: "passed" });
    const accessibilityResults = {
      ...axeResults({ incomplete: [{ nodes: [{}] }] }),
      testEngine: { version: "4.14.0" },
    };
    await mkdir(reporter.directory, { recursive: true });
    await writeFile(reporter.paths.accessibility, "{}\n");
    await writeFile(reporter.paths.screenshot, "screenshot");
    reporter.recordAccessibility(accessibilityResults);

    const result = await reporter.write({ status: "passed" });

    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.capability, {
      browser: "chromium",
      id: "ubuntu-chromium",
      os: "ubuntu",
    });
    assert.equal(result.tool.name, "selenium");
    assert.equal(
      result.tool.accessibility.integration,
      "@axe-core/webdriverjs",
    );
    assert.equal(result.scenario, "web-calculator");
    assert.equal(result.status, "passed");
    assert.deepEqual(result.timestamps, {
      durationMs: 1250,
      finishedAt: "2026-10-21T10:00:01.250Z",
      startedAt: "2026-10-21T10:00:00.000Z",
    });
    assert.equal(result.assertion.status, "passed");
    assert.equal(result.accessibility.counts.incomplete, 1);
    assert.equal(result.accessibility.status, "passed");
    assert.equal(
      result.artifacts.accessibility,
      "tests/e2e/selenium/diagnostics/web-calculator/accessibility.json",
    );
    assert.equal(
      result.artifacts.result,
      "tests/e2e/selenium/diagnostics/web-calculator/result.json",
    );
    assert.equal(
      result.artifacts.screenshot,
      "tests/e2e/selenium/diagnostics/web-calculator/result.png",
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("failure diagnostics preserve reports and result evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selenium-preserve-"));
  const scenarioDirectory = join(directory, "web-calculator");
  await mkdir(scenarioDirectory, { recursive: true });
  await writeFile(
    join(scenarioDirectory, "accessibility.json"),
    '{"violations":[]}\n',
  );
  await writeFile(
    join(scenarioDirectory, "result.json"),
    '{"status":"failed"}\n',
  );
  await writeFile(join(scenarioDirectory, "result.png"), "screenshot");

  try {
    await writeFailureDiagnostics({
      diagnosticsDirectory: directory,
      error: new Error("accessibility failure"),
      scenario: "web-calculator",
    });

    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(scenarioDirectory, "accessibility.json"),
          "utf8",
        ),
      ),
      { violations: [] },
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(scenarioDirectory, "result.json"), "utf8"),
      ),
      { status: "failed" },
    );
    assert.equal(
      await readFile(join(scenarioDirectory, "result.png"), "utf8"),
      "screenshot",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
