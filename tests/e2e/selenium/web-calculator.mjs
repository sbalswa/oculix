import assert from "node:assert/strict";

import { By, until } from "selenium-webdriver";

import { runScenario } from "./harness.mjs";

const url = process.env.WEB_CALCULATOR_URL;
assert.ok(
  url,
  "WEB_CALCULATOR_URL is required; run through the fixture lifecycle task",
);

await runScenario("web-calculator", async (driver) => {
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
  assert.equal(await display.getText(), "238");
  console.log("Selenium web calculator scenario passed: 7 × 34 = 238.");
});
