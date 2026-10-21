import { expect, test } from "@playwright/test";

test("calculates 7 × 34", async ({ page }) => {
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
});
