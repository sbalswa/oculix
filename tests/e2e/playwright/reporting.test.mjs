import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ACCESSIBILITY_POLICY,
  enforceAccessibilityPolicy,
  normalizeAccessibilityResults,
  playwrightCapabilityId,
  repositoryRelativeArtifact,
  scenarioPaths,
  writeAccessibilityReports,
  writeHarnessFailureResult,
  writePlaywrightResult,
} from "./reporting.mjs";

function axeResults({
  incomplete = [],
  violations = [],
} = {}) {
  return {
    incomplete,
    inapplicable: [
      {
        id: "inapplicable",
        nodes: [{}],
      },
    ],
    passes: [
      {
        id: "passed",
        nodes: [{}, {}],
      },
      {
        id: "also-passed",
        nodes: [{}],
      },
    ],
    testEngine: {
      name: "axe-core",
      version: "4.14.0",
    },
    testEnvironment: {
      orientationAngle: 0,
    },
    testRunner: {
      name: "axe",
    },
    timestamp: "2026-10-21T00:00:00.000Z",
    url: "http://127.0.0.1/",
    violations,
  };
}

function rule(id, impact = "serious", nodes = 1) {
  return {
    description: `${id} description`,
    help: `${id} help`,
    helpUrl: `https://example.invalid/${id}`,
    id,
    impact,
    nodes: Array.from({ length: nodes }, (_, index) => ({
      failureSummary: `${id} failure`,
      html: `<button data-index="${index}">example</button>`,
      impact,
      target: [`button:nth-of-type(${index + 1})`],
    })),
    tags: ["wcag2a"],
  };
}

