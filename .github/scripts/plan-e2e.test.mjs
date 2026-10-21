import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPlanSummary,
  planCapabilities,
  readCatalog,
  selectorsFromDispatch,
  selectorsFromLabels,
  validateCatalog,
  validateCatalogTasks,
} from "./plan-e2e.mjs";

const catalog = await readCatalog();

function withCapabilities(capabilities, guardrails = {}) {
  return {
    ...structuredClone(catalog),
    capabilities,
    guardrails: {
      ...catalog.guardrails,
      ...guardrails,
    },
  };
}

test("the committed catalog contains the proven Phase 1 cells", () => {
  assert.deepEqual(
    catalog.capabilities.map((capability) => capability.id),
    [
      "selenium-ubuntu-chromium",
      "cypress-ubuntu-chrome",
      "playwright-ubuntu-chromium",
      "oculix-ubuntu-chromium",
    ],
  );
  assert.equal(catalog.guardrails.max_custom_cells, 6);
  assert.equal(catalog.guardrails.max_parallel, 3);
  assert.deepEqual(catalog.guardrails.allowed_runners, [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest",
  ]);
  assert.deepEqual(
    catalog.capabilities
      .filter((capability) => capability.smoke)
      .map((capability) => capability.id),
    ["selenium-ubuntu-chromium"],
  );
  const oculix = catalog.capabilities.find(
    (capability) => capability.tool === "oculix",
  );
  assert.deepEqual(oculix.linux_packages, ["xdotool"]);
  assert.equal(oculix.use_xvfb, true);
  assert.equal(oculix.oculix_chromium_disable_sandbox, true);
});

test("an empty selection allocates zero capabilities", () => {
  assert.deepEqual(
    planCapabilities({ catalog, selectors: [] }),
    {
      count: 0,
      ids: [],
      skippedIds: [
        "selenium-ubuntu-chromium",
        "cypress-ubuntu-chrome",
        "playwright-ubuntu-chromium",
        "oculix-ubuntu-chromium",
      ],
      matrix: { include: [] },
      maxParallel: 3,
    },
  );
});

test("raw IDs and exact label selectors produce the same cell", () => {
  const raw = planCapabilities({
    catalog,
    selectors: ["cypress-ubuntu-chrome"],
  });
  const label = planCapabilities({
    catalog,
    selectors: ["ci:e2e:cypress:ubuntu:chrome"],
  });
  assert.deepEqual(raw, label);
  assert.deepEqual(raw.ids, ["cypress-ubuntu-chrome"]);
  assert.equal(
    raw.matrix.include[0].required_files,
    JSON.stringify(catalog.capabilities[1].required_files),
  );
  assert.equal(
    raw.matrix.include[0].result_reports,
    JSON.stringify(catalog.capabilities[1].result_reports),
  );
});

test("selectors union and deduplicate deterministically", () => {
  const plan = planCapabilities({
    catalog,
    selectors: [
      "ci:e2e:selenium:all",
      "selenium-ubuntu-chromium",
      "ci:e2e:cypress:ubuntu:chrome",
    ],
  });
  assert.deepEqual(plan.ids, [
    "selenium-ubuntu-chromium",
    "cypress-ubuntu-chrome",
  ]);
  assert.deepEqual(
    plan.matrix.include.map(({ id, position, total }) => ({
      id,
      position,
      total,
    })),
    [
      {
        id: "selenium-ubuntu-chromium",
        position: 1,
        total: 2,
      },
      {
        id: "cypress-ubuntu-chrome",
        position: 2,
        total: 2,
      },
    ],
  );
  assert.deepEqual(plan.skippedIds, [
    "playwright-ubuntu-chromium",
    "oculix-ubuntu-chromium",
  ]);
});

test("smoke and full presets expand through stable catalog rows", () => {
  const smoke = planCapabilities({
    catalog,
    selectors: ["ci:e2e:smoke"],
  });
  const full = planCapabilities({
    catalog,
    selectors: ["ci:e2e:all"],
  });
  assert.deepEqual(smoke.ids, ["selenium-ubuntu-chromium"]);
  assert.equal(full.count, 4);
});

