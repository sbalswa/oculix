import { writePlaywrightResult } from "./reporting.mjs";

export default class ScenarioResultReporter {
  async onTestEnd(test, result) {
    const scenario = process.env.PLAYWRIGHT_SCENARIO;
    if (scenario === undefined) {
      throw new Error(
        "PLAYWRIGHT_SCENARIO is required for Playwright result reporting.",
      );
    }
    await writePlaywrightResult({
      scenario,
      test,
      testResult: result,
    });
  }
}
