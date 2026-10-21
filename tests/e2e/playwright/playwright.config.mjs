import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: "test-results",
  reporter: [["line"]],
  use: {
    actionTimeout: 5_000,
    headless: true,
    navigationTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "on",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
      },
    },
    {
      name: "webkit",
      use: {
        browserName: "webkit",
      },
    },
  ],
});
