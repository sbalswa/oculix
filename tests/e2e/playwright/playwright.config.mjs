import { defineConfig } from "@playwright/test";
import { scenarioPaths } from "./reporting.mjs";

const scenario = process.env.PLAYWRIGHT_SCENARIO ?? "smoke";
const paths = scenarioPaths(scenario);

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
  outputDir: paths.artifacts,
  reporter: [
    ["line"],
    [
      "html",
      {
        open: "never",
        outputFolder: paths.htmlReport,
      },
    ],
    [
      "json",
      {
        outputFile: paths.nativeJsonReport,
      },
    ],
    ["./result-reporter.mjs"],
  ],
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
