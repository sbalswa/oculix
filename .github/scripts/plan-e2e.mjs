import { appendFile, readFile, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  matchesGlob,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MAX_CUSTOM_CELLS = 12;
const MAX_PARALLEL = 6;
const GITHUB_HOSTED_RUNNER_PATTERN =
  /^(?:ubuntu-(?:latest|\d{2}\.\d{2})|windows-(?:latest|\d{4})|macos-(?:latest|\d+(?:-intel)?))$/u;
const DEFAULT_CATALOG_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../../tests/e2e/capabilities.json",
);
const CAPABILITY_KEYS = [
  "browser",
  "cost_class",
  "diagnostics",
  "environment",
  "evidence",
  "id",
  "linux_packages",
  "oculix_chromium_disable_sandbox",
  "os",
  "required_files",
  "require_accessibility",
  "result_reports",
  "runner",
  "scenarios",
  "selector",
  "smoke",
  "stability",
  "task",
  "tool",
  "use_xvfb",
];
const ARRAY_KEYS = [
  "linux_packages",
  "required_files",
  "result_reports",
  "scenarios",
];
const BOOLEAN_KEYS = [
  "oculix_chromium_disable_sandbox",
  "require_accessibility",
  "smoke",
  "use_xvfb",
];
const STRING_KEYS = CAPABILITY_KEYS.filter(
  (key) => !ARRAY_KEYS.includes(key) && !BOOLEAN_KEYS.includes(key),
);

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertStringArray(value, name, { allowEmpty = true } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new Error(`${name} must be an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
}

function assertRepositoryPath(path, name) {
  const normalized = path.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    normalized.startsWith("//") ||
    normalized === "." ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${name} must be repository-relative`);
  }
}

function assertUnderDiagnostics(path, diagnostics, name) {
  if (!path.replaceAll("\\", "/").startsWith(diagnostics)) {
    throw new Error(`${name} must remain beneath diagnostics`);
  }
}

function requiredFilesCover(path, requiredFiles) {
  return requiredFiles.some(
    (pattern) => pattern === path || matchesGlob(path, pattern),
  );
}

function validateCapability(capability, index) {
  const prefix = `capabilities[${index}]`;
  if (
    capability === null ||
    typeof capability !== "object" ||
    Array.isArray(capability)
  ) {
    throw new Error(`${prefix} must be an object`);
  }
  const unknownKeys = Object.keys(capability).filter(
    (key) => !CAPABILITY_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${prefix} contains unknown keys: ${unknownKeys.join(", ")}`,
    );
  }
  for (const key of STRING_KEYS) {
    if (typeof capability[key] !== "string" || capability[key] === "") {
      throw new Error(`${prefix}.${key} must be a nonempty string`);
    }
  }
  for (const key of ARRAY_KEYS) {
    assertStringArray(
      capability[key],
      `${prefix}.${key}`,
      { allowEmpty: key !== "scenarios" && key !== "required_files" },
    );
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof capability[key] !== "boolean") {
      throw new Error(`${prefix}.${key} must be a boolean`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(capability.id)) {
    throw new Error(`${prefix}.id must be a stable kebab-case ID`);
  }
  if (
    capability.id !==
    `${capability.tool}-${capability.os}-${capability.browser}`
  ) {
    throw new Error(
      `${prefix}.id must match its tool, OS, and browser`,
    );
  }
  if (
    capability.selector !==
    `ci:e2e:${capability.tool}:${capability.os}:${capability.browser}`
  ) {
    throw new Error(
      `${prefix}.selector must match its tool, OS, and browser`,
    );
  }
  if (
    capability.task !== `e2e:${capability.tool}` &&
    !capability.task.startsWith(`e2e:${capability.tool}:`)
  ) {
    throw new Error(`${prefix}.task must invoke its tool's E2E task`);
  }
  if (!capability.diagnostics.endsWith("/")) {
    throw new Error(`${prefix}.diagnostics must end with "/"`);
  }
  assertRepositoryPath(capability.diagnostics, `${prefix}.diagnostics`);
  assertRepositoryPath(capability.evidence, `${prefix}.evidence`);
  assertUnderDiagnostics(
    capability.evidence,
    capability.diagnostics,
    `${prefix}.evidence`,
  );
  for (const key of ["required_files", "result_reports"]) {
    for (const path of capability[key]) {
      assertRepositoryPath(path, `${prefix}.${key}`);
      assertUnderDiagnostics(
        path,
        capability.diagnostics,
        `${prefix}.${key}`,
      );
    }
  }
  if (!requiredFilesCover(
    capability.evidence,
    capability.required_files,
  )) {
    throw new Error(`${prefix}.required_files must include evidence`);
  }
  for (const report of capability.result_reports) {
    if (!requiredFilesCover(report, capability.required_files)) {
      throw new Error(
        `${prefix}.required_files must include every result report`,
      );
    }
  }
  if (!["experimental", "stable"].includes(capability.stability)) {
    throw new Error(
      `${prefix}.stability must be "stable" or "experimental"`,
    );
  }
  if (!["expensive", "specialized", "standard"].includes(
    capability.cost_class,
  )) {
    throw new Error(`${prefix}.cost_class is invalid`);
  }
  if (
    capability.require_accessibility &&
    !capability.result_reports.some((report) =>
      report.includes("web-calculator"),
    )
  ) {
    throw new Error(
      `${prefix} requires a web-calculator accessibility report`,
    );
  }
  if (!capability.environment.split(",").includes("web-e2e")) {
    throw new Error(`${prefix}.environment must include web-e2e`);
  }
  if (!GITHUB_HOSTED_RUNNER_PATTERN.test(capability.runner)) {
    throw new Error(`${prefix}.runner must be a standard GitHub-hosted runner`);
  }
  const linuxRunner = capability.runner.startsWith("ubuntu-");
  if (
    !linuxRunner &&
    (capability.linux_packages.length > 0 || capability.use_xvfb)
  ) {
    throw new Error(
      `${prefix} uses Linux-only settings on a non-Linux runner`,
    );
  }
  if (
    capability.oculix_chromium_disable_sandbox &&
    (
      capability.id !== "oculix-ubuntu-chromium" ||
      !capability.use_xvfb
    )
  ) {
    throw new Error(
      `${prefix} uses an unsupported Chromium sandbox exception`,
    );
  }
}

