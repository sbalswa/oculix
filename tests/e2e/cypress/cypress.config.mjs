import { defineConfig } from "cypress";

export default defineConfig({
  downloadsFolder: "diagnostics/downloads",
  screenshotOnRunFailure: true,
  screenshotsFolder: "diagnostics/screenshots",
  trashAssetsBeforeRuns: true,
  video: true,
  videosFolder: "diagnostics/videos",
  e2e: {
    specPattern: "specs/**/*.cy.mjs",
    supportFile: false,
  },
});
