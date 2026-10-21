import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { defineConfig } from "cypress";

import { createCypressReportingTasks } from "./reporting.mjs";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(
  require.resolve("axe-core/axe.min.js"),
  "utf8",
);

export default defineConfig({
  downloadsFolder: "diagnostics/downloads",
  screenshotOnRunFailure: true,
  screenshotsFolder: "diagnostics/screenshots",
  trashAssetsBeforeRuns: true,
  video: true,
  videosFolder: "diagnostics/videos",
  e2e: {
    setupNodeEvents(on, config) {
      const tasks = createCypressReportingTasks({
        axeCoreVersion: config.env.axeCoreVersion,
        axeSource: AXE_SOURCE,
        diagnosticsDirectory: config.env.diagnosticsDirectory,
        scenario: config.env.reportScenario,
      });
      on("task", {
        "report:accessibility": tasks.recordAccessibility,
        "report:assertion": tasks.recordAssertion,
        "report:axe-source": tasks.axeSource,
        "report:enforce-accessibility": tasks.enforceAccessibility,
      });
      return config;
    },
    specPattern: "specs/**/*.cy.mjs",
    supportFile: false,
  },
});