test("ordinary all presets exclude experimental capabilities", () => {
  const experimental = {
    ...structuredClone(catalog.capabilities[0]),
    id: "selenium-windows-firefox",
    selector: "ci:e2e:selenium:windows:firefox",
    os: "windows",
    browser: "firefox",
    runner: "windows-latest",
    smoke: false,
    stability: "experimental",
  };
  const expanded = withCapabilities([
    ...catalog.capabilities,
    experimental,
  ]);
  assert.equal(
    planCapabilities({
      catalog: expanded,
      includeExperimental: true,
      selectors: ["ci:e2e:all"],
    }).count,
    4,
  );
  assert.throws(
    () =>
      planCapabilities({
        catalog: expanded,
        selectors: ["selenium-windows-firefox"],
      }),
    /requires explicit opt-in/,
  );
  assert.deepEqual(
    planCapabilities({
      catalog: expanded,
      includeExperimental: true,
      selectors: ["selenium-windows-firefox"],
    }).ids,
    ["selenium-windows-firefox"],
  );
});

test("unknown selectors fail before a matrix is emitted", () => {
  assert.throws(
    () =>
      planCapabilities({
        catalog,
        selectors: ["ci:e2e:selenium:windows:netscape"],
      }),
    /Unknown E2E selector/,
  );
  assert.throws(
    () =>
      planCapabilities({
        catalog,
        selectors: ["ci:e2e:unknown:all"],
      }),
    /Unknown E2E tool selector/,
  );
  assert.throws(
    () =>
      planCapabilities({
        catalog,
        selectors: ["cypress-ubuntu-electron"],
      }),
    /Unknown E2E selector/,
  );
});

test("custom unions enforce the configured cell limit", () => {
  const expanded = withCapabilities(
    catalog.capabilities,
    { max_custom_cells: 1 },
  );
  assert.throws(
    () =>
      planCapabilities({
        catalog: expanded,
        selectors: [
          "selenium-ubuntu-chromium",
          "cypress-ubuntu-chrome",
        ],
      }),
    /custom limit is 1/,
  );
  assert.equal(
    planCapabilities({
      catalog: expanded,
      selectors: ["ci:e2e:all"],
    }).count,
    4,
  );
});

test("execution rows serialize executor inputs without array coercion", () => {
  const oculix = planCapabilities({
    catalog,
    selectors: ["oculix-ubuntu-chromium"],
  }).matrix.include[0];
  assert.equal(oculix.linux_packages, "xdotool");
  assert.equal(oculix.required_files, JSON.stringify([
    "oculix-web-calculator-diagnostics/result.png",
  ]));
  assert.equal(oculix.result_reports, "[]");
  assert.equal(oculix.oculix_chromium_disable_sandbox, "1");
  assert.equal(oculix.use_xvfb, true);
  assert.equal(oculix.require_accessibility, false);
  assert.equal("scenarios" in oculix, false);
});

test("label normalization ignores unrelated PR labels", () => {
  assert.deepEqual(
    selectorsFromLabels([
      "bug",
      "ci:e2e:smoke",
      "automation",
      "ci:e2e:playwright:ubuntu:chromium",
    ]),
    [
      "ci:e2e:smoke",
      "ci:e2e:playwright:ubuntu:chromium",
    ],
  );
});

test("equivalent label and dispatch requests produce one plan", () => {
  const labels = selectorsFromLabels([
    "ci:e2e:selenium:ubuntu:chromium",
  ]);
  const dispatch = selectorsFromDispatch({
    preset: "custom",
    selectors: "selenium-ubuntu-chromium",
  });
  assert.deepEqual(
    planCapabilities({ catalog, selectors: labels }),
    planCapabilities({ catalog, selectors: dispatch }),
  );
});

test("dispatch presets normalize and validate custom input", () => {
  assert.deepEqual(
    selectorsFromDispatch({ preset: "none" }),
    [],
  );
  assert.deepEqual(
    selectorsFromDispatch({ preset: "smoke" }),
    ["ci:e2e:smoke"],
  );
  assert.deepEqual(
    selectorsFromDispatch({ preset: "full" }),
    ["ci:e2e:all"],
  );
  assert.deepEqual(
    selectorsFromDispatch({
      preset: "custom",
      selectors:
        "selenium-ubuntu-chromium,\n" +
        "ci:e2e:cypress:ubuntu:chrome",
    }),
    [
      "selenium-ubuntu-chromium",
      "ci:e2e:cypress:ubuntu:chrome",
    ],
  );
  assert.throws(
    () => selectorsFromDispatch({ preset: "custom" }),
    /requires selectors/,
  );
  assert.throws(
    () =>
      selectorsFromDispatch({
        preset: "smoke",
        selectors: "selenium-ubuntu-chromium",
      }),
    /only with preset=custom/,
  );
  for (const selector of [
    "ci:e2e:smoke",
    "ci:e2e:all",
    "ci:e2e:selenium:all",
  ]) {
    assert.throws(
      () =>
        selectorsFromDispatch({
          preset: "custom",
          selectors: selector,
        }),
      /only exact capability selectors/,
    );
  }
});

