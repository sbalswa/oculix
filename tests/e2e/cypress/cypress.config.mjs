import { defineConfig } from "cypress";

import { createCypressReportingTasks } from "./reporting.mjs";

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
        diagnosticsDirectory: config.env.diagnosticsDirectory,
        scenario: config.env.reportScenario,
      });
      on("task", {
        "report:accessibility": tasks.recordAccessibility,
        "report:assertion": tasks.recordAssertion,
        "report:enforce-accessibility": tasks.enforceAccessibility,
      });
      return config;
    },
    specPattern: "specs/**/*.cy.mjs",
    supportFile: false,
  },
});