export function validateCatalog(catalog) {
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    Array.isArray(catalog)
  ) {
    throw new Error("Capability catalog must be an object");
  }
  if (catalog.schema_version !== 1) {
    throw new Error("Capability catalog must use schema_version 1");
  }
  const unknownCatalogKeys = Object.keys(catalog).filter(
    (key) =>
      !["capabilities", "guardrails", "schema_version"].includes(key),
  );
  if (unknownCatalogKeys.length > 0) {
    throw new Error(
      `Capability catalog contains unknown keys: ` +
        `${unknownCatalogKeys.join(", ")}`,
    );
  }
  if (
    catalog.guardrails === null ||
    typeof catalog.guardrails !== "object" ||
    Array.isArray(catalog.guardrails)
  ) {
    throw new Error("guardrails must be an object");
  }
  const unknownGuardrailKeys = Object.keys(catalog.guardrails).filter(
    (key) =>
      !["allowed_runners", "max_custom_cells", "max_parallel"].includes(key),
  );
  if (unknownGuardrailKeys.length > 0) {
    throw new Error(
      `guardrails contains unknown keys: ` +
        `${unknownGuardrailKeys.join(", ")}`,
    );
  }
  assertPositiveInteger(
    catalog.guardrails.max_custom_cells,
    "guardrails.max_custom_cells",
  );
  assertPositiveInteger(
    catalog.guardrails.max_parallel,
    "guardrails.max_parallel",
  );
  assertStringArray(
    catalog.guardrails.allowed_runners,
    "guardrails.allowed_runners",
    { allowEmpty: false },
  );
  if (catalog.guardrails.max_custom_cells > MAX_CUSTOM_CELLS) {
    throw new Error(
      `guardrails.max_custom_cells cannot exceed ${MAX_CUSTOM_CELLS}`,
    );
  }
  if (catalog.guardrails.max_parallel > MAX_PARALLEL) {
    throw new Error(`guardrails.max_parallel cannot exceed ${MAX_PARALLEL}`);
  }
  if (
    catalog.guardrails.allowed_runners.some(
      (runner) => !GITHUB_HOSTED_RUNNER_PATTERN.test(runner),
    )
  ) {
    throw new Error(
      "guardrails.allowed_runners must contain only standard " +
        "GitHub-hosted runners",
    );
  }
  if (
    !Array.isArray(catalog.capabilities) ||
    catalog.capabilities.length === 0
  ) {
    throw new Error("capabilities must be a nonempty array");
  }
  catalog.capabilities.forEach(validateCapability);
  for (const capability of catalog.capabilities) {
    if (!catalog.guardrails.allowed_runners.includes(capability.runner)) {
      throw new Error(
        `${capability.id} uses runner outside guardrails.allowed_runners`,
      );
    }
  }
  for (const key of ["id", "selector"]) {
    const values = catalog.capabilities.map((capability) => capability[key]);
    if (new Set(values).size !== values.length) {
      throw new Error(`Capability ${key} values must be unique`);
    }
  }
  if (
    !catalog.capabilities.some(
      (capability) =>
        capability.smoke && capability.stability === "stable",
    )
  ) {
    throw new Error("Catalog must contain at least one stable smoke cell");
  }
  if (
    catalog.capabilities.some(
      (capability) =>
        capability.smoke && capability.stability !== "stable",
    )
  ) {
    throw new Error("Experimental capabilities cannot join smoke");
  }
  return catalog;
}