test("catalog validation rejects drift-prone metadata", () => {
  const duplicate = structuredClone(catalog);
  duplicate.capabilities[1] = structuredClone(
    duplicate.capabilities[0],
  );
  assert.throws(
    () => validateCatalog(duplicate),
    /Capability id values must be unique/,
  );

  const missingEvidence = structuredClone(catalog);
  missingEvidence.capabilities[0].required_files = [];
  assert.throws(
    () => validateCatalog(missingEvidence),
    /required_files must be an array/,
  );

  const wrongSelector = structuredClone(catalog);
  wrongSelector.capabilities[0].selector =
    "ci:e2e:selenium:ubuntu:firefox";
  assert.throws(
    () => validateCatalog(wrongSelector),
    /must match its tool, OS, and browser/,
  );

  const unsafeSandbox = structuredClone(catalog);
  unsafeSandbox.capabilities[0].oculix_chromium_disable_sandbox = true;
  assert.throws(
    () => validateCatalog(unsafeSandbox),
    /unsupported Chromium sandbox exception/,
  );

  const missingReport = structuredClone(catalog);
  missingReport.capabilities[0].required_files =
    missingReport.capabilities[0].required_files.filter(
      (path) => !path.endsWith("result.json"),
    );
  assert.throws(
    () => validateCatalog(missingReport),
    /must include every result report/,
  );

  const selfHosted = structuredClone(catalog);
  selfHosted.capabilities[0].runner = "self-hosted";
  assert.throws(
    () => validateCatalog(selfHosted),
    /standard GitHub-hosted runner/,
  );

  const unapprovedHosted = structuredClone(catalog);
  unapprovedHosted.capabilities[0].runner = "ubuntu-24.04";
  assert.throws(
    () => validateCatalog(unapprovedHosted),
    /outside guardrails.allowed_runners/,
  );

  const excessiveParallelism = structuredClone(catalog);
  excessiveParallelism.guardrails.max_parallel = 7;
  assert.throws(
    () => validateCatalog(excessiveParallelism),
    /cannot exceed 6/,
  );

  const windowsAbsolutePath = structuredClone(catalog);
  windowsAbsolutePath.capabilities[0].evidence =
    "C:\\outside\\result.png";
  assert.throws(
    () => validateCatalog(windowsAbsolutePath),
    /repository-relative/,
  );

  const currentDirectoryPath = structuredClone(catalog);
  currentDirectoryPath.capabilities[0].evidence = ".";
  assert.throws(
    () => validateCatalog(currentDirectoryPath),
    /repository-relative/,
  );

  const escapedDiagnostics = structuredClone(catalog);
  escapedDiagnostics.capabilities[0].evidence =
    "tests/e2e/other/result.png";
  assert.throws(
    () => validateCatalog(escapedDiagnostics),
    /beneath diagnostics/,
  );

  const taskPrefixCollision = structuredClone(catalog);
  taskPrefixCollision.capabilities[0].task = "e2e:seleniumish";
  assert.throws(
    () => validateCatalog(taskPrefixCollision),
    /must invoke its tool's E2E task/,
  );
});

test("catalog tasks resolve to committed canonical mise tasks", async () => {
  await validateCatalogTasks(catalog, process.cwd());
  const missingTask = structuredClone(catalog);
  missingTask.capabilities[0].task = "e2e:selenium:missing";
  await assert.rejects(
    validateCatalogTasks(missingTask, process.cwd()),
    /references missing mise task/,
  );
  const directoryOnlyTask = structuredClone(catalog);
  directoryOnlyTask.capabilities[0].task = "e2e:fixtures:web-calculator";
  await assert.rejects(
    validateCatalogTasks(directoryOnlyTask, process.cwd()),
    /references missing mise task/,
  );
});

test("planner summary exposes selected cost before execution", () => {
  const summary = formatPlanSummary(
    planCapabilities({
      catalog,
      selectors: ["ci:e2e:smoke"],
    }),
  );
  assert.match(summary, /Selected \*\*1\*\* capability cell/);
  assert.match(summary, /selenium-ubuntu-chromium/);
  assert.match(summary, /ubuntu-latest, chromium, standard/);
  assert.match(summary, /Maximum parallel jobs: \*\*3\*\*/);
  assert.match(summary, /Skipped capabilities/);
  assert.match(summary, /cypress-ubuntu-chrome/);
});
