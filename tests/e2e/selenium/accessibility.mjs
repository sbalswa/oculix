import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import AxeBuilder from "@axe-core/webdriverjs";

export const ACCESSIBILITY_TAGS = Object.freeze([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
]);

export const ACCESSIBILITY_POLICY = Object.freeze({
  incompleteBlocking: false,
  tags: ACCESSIBILITY_TAGS,
  violationsBlocking: true,
});

function findingCount(findings) {
  return findings.reduce(
    (total, finding) => total + (finding.nodes?.length ?? 0),
    0,
  );
}

function counted(value, singular) {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

export function normalizeAccessibilityResults(results) {
  return {
    inapplicable: results.inapplicable.length,
    incomplete: results.incomplete.length,
    incompleteNodes: findingCount(results.incomplete),
    passes: results.passes.length,
    violations: results.violations.length,
    violationNodes: findingCount(results.violations),
  };
}

export function accessibilityOutcome(results) {
  const counts = normalizeAccessibilityResults(results);
  return {
    blocking: counts.violations > 0,
    counts,
    status: counts.violations > 0 ? "failed" : "passed",
  };
}

export function formatAccessibilitySummary(results) {
  const outcome = accessibilityOutcome(results);
  const engineVersion = results.testEngine?.version ?? "unknown";
  const incompleteReview =
    outcome.counts.incomplete > 0
      ? "required; findings are nonblocking"
      : "not required; no incomplete findings";
  return [
    "# Selenium accessibility summary",
    "",
    `- Outcome: **${outcome.status}**`,
    `- Engine: \`axe-core ${engineVersion}\``,
    `- Policy tags: ${ACCESSIBILITY_TAGS.map((tag) => `\`${tag}\``).join(", ")}`,
    `- Violations: ${counted(outcome.counts.violations, "rule")} / ${counted(outcome.counts.violationNodes, "node")} (blocking)`,
    `- Incomplete: ${counted(outcome.counts.incomplete, "rule")} / ${counted(outcome.counts.incompleteNodes, "node")}`,
    `- Manual review: ${incompleteReview}`,
    "",
    "Any automated violation blocks this scenario. Incomplete findings are retained for manual review and do not block.",
    "",
  ].join("\n");
}

export async function writeAccessibilityReports({
  accessibilityPath,
  results,
  summaryPath,
}) {
  await mkdir(dirname(accessibilityPath), { recursive: true });
  await writeFile(
    accessibilityPath,
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  await writeFile(summaryPath, formatAccessibilitySummary(results), "utf8");
}

export function enforceAccessibilityPolicy(results) {
  const outcome = accessibilityOutcome(results);
  if (outcome.blocking) {
    throw new Error(
      `Accessibility audit found ${outcome.counts.violations} ` +
        `violation rules across ${outcome.counts.violationNodes} nodes`,
    );
  }
  return outcome;
}

export async function auditAccessibility(driver) {
  return new AxeBuilder(driver).withTags(ACCESSIBILITY_TAGS).analyze();
}