function taskPath(task, repositoryRoot) {
  const parts = task.split(":");
  if (parts[0] !== "e2e" || parts.length < 2) {
    throw new Error(`Invalid canonical E2E task: ${task}`);
  }
  return resolve(repositoryRoot, "mise/tasks", ...parts);
}

async function taskExists(task, repositoryRoot) {
  const path = taskPath(task, repositoryRoot);
  for (const candidate of [path, resolve(path, "_default")]) {
    try {
      if ((await stat(candidate)).isFile()) {
        return true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

export async function validateCatalogTasks(catalog, repositoryRoot) {
  for (const capability of catalog.capabilities) {
    if (!(await taskExists(capability.task, repositoryRoot))) {
      throw new Error(
        `${capability.id} references missing mise task ` +
          `${capability.task}`,
      );
    }
  }
  return catalog;
}

export async function readCatalog(
  path = DEFAULT_CATALOG_PATH,
  repositoryRoot = resolve(dirname(path), "../.."),
) {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read capability catalog: ${error.message}`);
  }
  validateCatalog(catalog);
  return validateCatalogTasks(catalog, repositoryRoot);
}

export function selectorsFromLabels(labels) {
  assertStringArray(labels, "labels");
  return labels.filter((label) => label.startsWith("ci:e2e:"));
}

function splitSelectors(value) {
  return value
    .split(/[\n,]/u)
    .map((selector) => selector.trim())
    .filter(Boolean);
}

export function selectorsFromDispatch({ preset, selectors = "" }) {
  if (!["custom", "full", "none", "smoke"].includes(preset)) {
    throw new Error(`Unknown E2E dispatch preset: ${preset}`);
  }
  const custom = splitSelectors(selectors);
  if (preset === "custom") {
    if (custom.length === 0) {
      throw new Error("The custom E2E preset requires selectors");
    }
    if (
      custom.some(
        (selector) =>
          selector === "ci:e2e:smoke" ||
          selector === "ci:e2e:all" ||
          /^ci:e2e:[a-z0-9-]+:all$/u.test(selector),
      )
    ) {
      throw new Error(
        "The custom E2E preset accepts only exact capability selectors",
      );
    }
    return custom;
  }
  if (custom.length > 0) {
    throw new Error(
      "Dispatch selectors are accepted only with preset=custom",
    );
  }
  if (preset === "smoke") {
    return ["ci:e2e:smoke"];
  }
  if (preset === "full") {
    return ["ci:e2e:all"];
  }
  return [];
}

function selectionIndexes(catalog) {
  return {
    byId: new Map(
      catalog.capabilities.map((capability) => [
        capability.id,
        capability,
      ]),
    ),
    bySelector: new Map(
      catalog.capabilities.map((capability) => [
        capability.selector,
        capability,
      ]),
    ),
    tools: new Set(
      catalog.capabilities.map((capability) => capability.tool),
    ),
  };
}

function stableCapabilities(catalog, predicate = () => true) {
  return catalog.capabilities.filter(
    (capability) =>
      capability.stability === "stable" && predicate(capability),
  );
}

function expandSelector(selector, catalog, indexes, includeExperimental) {
  if (selector === "ci:e2e:smoke") {
    return stableCapabilities(
      catalog,
      (capability) => capability.smoke,
    );
  }
  if (selector === "ci:e2e:all") {
    return stableCapabilities(catalog);
  }
  const toolAll = selector.match(/^ci:e2e:([a-z0-9-]+):all$/u);
  if (toolAll !== null) {
    const tool = toolAll[1];
    if (!indexes.tools.has(tool)) {
      throw new Error(`Unknown E2E tool selector: ${selector}`);
    }
    return stableCapabilities(
      catalog,
      (capability) => capability.tool === tool,
    );
  }
  const capability =
    indexes.byId.get(selector) ?? indexes.bySelector.get(selector);
  if (capability === undefined) {
    throw new Error(`Unknown E2E selector: ${selector}`);
  }
  if (
    capability.stability === "experimental" &&
    !includeExperimental
  ) {
    throw new Error(
      `Experimental capability requires explicit opt-in: ${selector}`,
    );
  }
  return [capability];
}

function executionCapability(capability, position, total) {
  return {
    id: capability.id,
    position,
    total,
    tool: capability.tool,
    runner: capability.runner,
    os: capability.os,
    browser: capability.browser,
    environment: capability.environment,
    task: capability.task,
    diagnostics: capability.diagnostics,
    evidence: capability.evidence,
    required_files: JSON.stringify(capability.required_files),
    result_reports: JSON.stringify(capability.result_reports),
    require_accessibility: capability.require_accessibility,
    linux_packages: capability.linux_packages.join(" "),
    oculix_chromium_disable_sandbox:
      capability.oculix_chromium_disable_sandbox ? "1" : "",
    use_xvfb: capability.use_xvfb,
    cost_class: capability.cost_class,
  };
}

export function planCapabilities({
  catalog,
  includeExperimental = false,
  selectors,
}) {
  validateCatalog(catalog);
  assertStringArray(selectors, "selectors");
  const indexes = selectionIndexes(catalog);
  const selected = new Map();
  let hasAllPreset = false;
  for (const selector of selectors) {
    if (
      selector === "ci:e2e:all" ||
      /^ci:e2e:[a-z0-9-]+:all$/u.test(selector)
    ) {
      hasAllPreset = true;
    }
    for (const capability of expandSelector(
      selector,
      catalog,
      indexes,
      includeExperimental,
    )) {
      selected.set(capability.id, capability);
    }
  }
  const capabilities = catalog.capabilities.filter((capability) =>
    selected.has(capability.id),
  );
  if (
    !hasAllPreset &&
    capabilities.length > catalog.guardrails.max_custom_cells
  ) {
    throw new Error(
      `Selection expands to ${capabilities.length} cells; ` +
        `the custom limit is ${catalog.guardrails.max_custom_cells}`,
    );
  }
  const total = capabilities.length;
  const include = capabilities.map((capability, index) =>
    executionCapability(capability, index + 1, total),
  );
  return {
    count: total,
    ids: capabilities.map((capability) => capability.id),
    skippedIds: catalog.capabilities
      .filter((capability) => !selected.has(capability.id))
      .map((capability) => capability.id),
    matrix: { include },
    maxParallel: catalog.guardrails.max_parallel,
  };
}

export function formatPlanSummary(plan) {
  const lines = [
    "### Selected browser E2E capabilities",
    "",
    `Selected **${plan.count}** capability cell(s).`,
    "",
  ];
  if (plan.count === 0) {
    lines.push("No catalog-selected E2E runner will be allocated.", "");
  } else {
    for (const capability of plan.matrix.include) {
      lines.push(
        `- \`${capability.id}\`: ${capability.runner}, ` +
          `${capability.browser}, ${capability.cost_class}`,
      );
    }
    lines.push("", `Maximum parallel jobs: **${plan.maxParallel}**.`, "");
  }
  lines.push("#### Skipped capabilities", "");
  if (plan.skippedIds.length === 0) {
    lines.push("- None.", "");
  } else {
    for (const id of plan.skippedIds) {
      lines.push(`- \`${id}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function parseJsonArray(name, value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
  assertStringArray(parsed, name);
  return parsed;
}

function outputLine(name, value, output) {
  output.write(`${name}=${value}\n`);
}

async function main(environment = process.env, output = process.stdout) {
  const catalog = await readCatalog(
    environment.E2E_CAPABILITY_CATALOG ?? DEFAULT_CATALOG_PATH,
  );
  let selectors;
  const selectionMode = environment.E2E_SELECTION_MODE ?? "selectors";
  if (!["dispatch", "labels", "selectors"].includes(selectionMode)) {
    throw new Error(`Unknown E2E selection mode: ${selectionMode}`);
  }
  if (selectionMode === "labels") {
    selectors = selectorsFromLabels(
      parseJsonArray("E2E_LABELS", environment.E2E_LABELS ?? "[]"),
    );
  } else if (selectionMode === "dispatch") {
    selectors = selectorsFromDispatch({
      preset: environment.E2E_PRESET ?? "none",
      selectors: environment.E2E_SELECTORS ?? "",
    });
  } else {
    selectors = parseJsonArray(
      "E2E_SELECTORS",
      environment.E2E_SELECTORS ?? "[]",
    );
  }
  const plan = planCapabilities({
    catalog,
    includeExperimental:
      environment.E2E_INCLUDE_EXPERIMENTAL === "true",
    selectors,
  });
  outputLine("count", plan.count, output);
  outputLine("matrix", JSON.stringify(plan.matrix), output);
  outputLine("max_parallel", plan.maxParallel, output);
  outputLine("selected_ids", JSON.stringify(plan.ids), output);
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(
      environment.GITHUB_STEP_SUMMARY,
      formatPlanSummary(plan),
    );
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
