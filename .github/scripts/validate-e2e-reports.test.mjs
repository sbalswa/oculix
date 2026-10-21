import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { validateE2EOutputs } from "./validate-e2e-reports.mjs";

async function fixture(reportOverrides = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "oculix-e2e-report-"));
  const directory = resolve(root, "diagnostics/web-calculator");
  await mkdir(resolve(directory, "videos"), { recursive: true });
  await writeFile(resolve(directory, "result.png"), "png");
  await writeFile(resolve(directory, "accessibility.json"), "{}\n");
  await writeFile(resolve(directory, "summary.md"), "passed\n");
  await writeFile(resolve(directory, "videos/result.webm"), "video");
  const report = {
    accessibility: {
      counts: {
        incomplete: { nodes: 1, rules: 1 },
        violations: { nodes: 0, rules: 0 },
      },
      status: "passed",
    },
    artifacts: {
      accessibility: "diagnostics/web-calculator/accessibility.json",
      screenshot: "diagnostics/web-calculator/result.png",
      videos: ["diagnostics/web-calculator/videos/result.webm"],
    },
    assertion: { status: "passed" },
    capabilityId: "playwright-ubuntu-chromium",
    scenario: "web-calculator",
    schemaVersion: 1,
    status: "passed",
    ...reportOverrides,
  };
  await writeFile(
    resolve(directory, "result.json"),
    `${JSON.stringify(report)}\n`,
  );
  return root;
}

test("validates required globs, JSON, reports, and artifact paths", async () => {
  const root = await fixture();
  try {
    const result = await validateE2EOutputs({
      capabilityId: "playwright-ubuntu-chromium",
      repositoryRoot: root,
      requiredPatterns: [
        "diagnostics/web-calculator/result.png",
        "diagnostics/web-calculator/*.json",
        "diagnostics/web-calculator/videos/*.webm",
      ],
      resultReports: ["diagnostics/web-calculator/result.json"],
      requireAccessibility: true,
    });
    assert.equal(result.files, 4);
    assert.deepEqual(result.scenarios, ["web-calculator"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts Selenium's nested capability and numeric counts", async () => {
  const root = await fixture({
    accessibility: {
      counts: { incomplete: 1, violations: 0 },
      status: "passed",
    },
    capability: {
      browser: "chromium",
      id: "selenium-ubuntu-chromium",
      os: "ubuntu",
    },
    capabilityId: undefined,
  });
  try {
    await validateE2EOutputs({
      capabilityId: "selenium-ubuntu-chromium",
      repositoryRoot: root,
      requiredPatterns: ["diagnostics/web-calculator/result.json"],
      resultReports: ["diagnostics/web-calculator/result.json"],
      requireAccessibility: true,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not require an accessibility audit from a smoke report", async () => {
  const root = await fixture({
    accessibility: {
      counts: null,
      status: "not-run",
    },
    scenario: "smoke",
  });
  try {
    await validateE2EOutputs({
      capabilityId: "playwright-ubuntu-chromium",
      repositoryRoot: root,
      requiredPatterns: ["diagnostics/web-calculator/result.json"],
      resultReports: ["diagnostics/web-calculator/result.json"],
      requireAccessibility: true,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects missing required output", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      validateE2EOutputs({
        capabilityId: "playwright-ubuntu-chromium",
        repositoryRoot: root,
        requiredPatterns: ["diagnostics/missing.json"],
        resultReports: [],
        requireAccessibility: false,
      }),
      /Required file is missing/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an invalid capability identity", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      validateE2EOutputs({
        capabilityId: "playwright-ubuntu-firefox",
        repositoryRoot: root,
        requiredPatterns: [],
        resultReports: ["diagnostics/web-calculator/result.json"],
        requireAccessibility: true,
      }),
      /capability must be playwright-ubuntu-firefox/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects a report with blocking violations", async () => {
  const root = await fixture({
    accessibility: {
      counts: {
        incomplete: { nodes: 0, rules: 0 },
        violations: { nodes: 2, rules: 1 },
      },
      status: "failed",
    },
  });
  try {
    await assert.rejects(
      validateE2EOutputs({
        capabilityId: "playwright-ubuntu-chromium",
        repositoryRoot: root,
        requiredPatterns: [],
        resultReports: ["diagnostics/web-calculator/result.json"],
        requireAccessibility: true,
      }),
      /passed accessibility audit/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
