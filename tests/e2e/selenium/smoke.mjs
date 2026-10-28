import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import { By, until } from "selenium-webdriver";

import { runScenario } from "./harness.mjs";
import { createScenarioReporter } from "./reporting.mjs";

const SMOKE_DOCUMENT = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Selenium smoke</title></head>
  <body>
    <button data-testid="selenium-smoke" type="button">ready</button>
    <script>
      document.querySelector("[data-testid=selenium-smoke]").addEventListener(
        "click",
        (event) => {
          event.currentTarget.textContent = "clicked";
        },
      );
    </script>
  </body>
</html>`;

const reporter = await createScenarioReporter({
  assertion: {
    expected: "clicked",
    name: "selenium smoke button state",
  },
  scenario: "smoke",
});

await runScenario(
  "smoke",
  async (driver) => {
    let actual = null;
    try {
      await driver.get(
        `data:text/html;charset=utf-8,${encodeURIComponent(SMOKE_DOCUMENT)}`,
      );
      const button = await driver.wait(
        until.elementLocated(By.css('[data-testid="selenium-smoke"]')),
        5_000,
      );
      assert.equal(await button.getText(), "ready");
      await button.click();
      await driver.wait(until.elementTextIs(button, "clicked"), 5_000);
      actual = await button.getText();
      assert.equal(actual, "clicked");
      reporter.recordAssertion({ actual, status: "passed" });
      await mkdir(reporter.directory, { recursive: true });
      await writeFile(
        reporter.paths.screenshot,
        await driver.takeScreenshot(),
        "base64",
      );
    } catch (error) {
      reporter.recordAssertion({ actual, status: "failed" });
      reporter.recordFailure("assertion", error);
      await reporter.write();
      throw error;
    }
    console.log("Selenium browser-independent smoke check passed.");
  },
  { reporter },
);
