import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import axe from "axe-core";

import { ACCESSIBILITY_POLICY } from "./accessibility-policy.mjs";
import {
  createCypressReportingTasks,
  evaluateAccessibilityPolicy,
  normalizeAccessibilityResult,
  prepareScenarioDiagnostics,
  toRepositoryRelativePath,
  writeScenarioResult,
} from "./reporting.mjs";

const PACKAGE_JSON = resolve(import.meta.dirname, "package.json");

function axeResult({
  incomplete = [],
  violations = [],
} = {}) {
  return {
    incomplete,
    inapplicable: [],
    passes: [
      {
        id: "document-title",
        nodes: [{ target: ["html"] }],
      },
    ],
    testEngine: { name: "axe-core", version: "4.14.0" },
    url: "http://127.0.0.1/",
    violations,
  };
}

function audit(state, result) {
  return normalizeAccessibilityResult({
    durationMs: 25,
    finishedAt: "2026-10-21T12:00:00.025Z",
    result,
    startedAt: "2026-10-21T12:00:00.000Z",
    state,
  });
}

function selection(scenario) {
  return {
    browser: "chrome",
    hostDistribution: "ubuntu",
    hostPlatform: "linux",
    operatingSystem: "ubuntu",
    operatingSystemSource: "E2E_OS",
    scenario,
    source: "E2E_BROWSER",
  };
}

function cypressResult() {
  return {
    browserName: "chrome",
    browserVersion: "141.0.0",
    failures: 0,
    osName: "linux",
    osVersion: "Ubuntu 24.04",
    totalFailed: 0,
  };
}

test("normalizes complete axe findings and node counts", () => {
  const result = axeResult({
    incomplete: [
      {
        id: "color-contrast",
        nodes: [{ target: [".one"] }, { target: [".two"] }],
      },
    ],
    violations: [
      {
        id: "button-name",
        nodes: [{ target: ["button"] }],
      },
    ],
  });

  const normalized = audit("initial", result);

  assert.equal(normalized.result, result);
  assert.deepEqual(normalized.counts.violations, {
    nodes: 1,
    rules: 1,
  });
  assert.deepEqual(normalized.counts.incomplete, {
    nodes: 2,
    rules: 1,
  });
});

test("the pinned axe version supports every configured WCAG tag", () => {
  for (const tag of ACCESSIBILITY_POLICY.tags) {
    assert.ok(
      axe.getRules([tag]).length > 0,
      `expected axe-core to support ${tag}`,
    );
  }
});

test("pins axe-core directly without a cypress-axe peer override", async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));

  assert.equal(packageJson.dependencies["axe-core"], "4.14.0");
  assert.equal(packageJson.dependencies["cypress-axe"], undefined);
  assert.equal(packageJson.overrides, undefined);
});

test("blocks every violation after normalization", () => {
  const accessibility = {
    audits: [
      audit(
        "final",
        axeResult({
          violations: [
            {
              id: "html-has-lang",
              nodes: [{ target: ["html"] }],
            },
          ],
        }),
      ),
    ],
  };

  assert.deepEqual(evaluateAccessibilityPolicy(accessibility), {
    blocking: true,
    counts: {
      incomplete: { nodes: 0, rules: 0 },
      inapplicable: { nodes: 0, rules: 0 },
      passes: { nodes: 1, rules: 1 },
      violations: { nodes: 1, rules: 1 },
    },
    status: "failed",
  });
});

test("retains incomplete findings without making them blocking", () => {
  const accessibility = {
    audits: [
      audit(
        "final",
        axeResult({
          incomplete: [
            {
              id: "color-contrast",
              nodes: [{ target: [".result"] }],
            },
          ],
        }),
      ),
    ],
  };
  const evaluation = evaluateAccessibilityPolicy(accessibility);

  assert.equal(evaluation.blocking, false);
  assert.equal(evaluation.status, "passed");
  assert.deepEqual(evaluation.counts.incomplete, {
    nodes: 1,
    rules: 1,
  });
});

