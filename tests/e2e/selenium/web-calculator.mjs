import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import { By, until } from "selenium-webdriver";

import {
  auditAccessibility,
  enforceAccessibilityPolicy,
  writeAccessibilityReports,
} from "./accessibility.mjs";
import { runScenario } from "./harness.mjs";
import { createScenarioReporter } from "./reporting.mjs";

const url = process.env.WEB_CALCULATOR_URL;
assert.ok(
  url,
  "WEB_CALCULATOR_URL is required; run through the fixture lifecycle task",
);

const reporter = await createScenarioReporter({
  scenario: "web-calculator",
});

await runScenario(
  "web-calculator",
  async (driver) => {
    let actual = null;
    try {
      await driver.get(url);

      const display = await driver.wait(
        until.elementLocated(By.css('[data-testid="display"]')),
        5_000,
      );
      const click = async (selector) => {
        const element = await driver.wait(
          until.elementLocated(By.css(selector)),
          5_000,
        );
        await driver.wait(until.elementIsVisible(element), 5_000);
        await element.click();
      };

      await click('[data-testid="clear"]');
      await click('button[data-action="digit"][data-value="7"]');
      await click('[data-testid="multiply"]');
      await click('button[data-action="digit"][data-value="3"]');
      await click('button[data-action="digit"][data-value="4"]');
      await click('[data-testid="equals"]');

      await driver.wait(until.elementTextIs(display, "238"), 5_000);
      actual = await display.getText();
      assert.equal(actual, "238");
      reporter.recordAssertion({ actual, status: "passed" });
    } catch (error) {
      reporter.recordAssertion({ actual, status: "failed" });
      reporter.recordFailure("assertion", error);
      await reporter.write();
      throw error;
    }

    try {
      await mkdir(reporter.directory, { recursive: true });
      await writeFile(
        reporter.paths.screenshot,
        await driver.takeScreenshot(),
        "base64",
      );
    } catch (error) {
      reporter.recordFailure("evidence", error);
      await reporter.write();
      throw error;
    }
    console.log(
      `Selenium end-user result evidence: ${reporter.paths.screenshot}`,
    );

    let accessibilityResults;
    try {
      accessibilityResults = await auditAccessibility(driver);
    } catch (error) {
      reporter.recordAccessibilityError(error);
      reporter.recordFailure("accessibility", error);
      await reporter.write();
      throw error;
    }

    try {
      await writeAccessibilityReports({
        accessibilityPath: reporter.paths.accessibility,
        results: accessibilityResults,
        summaryPath: reporter.paths.accessibilitySummary,
      });
    } catch (error) {
      reporter.recordAccessibilityError(error);
      reporter.recordFailure("accessibility-report", error);
      await reporter.write();
      throw error;
    }
    const accessibility = reporter.recordAccessibility(
      accessibilityResults,
    );
    await reporter.write();

    try {
      enforceAccessibilityPolicy(accessibilityResults);
    } catch (error) {
      reporter.recordFailure("accessibility", error);
      await reporter.write();
      throw error;
    }

    console.log(
      "Selenium accessibility audit passed: " +
        `${accessibility.counts.violations} violations, ` +
        `${accessibility.counts.incomplete} incomplete findings.`,
    );
    console.log("Selenium web calculator scenario passed: 7 × 34 = 238.");
  },
  { reporter },
);
