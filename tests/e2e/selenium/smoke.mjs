import assert from "node:assert/strict";

import { By, until } from "selenium-webdriver";

import { runScenario } from "./harness.mjs";

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

await runScenario("smoke", async (driver) => {
  await driver.get(`data:text/html;charset=utf-8,${encodeURIComponent(SMOKE_DOCUMENT)}`);
  const button = await driver.wait(
    until.elementLocated(By.css('[data-testid="selenium-smoke"]')),
    5_000,
  );
  assert.equal(await button.getText(), "ready");
  await button.click();
  await driver.wait(until.elementTextIs(button, "clicked"), 5_000);
  assert.equal(await button.getText(), "clicked");
  console.log("Selenium browser-independent smoke check passed.");
});