test("normalizes repository paths and rejects outside artifacts", () => {
  const root = resolve("/tmp/example-repository");

  assert.equal(
    toRepositoryRelativePath(
      resolve(root, "tests/e2e/cypress/diagnostics/run.json"),
      root,
    ),
    "tests/e2e/cypress/diagnostics/run.json",
  );
  assert.throws(
    () =>
      toRepositoryRelativePath(
        resolve(root, "../outside/report.json"),
        root,
      ),
    /outside repository root/,
  );
});

test("writes accessibility reports before returning a blocking result", async () => {
  const root = await mkdtemp(join(tmpdir(), "cypress-reports-"));
  const diagnostics = resolve(root, "diagnostics");
  const tasks = createCypressReportingTasks({
    axeCoreVersion: "4.14.0",
    diagnosticsDirectory: diagnostics,
    scenario: "web-calculator",
  });

  try {
    await tasks.recordAccessibility({
      durationMs: 10,
      finishedAt: "2026-10-21T12:00:00.010Z",
      result: axeResult({
        violations: [
          {
            id: "button-name",
            nodes: [{ target: ["button"] }],
          },
        ],
      }),
      startedAt: "2026-10-21T12:00:00.000Z",
      state: "initial",
    });
    const evaluation = await tasks.enforceAccessibility();

    assert.equal(evaluation.blocking, true);
    assert.match(
      await readFile(
        resolve(
          diagnostics,
          "web-calculator",
          "accessibility.json",
        ),
        "utf8",
      ),
      /"button-name"/,
    );
    assert.match(
      await readFile(
        resolve(
          diagnostics,
          "web-calculator",
          "accessibility.md",
        ),
        "utf8",
      ),
      /Incomplete\/manual-review findings: retained, nonblocking/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("scenario cleanup and summaries retain sequential results", async () => {
  const root = await mkdtemp(join(tmpdir(), "cypress-retention-"));
  const diagnostics = resolve(
    root,
    "tests/e2e/cypress/diagnostics",
  );
  const startedAt = "2026-10-21T12:00:00.000Z";
  const finishedAt = "2026-10-21T12:00:01.000Z";

  try {
    await prepareScenarioDiagnostics(diagnostics, "smoke");
    await writeFile(
      resolve(diagnostics, "smoke", "retained.txt"),
      "smoke evidence\n",
      "utf8",
    );
    await writeScenarioResult({
      axeCoreVersion: "4.14.0",
      cypressVersion: "16.2.0",
      diagnosticsDirectory: diagnostics,
      finishedAt,
      repositoryRoot: root,
      result: cypressResult(),
      selection: selection("smoke"),
      startedAt,
    });

    await prepareScenarioDiagnostics(diagnostics, "web-calculator");
    await writeScenarioResult({
      axeCoreVersion: "4.14.0",
      cypressVersion: "16.2.0",
      diagnosticsDirectory: diagnostics,
      finishedAt,
      repositoryRoot: root,
      result: cypressResult(),
      selection: selection("web-calculator"),
      startedAt,
    });

    assert.equal(
      await readFile(
        resolve(diagnostics, "smoke", "retained.txt"),
        "utf8",
      ),
      "smoke evidence\n",
    );
    const summary = JSON.parse(
      await readFile(resolve(diagnostics, "summary.json"), "utf8"),
    );
    assert.deepEqual(
      summary.scenarios.map((scenario) => scenario.scenario),
      ["smoke", "web-calculator"],
    );
    const calculatorRun = JSON.parse(
      await readFile(
        resolve(diagnostics, "web-calculator", "run.json"),
        "utf8",
      ),
    );
    assert.equal(calculatorRun.capabilityId, "web-calculator");
    assert.equal(calculatorRun.tool.version, "16.2.0");
    assert.equal(
      calculatorRun.artifacts.runJson,
      "tests/e2e/cypress/diagnostics/web-calculator/run.json",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
