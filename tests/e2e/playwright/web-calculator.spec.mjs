import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  ACCESSIBILITY_TAGS,
  enforceAccessibilityPolicy,
  scenarioPaths,
  writeAccessibilityReports,
  writeRuntimeMetadata,
} from "./reporting.mjs";

test("calculates 7 × 34", async ({
  browser,
  browserName,
  page,
}, testInfo) => {
  const paths = scenarioPaths("web-calculator");
  await writeRuntimeMetadata({
    browserName,
    browserVersion: browser.version(),
    scenario: "web-calculator",
  });
  const fixtureUrl = process.env.WEB_CALCULATOR_URL;
  if (fixtureUrl === undefined) {
    throw new Error(
      "WEB_CALCULATOR_URL is required; run this scenario through the fixture lifecycle.",
    );
  }

  const url = new URL(fixtureUrl);
  expect(url.hostname).toBe("127.0.0.1");
  await page.goto(url.href);

  const display = page.getByLabel("Calculator display");
  await page.getByRole("button", { name: "clear", exact: true }).click();
  await page.getByRole("button", { name: "7", exact: true }).click();
  await page.getByRole("button", { name: "Multiply", exact: true }).click();
  await page.getByRole("button", { name: "3", exact: true }).click();
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByRole("button", { name: "Equals", exact: true }).click();

  await expect(display).toBeVisible();
  await expect(display).toHaveText("238");
  const screenshot = await page.screenshot({
    path: paths.finalScreenshot,
  });
  await writeFile(paths.legacyFinalScreenshot, screenshot);
  await testInfo.attach("final-rendered-state", {
    contentType: "image/png",
    path: paths.finalScreenshot,
  });

  const accessibilityResults = await new AxeBuilder({
    page,
  })
    .withTags(ACCESSIBILITY_TAGS)
    .analyze();
  const { summary } = await writeAccessibilityReports(
    "web-calculator",
    accessibilityResults,
  );
  await testInfo.attach("accessibility-results", {
    body: Buffer.from(
      `${JSON.stringify(accessibilityResults, null, 2)}\n`,
    ),
    contentType: "application/json",
  });
  await testInfo.attach("accessibility-summary", {
    body: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`),
    contentType: "application/json",
  });

  enforceAccessibilityPolicy(summary);
});
