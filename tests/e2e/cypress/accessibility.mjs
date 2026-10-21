import axe from "axe-core";

import { ACCESSIBILITY_POLICY } from "./accessibility-policy.mjs";

export function auditAccessibility(state) {
  let startedAt;
  let startedMilliseconds;

  return cy
    .window({ log: false })
    .then(async (window) => {
      startedAt = new Date().toISOString();
      startedMilliseconds = performance.now();
      window.eval(axe.source);
      return window.axe.run(window.document, {
        resultTypes: [
          "violations",
          "incomplete",
          "passes",
          "inapplicable",
        ],
        runOnly: {
          type: "tag",
          values: ACCESSIBILITY_POLICY.tags,
        },
      });
    })
    .then((result) => {
      const finishedAt = new Date().toISOString();
      return cy.task(
        "report:accessibility",
        {
          durationMs: Math.round(
            performance.now() - startedMilliseconds,
          ),
          finishedAt,
          result,
          startedAt,
          state,
        },
        { log: false },
      );
    });
}

export function recordAssertion(description) {
  return cy.task(
    "report:assertion",
    {
      description,
      finishedAt: new Date().toISOString(),
      status: "passed",
    },
    { log: false },
  );
}

export function enforceAccessibility() {
  return cy
    .task("report:enforce-accessibility", null, { log: false })
    .then((evaluation) => {
      if (evaluation.blocking) {
        throw new Error(
          "Accessibility policy failed with " +
            `${evaluation.counts.violations.rules} violation rule(s) ` +
            `across ${evaluation.counts.violations.nodes} node(s); ` +
            "accessibility.json and accessibility.md were written first.",
        );
      }
    });
}
