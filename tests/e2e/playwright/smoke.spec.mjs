import { expect, test } from "@playwright/test";
import playwrightPackage from "@playwright/test/package.json" with {
  type: "json",
};
import { writeRuntimeMetadata } from "./reporting.mjs";

test("interacts with an in-memory page", async ({
  browser,
  browserName,
  page,
}) => {
  await writeRuntimeMetadata({
    browserName,
    browserVersion: browser.version(),
    scenario: "smoke",
  });
  const networkRequests = [];
  page.on("request", (request) => networkRequests.push(request.url()));

  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <body>
        <button type="button">Confirm browser interaction</button>
        <output aria-label="Smoke result">waiting</output>
        <script>
          document.querySelector("button").addEventListener("click", () => {
            document.querySelector("output").textContent = "ready";
          });
        </script>
      </body>
    </html>
  `);

  await page
    .getByRole("button", { name: "Confirm browser interaction" })
    .click();
  await expect(page.getByLabel("Smoke result")).toHaveText("ready");
  expect(networkRequests).toEqual([]);

  console.log(
    [
      `node=${process.version}`,
      `playwright=${playwrightPackage.version}`,
      `project=${process.env.PLAYWRIGHT_PROJECT}`,
      `browser=${browserName} ${browser.version()}`,
      `os=${process.env.E2E_OS ?? process.platform}`,
      `platform=${process.platform}/${process.arch}`,
    ].join(" "),
  );
});