test("normalizes axe findings and stable policy counts", () => {
  const summary = normalizeAccessibilityResults(
    axeResults({
      incomplete: [rule("manual-review", "moderate", 2)],
      violations: [
        rule("blocking", "serious", 3),
        rule("also-blocking", "critical", 1),
      ],
    }),
  );

  assert.deepEqual(summary.counts, {
    incomplete: {
      nodes: 2,
      rules: 1,
    },
    inapplicable: {
      nodes: 1,
      rules: 1,
    },
    passes: {
      nodes: 3,
      rules: 2,
    },
    violations: {
      nodes: 4,
      rules: 2,
    },
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.policy, ACCESSIBILITY_POLICY);
  assert.equal(
    summary.violations[0].nodes[0].target[0],
    "button:nth-of-type(1)",
  );
});

test("writes accessibility reports before enforcing violations", async () => {
  const repositoryRoot = await mkdtemp(
    resolve(tmpdir(), "oculix-playwright-accessibility-"),
  );
  const resultsRoot = resolve(repositoryRoot, "results");
  const options = {
    repositoryRoot,
    resultsRoot,
  };
  try {
    const { paths, summary } = await writeAccessibilityReports(
      "web-calculator",
      axeResults({
        violations: [rule("blocking", "serious", 3)],
      }),
      options,
    );
    assert.throws(
      () => enforceAccessibilityPolicy(summary),
      /1 blocking violation rule\(s\) across 3 affected node\(s\).*reports were written before this failure/,
    );
    assert.equal(
      JSON.parse(await readFile(paths.accessibility, "utf8"))
        .violations[0].id,
      "blocking",
    );
    assert.equal(
      JSON.parse(await readFile(paths.accessibilitySummary, "utf8"))
        .status,
      "failed",
    );
    const markdown = await readFile(
      paths.accessibilitySummaryMarkdown,
      "utf8",
    );
    assert.match(
      markdown,
      /Violations: 1 rule\(s\) \/ 3 affected node\(s\) \(blocking\)/,
    );
    assert.match(
      markdown,
      /Incomplete\/manual review: 0 rule\(s\) \/ 0 affected node\(s\)/,
    );
  } finally {
    await rm(repositoryRoot, {
      force: true,
      recursive: true,
    });
  }
});

test("incomplete findings remain nonblocking and visible", () => {
  const summary = normalizeAccessibilityResults(
    axeResults({
      incomplete: [rule("manual-review")],
    }),
  );
  assert.equal(summary.status, "passed");
  assert.deepEqual(summary.counts.incomplete, {
    nodes: 1,
    rules: 1,
  });
  assert.doesNotThrow(() => enforceAccessibilityPolicy(summary));
});

test("builds the stable matrix capability identity", () => {
  assert.equal(
    playwrightCapabilityId("ubuntu", "chromium"),
    "playwright-ubuntu-chromium",
  );
  assert.equal(
    playwrightCapabilityId("ubuntu-latest", "chromium"),
    "playwright-ubuntu-chromium",
  );
  assert.equal(
    playwrightCapabilityId("ubuntu-24.04", "chromium"),
    "playwright-ubuntu-chromium",
  );
});

test("normalizes repository artifact paths and rejects escapes", () => {
  const repositoryRoot = resolve("/tmp", "oculix");
  assert.equal(
    repositoryRelativeArtifact(
      resolve(repositoryRoot, "tests/e2e/playwright/result.json"),
      repositoryRoot,
    ),
    "tests/e2e/playwright/result.json",
  );
  assert.throws(
    () =>
      repositoryRelativeArtifact(
        resolve(repositoryRoot, "../outside.json"),
        repositoryRoot,
      ),
    /must be inside repository/,
  );
});

test("sequential scenario failures retain separate result reports", async () => {
  const repositoryRoot = await mkdtemp(
    resolve(tmpdir(), "oculix-playwright-reporting-"),
  );
  const resultsRoot = resolve(
    repositoryRoot,
    "tests/e2e/playwright/test-results",
  );
  const options = {
    repositoryRoot,
    resultsRoot,
  };
  try {
    await writeHarnessFailureResult("smoke", {
      browser: "chromium",
      error: new Error("smoke failed"),
      operatingSystem: "ubuntu",
      options,
    });
    await writeHarnessFailureResult("web-calculator", {
      browser: "chromium",
      error: new Error("calculator failed"),
      operatingSystem: "ubuntu",
      options,
    });

    const smoke = JSON.parse(
      await readFile(scenarioPaths("smoke", options).result, "utf8"),
    );
    const calculator = JSON.parse(
      await readFile(
        scenarioPaths("web-calculator", options).result,
        "utf8",
      ),
    );
    assert.equal(smoke.harness.error, "smoke failed");
    assert.equal(calculator.harness.error, "calculator failed");
    assert.equal(smoke.capabilityId, "playwright-ubuntu-chromium");
    assert.equal(
      calculator.capabilityId,
      "playwright-ubuntu-chromium",
    );
    assert.equal(smoke.scenario, "smoke");
    assert.equal(calculator.scenario, "web-calculator");
  } finally {
    await rm(repositoryRoot, {
      force: true,
      recursive: true,
    });
  }
});

test("writes the stable scenario result schema", async () => {
  const repositoryRoot = await mkdtemp(
    resolve(tmpdir(), "oculix-playwright-schema-"),
  );
  const resultsRoot = resolve(
    repositoryRoot,
    "tests/e2e/playwright/test-results",
  );
  const options = {
    repositoryRoot,
    resultsRoot,
  };
  try {
    const paths = scenarioPaths("smoke", options);
    await mkdir(paths.directory, {
      recursive: true,
    });
    await writeFile(
      resolve(paths.directory, "runtime.json"),
      `${JSON.stringify({
        arch: "x64",
        browser: {
          name: "chromium",
          project: "chromium",
          version: "156.0.0.0",
        },
        operatingSystem: "ubuntu",
        platform: "linux",
        scenario: "smoke",
        versions: {
          axe: "4.14.0",
          node: "v24.0.0",
          playwright: "1.64.1",
        },
      })}\n`,
    );
    const report = await writePlaywrightResult({
      options,
      scenario: "smoke",
      test: {
        expectedStatus: "passed",
      },
      testResult: {
        attachments: [],
        duration: 125,
        errors: [],
        startTime: new Date("2026-10-21T00:00:00.000Z"),
        status: "passed",
      },
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(
      report.capabilityId,
      "playwright-ubuntu-chromium",
    );
    assert.equal(report.tool, "playwright");
    assert.equal(report.status, "passed");
    assert.equal(report.timestamps.durationMs, 125);
    assert.equal(report.assertion.status, "passed");
    assert.deepEqual(report.accessibility.counts, null);
    assert.match(
      report.artifacts.result,
      /^tests\/e2e\/playwright\/test-results\/smoke\/result\.json$/,
    );
  } finally {
    await rm(repositoryRoot, {
      force: true,
      recursive: true,
    });
  }
});
