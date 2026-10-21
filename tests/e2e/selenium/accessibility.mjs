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
