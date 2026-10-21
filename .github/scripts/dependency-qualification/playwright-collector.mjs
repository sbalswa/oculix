import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

const PROVIDER_ID = "playwright";
const PACKAGE_DIRECTORY = "tests/e2e/playwright";
const PACKAGE_PATH = `${PACKAGE_DIRECTORY}/package.json`;
const LOCK_PATH = `${PACKAGE_DIRECTORY}/package-lock.json`;
const PACKAGE_COMPONENT = "playwright-package-cohort";
const BROWSER_COMPONENT = "playwright-chromium-bundle";
const NODE_COMPONENT = "node-runtime";
const DIRECT_PACKAGES = [
  "@axe-core/playwright",
  "@playwright/test",
];
const PACKAGE_NAMES = [
  "@axe-core/playwright",
  "@playwright/test",
  "playwright",
  "playwright-core",
];
const PACKAGE_TESTS = [
  "harness.test.mjs",
  "process-runner.test.mjs",
  "reporting.test.mjs",
];

class MetadataError extends Error {
  constructor(reasonCode, message, state = "unknown") {
    super(message);
    this.reasonCode = reasonCode;
    this.state = state;
  }
}

function sortedObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortedObject);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedObject(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(sortedObject(value));
}

function digest(value) {
  const payload = Buffer.isBuffer(value) ? value : stableJson(value);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function packageEntry(lockfile, name) {
  const entry = lockfile.packages?.[`node_modules/${name}`];
  if (entry === undefined) {
    throw new MetadataError(
      "CURRENT_PACKAGE_METADATA_MISSING",
      `package-lock.json does not contain node_modules/${name}`,
    );
  }
  return entry;
}

function exactString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetadataError(
      "PACKAGE_METADATA_INVALID",
      `${label} must be a nonempty string`,
    );
  }
  return value;
}

function currentPackageCohort(packageJson, lockfile) {
  const root = lockfile.packages?.[""];
  if (root === undefined) {
    throw new MetadataError(
      "CURRENT_PACKAGE_METADATA_MISSING",
      "package-lock.json does not contain its root package",
    );
  }
  const axe = exactString(
    packageJson.devDependencies?.["@axe-core/playwright"],
    "package.json @axe-core/playwright",
  );
  const test = exactString(
    packageJson.devDependencies?.["@playwright/test"],
    "package.json @playwright/test",
  );
  if (
    root.devDependencies?.["@axe-core/playwright"] !== axe ||
    root.devDependencies?.["@playwright/test"] !== test
  ) {
    throw new MetadataError(
      "CURRENT_DIRECT_DEPENDENCIES_MISMATCH",
      "package.json and package-lock.json direct Playwright pins differ",
    );
  }

  const axeEntry = packageEntry(lockfile, "@axe-core/playwright");
  const testEntry = packageEntry(lockfile, "@playwright/test");
  const playwrightEntry = packageEntry(lockfile, "playwright");
  const coreEntry = packageEntry(lockfile, "playwright-core");
  const playwright = exactString(
    testEntry.dependencies?.playwright,
    "@playwright/test dependency on playwright",
  );
  const core = exactString(
    playwrightEntry.dependencies?.["playwright-core"],
    "playwright dependency on playwright-core",
  );
  if (
    axeEntry.version !== axe ||
    testEntry.version !== test ||
    playwrightEntry.version !== playwright ||
    coreEntry.version !== core ||
    test !== playwright ||
    playwright !== core
  ) {
    throw new MetadataError(
      "CURRENT_LOCKSTEP_INVALID",
      "@playwright/test, playwright, and playwright-core are not exact lockstep pins",
    );
  }
  return {
    packages: {
      "@axe-core/playwright": axe,
      "@playwright/test": test,
      playwright,
      "playwright-core": core,
    },
    nodeRanges: Object.fromEntries(
      PACKAGE_NAMES.map((name) => [
        name,
        packageEntry(lockfile, name).engines?.node ?? "unspecified",
      ]),
    ),
    axePeerRange:
      axeEntry.peerDependencies?.["playwright-core"] ?? "unspecified",
  };
}

function registryVersion(packument, name, version = null) {
  const selected = version ?? packument?.["dist-tags"]?.latest;
  const record = packument?.versions?.[selected];
  if (
    typeof selected !== "string" ||
    record === undefined ||
    record.version !== selected ||
    record.name !== name ||
    typeof record.dist?.integrity !== "string" ||
    typeof record.dist?.tarball !== "string"
  ) {
    throw new MetadataError(
      "NPM_METADATA_INVALID",
      `npm metadata for ${name}${version === null ? "" : `@${version}`} is incomplete`,
    );
  }
  return record;
}

function candidatePackageCohort(packuments) {
  const test = registryVersion(
    packuments["@playwright/test"],
    "@playwright/test",
  );
  const axe = registryVersion(
    packuments["@axe-core/playwright"],
    "@axe-core/playwright",
  );
  const playwrightVersion = exactString(
    test.dependencies?.playwright,
    "@playwright/test candidate dependency on playwright",
  );
  const playwright = registryVersion(
    packuments.playwright,
    "playwright",
    playwrightVersion,
  );
  const coreVersion = exactString(
    playwright.dependencies?.["playwright-core"],
    "playwright candidate dependency on playwright-core",
  );
  const core = registryVersion(
    packuments["playwright-core"],
    "playwright-core",
    coreVersion,
  );
  if (
    test.version !== playwright.version ||
    playwright.version !== core.version
  ) {
    throw new MetadataError(
      "CANDIDATE_LOCKSTEP_INVALID",
      "@playwright/test, playwright, and playwright-core candidate metadata is not lockstep",
    );
  }
  return {
    records: {
      "@axe-core/playwright": axe,
      "@playwright/test": test,
      playwright,
      "playwright-core": core,
    },
    packages: Object.fromEntries(
      Object.entries({
        "@axe-core/playwright": axe,
        "@playwright/test": test,
        playwright,
        "playwright-core": core,
      }).map(([name, record]) => [name, record.version]),
    ),
    nodeRanges: Object.fromEntries(
      Object.entries({
        "@axe-core/playwright": axe,
        "@playwright/test": test,
        playwright,
        "playwright-core": core,
      }).map(([name, record]) => [
        name,
        record.engines?.node ?? "unspecified",
      ]),
    ),
    axePeerRange:
      axe.peerDependencies?.["playwright-core"] ?? "unspecified",
  };
}

function chromiumRecord(metadata) {
  const record = metadata?.browsers?.find(
    (browser) =>
      browser.name === "chromium" && browser.installByDefault !== false,
  );
  if (typeof record?.revision !== "string" || record.revision.length === 0) {
    throw new MetadataError(
      "BROWSER_METADATA_MISSING",
      "playwright-core browsers.json has no bundled Chromium revision",
    );
  }
  return record;
}

function normalizeBrowserMetadata(value, coreVersion) {
  const metadata = value?.metadata ?? value;
  return {
    metadata,
    locator:
      value?.locator ??
      `https://unpkg.com/playwright-core@${coreVersion}/browsers.json`,
    record: chromiumRecord(metadata),
  };
}

function repositoryEvidence(path, contents, revision, observedAt) {
  return {
    type: "repository-file",
    locator: path,
    revision,
    digest: digest(contents),
    observed_at: observedAt,
  };
}

function npmEvidence(record, observedAt) {
  return {
    type: "npm-package-metadata",
    locator: record.dist.tarball,
    revision: record.version,
    digest: digest(record),
    observed_at: observedAt,
  };
}

function browserEvidence(browser, coreVersion, observedAt) {
  return {
    type: "playwright-browser-metadata",
    locator: browser.locator,
    revision: `${coreVersion}:${browser.record.revision}`,
    digest: digest(browser.metadata),
    observed_at: observedAt,
  };
}

function packageVersion(packages) {
  return stableJson(packages);
}

function browserVersion(record) {
  return stableJson({
    name: "chromium",
    revision: record?.revision ?? "unknown",
  });
}

function relationConstraint(value) {
  return stableJson(value);
}

function selectedPlaywrightCapabilities(catalog) {
  return catalog.capabilities
    .filter((capability) => capability.tool === "playwright")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function baseComponents({
  affectedCapabilities,
  current,
  currentBrowser,
  currentEvidence,
  currentBrowserEvidence,
}) {
  return [
    {
      id: PACKAGE_COMPONENT,
      lane: PROVIDER_ID,
      ecosystem: "npm",
      current: {
        version: packageVersion(current.packages),
        evidence: currentEvidence,
      },
      candidate: null,
      eventual_managed_paths: [PACKAGE_PATH],
      affected_capabilities: affectedCapabilities,
    },
    {
      id: BROWSER_COMPONENT,
      lane: PROVIDER_ID,
      ecosystem: "playwright",
      current: {
        version: browserVersion(currentBrowser?.record),
        evidence: currentBrowserEvidence,
      },
      candidate: null,
      eventual_managed_paths: [LOCK_PATH],
      affected_capabilities: affectedCapabilities,
    },
  ];
}

function relationsFor(cohort, browser) {
  const lockstep = {
    "@playwright/test": cohort.packages["@playwright/test"],
    playwright: cohort.packages.playwright,
    "playwright-core": cohort.packages["playwright-core"],
  };
  return [
    {
      id: "playwright-lockstep",
      type: "must-match",
      from: PACKAGE_COMPONENT,
      to: BROWSER_COMPONENT,
      hard: true,
      constraint: relationConstraint(lockstep),
    },
    {
      id: "playwright-node-ranges",
      type: "requires",
      from: PACKAGE_COMPONENT,
      to: NODE_COMPONENT,
      hard: true,
      constraint: relationConstraint(cohort.nodeRanges),
    },
    {
      id: "playwright-bundled-chromium",
      type: "bundles",
      from: PACKAGE_COMPONENT,
      to: BROWSER_COMPONENT,
      hard: true,
      constraint: relationConstraint({
        package: `playwright-core@${cohort.packages["playwright-core"]}`,
        browser: "chromium",
        revision: browser?.record.revision ?? "unknown",
      }),
    },
    {
      id: "playwright-axe-alignment",
      type: "policy-align",
      from: PACKAGE_COMPONENT,
      to: BROWSER_COMPONENT,
      hard: false,
      constraint: relationConstraint({
        package:
          `@axe-core/playwright@${cohort.packages["@axe-core/playwright"]}`,
        peer: `playwright-core@${cohort.axePeerRange}`,
      }),
    },
  ];
}

async function metadataCall(provider, argument, reasonCode) {
  try {
    return await provider(argument);
  } catch (error) {
    throw new MetadataError(
      reasonCode,
      `${argument} metadata could not be retrieved: ${error.message}`,
      "unavailable",
    );
  }
}

export async function fetchNpmMetadata(name) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchPlaywrightBrowserMetadata(coreVersion) {
  const locator =
    `https://unpkg.com/playwright-core@${coreVersion}/browsers.json`;
  const response = await fetch(locator, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`browser metadata returned HTTP ${response.status}`);
  }
  return {
    locator,
    metadata: await response.json(),
  };
}

export async function collectPlaywrightCohort({
  repositoryRoot,
  repository,
  generatedAt,
  capabilityPath = join(repositoryRoot, "tests/e2e/capabilities.json"),
  npmMetadata = fetchNpmMetadata,
  browserMetadata = fetchPlaywrightBrowserMetadata,
}) {
  const observedAt = timestamp(generatedAt);
  const packageFile = join(repositoryRoot, PACKAGE_PATH);
  const lockFile = join(repositoryRoot, LOCK_PATH);
  const [packageContents, lockContents, catalogContents] = await Promise.all([
    readFile(packageFile),
    readFile(lockFile),
    readFile(capabilityPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageContents);
  const lockfile = JSON.parse(lockContents);
  const catalog = JSON.parse(catalogContents);
  const catalogBinding = await readCapabilityCatalog(capabilityPath);
  const capabilityRows = selectedPlaywrightCapabilities(catalog);
  const affectedCapabilities = capabilityRows.map(({ id }) => id);
  if (affectedCapabilities.length === 0) {
    throw new Error("Capability catalog contains no Playwright capabilities");
  }
  const current = currentPackageCohort(packageJson, lockfile);
  const currentEvidence = [
    repositoryEvidence(
      PACKAGE_PATH,
      packageContents,
      repository.revision,
      observedAt,
    ),
    repositoryEvidence(
      LOCK_PATH,
      lockContents,
      repository.revision,
      observedAt,
    ),
  ];

  let currentBrowser = null;
  let browserProblem = null;
  try {
    currentBrowser = normalizeBrowserMetadata(
      await metadataCall(
        browserMetadata,
        current.packages["playwright-core"],
        "BROWSER_METADATA_UNAVAILABLE",
      ),
      current.packages["playwright-core"],
    );
  } catch (error) {
    browserProblem = error;
  }
  const currentBrowserEvidence = currentBrowser === null
    ? [
        repositoryEvidence(
          LOCK_PATH,
          lockContents,
          repository.revision,
          observedAt,
        ),
      ]
    : [
        browserEvidence(
          currentBrowser,
          current.packages["playwright-core"],
          observedAt,
        ),
      ];
  const components = baseComponents({
    affectedCapabilities,
    current,
    currentBrowser,
    currentEvidence,
    currentBrowserEvidence,
  });

  let candidate;
  try {
    const entries = await Promise.all(
      PACKAGE_NAMES.map(async (name) => [
        name,
        await metadataCall(
          npmMetadata,
          name,
          "NPM_METADATA_UNAVAILABLE",
        ),
      ]),
    );
    candidate = candidatePackageCohort(Object.fromEntries(entries));
  } catch (error) {
    const problem = error instanceof MetadataError
      ? error
      : new MetadataError("NPM_METADATA_INVALID", error.message);
    const document = {
      schema_version: 1,
      kind: "observation",
      generated_at: observedAt,
      repository,
      capability_catalog: {
        schema_version: catalogBinding.schemaVersion,
        digest: catalogBinding.digest,
      },
      provider_id: PROVIDER_ID,
      disposition: {
        state: problem.state,
        reason_codes: uniqueSorted([
          problem.reasonCode,
          ...(browserProblem === null ? [] : [browserProblem.reasonCode]),
        ]),
      },
      components,
      relations: relationsFor(current, currentBrowser),
    };
    validateDocument(document, {
      capabilityIds: catalogBinding.ids,
      capabilityCatalogDigest: catalogBinding.digest,
    });
    return document;
  }

  const packageChanged =
    packageVersion(candidate.packages) !== packageVersion(current.packages);
  if (!packageChanged && browserProblem === null) {
    const document = {
      schema_version: 1,
      kind: "observation",
      generated_at: observedAt,
      repository,
      capability_catalog: {
        schema_version: catalogBinding.schemaVersion,
        digest: catalogBinding.digest,
      },
      provider_id: PROVIDER_ID,
      disposition: { state: "current", reason_codes: [] },
      components,
      relations: relationsFor(current, currentBrowser),
    };
    validateDocument(document, {
      capabilityIds: catalogBinding.ids,
      capabilityCatalogDigest: catalogBinding.digest,
    });
    return document;
  }

  let candidateBrowser = null;
  if (packageChanged) {
    try {
      candidateBrowser = normalizeBrowserMetadata(
        await metadataCall(
          browserMetadata,
          candidate.packages["playwright-core"],
          "BROWSER_METADATA_UNAVAILABLE",
        ),
        candidate.packages["playwright-core"],
      );
    } catch (error) {
      browserProblem ??= error;
    }
    components[0].candidate = {
      version: packageVersion(candidate.packages),
      evidence: PACKAGE_NAMES.map((name) =>
        npmEvidence(candidate.records[name], observedAt)),
    };
    if (candidateBrowser !== null) {
      components[1].candidate = {
        version: browserVersion(candidateBrowser.record),
        evidence: [
          browserEvidence(
            candidateBrowser,
            candidate.packages["playwright-core"],
            observedAt,
          ),
        ],
      };
    }
  }

  const document = {
    schema_version: 1,
    kind: "observation",
    generated_at: observedAt,
    repository,
    capability_catalog: {
      schema_version: catalogBinding.schemaVersion,
      digest: catalogBinding.digest,
    },
    provider_id: PROVIDER_ID,
    disposition: browserProblem === null
      ? {
          state: "candidate",
          reason_codes: ["CANDIDATE_AVAILABLE"],
        }
      : {
          state: browserProblem.state,
          reason_codes: [browserProblem.reasonCode],
        },
    components,
    relations: relationsFor(
      packageChanged ? candidate : current,
      candidateBrowser ?? currentBrowser,
    ),
  };
  validateDocument(document, {
    capabilityIds: catalogBinding.ids,
    capabilityCatalogDigest: catalogBinding.digest,
  });
  return document;
}

function decodedCandidate(observation) {
  const packages = observation.components.find(
    ({ id }) => id === PACKAGE_COMPONENT,
  )?.candidate;
  const browser = observation.components.find(
    ({ id }) => id === BROWSER_COMPONENT,
  )?.candidate;
  if (packages === null || packages === undefined || browser == null) {
    throw new Error("Observation does not contain a complete Playwright candidate");
  }
  return {
    packages: JSON.parse(packages.version),
    browser: JSON.parse(browser.version),
  };
}

export function createPlaywrightQualificationPlan({
  observation,
  workspaceRoot,
  capabilityCatalog,
}) {
  if (observation.disposition.state !== "candidate") {
    throw new Error("Only candidate observations can be qualified");
  }
  const candidate = decodedCandidate(observation);
  const capabilities = selectedPlaywrightCapabilities(capabilityCatalog)
    .filter(({ id }) =>
      observation.components.some(
        (component) =>
          component.candidate !== null &&
          component.affected_capabilities.includes(id),
      ));
  const packageRoot = join(workspaceRoot, PACKAGE_DIRECTORY);
  const harness = join(packageRoot, "harness.mjs");
  const environmentFor = (capability) => ({
    E2E_BROWSER: capability.browser,
    E2E_OS: capability.os,
    PLAYWRIGHT_PROJECT: capability.browser,
  });
  return {
    provider_id: PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    workspace_root: workspaceRoot,
    managed_paths: [PACKAGE_PATH, LOCK_PATH],
    capabilities: capabilities.map(({ id }) => id),
    apply: {
      id: "apply-candidate",
      phase: "apply",
      command: "npm",
      arguments: [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-dev",
        "--save-exact",
        ...DIRECT_PACKAGES.map((name) => `${name}@${candidate.packages[name]}`),
      ],
      cwd: packageRoot,
      capability_id: null,
      environment: {},
    },
    preparation: capabilities.map((capability) => ({
      id: `prepare-${capability.id}`,
      phase: "prepare",
      command: process.execPath,
      arguments: [harness, "prepare", capability.browser],
      cwd: packageRoot,
      capability_id: capability.id,
      environment: environmentFor(capability),
    })),
    package_tests: {
      id: "playwright-package-tests",
      phase: "package-test",
      command: process.execPath,
      arguments: [
        "--test",
        ...PACKAGE_TESTS.map((name) => join(packageRoot, name)),
      ],
      cwd: packageRoot,
      capability_id: null,
      environment: {},
    },
    execution: capabilities.flatMap((capability) =>
      [...capability.scenarios].sort().map((scenario) => ({
        id: `${capability.id}-${scenario}`,
        phase: "capability",
        command: process.execPath,
        arguments: [harness, "scenario", scenario, capability.browser],
        cwd: packageRoot,
        capability_id: capability.id,
        scenario,
        environment: environmentFor(capability),
      }))),
    expected_artifacts: Object.fromEntries(
      capabilities.map((capability) => [
        capability.id,
        {
          evidence: capability.evidence,
          require_accessibility: capability.require_accessibility,
          required_files: capability.required_files,
          result_reports: capability.result_reports,
          scenarios: capability.scenarios,
        },
      ]),
    ),
  };
}

async function defaultCreateWorkspace(sourceRoot) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "oculix-playwright-qualification-"),
  );
  const workspaceRoot = join(temporaryRoot, "repository");
  await cp(sourceRoot, workspaceRoot, {
    recursive: true,
    filter(source) {
      const repositoryPath = relative(sourceRoot, source);
      if (repositoryPath === "") {
        return true;
      }
      const parts = repositoryPath.split(sep);
      if (parts.includes(".git") || parts.includes("node_modules")) {
        return false;
      }
      return !repositoryPath
        .split(sep)
        .join("/")
        .startsWith(`${PACKAGE_DIRECTORY}/test-results`);
    },
  });
  return {
    root: workspaceRoot,
    async cleanup() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

function warningLines(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bwarn(?:ing)?\b/iu.test(line));
}

export async function runQualificationStep(step) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(step.command, step.arguments, {
      cwd: step.cwd,
      env: {
        ...process.env,
        ...step.environment,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode, signal) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        signal,
        stdout,
        stderr,
        warnings: uniqueSorted([
          ...warningLines(stdout),
          ...warningLines(stderr),
        ]),
      });
    });
  });
}

async function verifyAppliedCandidate(workspaceRoot, candidate) {
  const packageJson = await readJson(join(workspaceRoot, PACKAGE_PATH));
  const lockfile = await readJson(join(workspaceRoot, LOCK_PATH));
  const applied = currentPackageCohort(packageJson, lockfile);
  if (packageVersion(applied.packages) !== packageVersion(candidate.packages)) {
    throw new Error("Ephemeral package state does not match the candidate cohort");
  }
}

async function filesBelow(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  await visit(root);
  return result.sort();
}

function globExpression(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/u, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

async function defaultInspectCapability({
  workspaceRoot,
  capability,
}) {
  const allFiles = await filesBelow(workspaceRoot);
  const problems = [];
  const matchedFiles = new Set();
  for (const pattern of capability.required_files) {
    const matcher = globExpression(pattern);
    const matches = allFiles.filter((path) => matcher.test(path));
    if (matches.length === 0) {
      problems.push(`missing required artifact ${pattern}`);
    }
    matches.forEach((path) => matchedFiles.add(path));
  }
  if (!allFiles.includes(capability.evidence)) {
    problems.push(`missing primary evidence ${capability.evidence}`);
  } else {
    matchedFiles.add(capability.evidence);
  }

  const observedScenarios = new Set();
  for (const reportPath of capability.result_reports) {
    if (!allFiles.includes(reportPath)) {
      problems.push(`missing result report ${reportPath}`);
      continue;
    }
    matchedFiles.add(reportPath);
    let report;
    try {
      report = await readJson(join(workspaceRoot, reportPath));
    } catch (error) {
      problems.push(`invalid result report ${reportPath}: ${error.message}`);
      continue;
    }
    if (
      report.capabilityId !== capability.id ||
      report.status !== "passed" ||
      report.assertion?.status !== "passed"
    ) {
      problems.push(`result report ${reportPath} did not pass for ${capability.id}`);
    }
    if (typeof report.scenario === "string") {
      observedScenarios.add(report.scenario);
    }
    if (
      capability.require_accessibility &&
      report.scenario === "web-calculator" &&
      (report.accessibility?.status !== "passed" ||
        report.accessibility?.counts?.violations?.rules !== 0)
    ) {
      problems.push(`result report ${reportPath} failed accessibility policy`);
    }
  }
  for (const scenario of capability.scenarios) {
    if (!observedScenarios.has(scenario)) {
      problems.push(`missing passing result for scenario ${scenario}`);
    }
  }

  const artifactEvidence = [];
  for (const path of [...matchedFiles].sort()) {
    artifactEvidence.push({
      path,
      digest: digest(await readFile(join(workspaceRoot, path))),
    });
  }
  return {
    passed: problems.length === 0,
    problems,
    warnings: [],
    digest: digest(artifactEvidence),
  };
}

function normalizeStepResult(result) {
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
    signal: result?.signal ?? null,
    warnings: uniqueSorted(result?.warnings ?? []),
  };
}

async function snapshotSource(repositoryRoot) {
  return new Map(
    await Promise.all(
      [PACKAGE_PATH, LOCK_PATH].map(async (path) => [
        path,
        await readFile(join(repositoryRoot, path)),
      ]),
    ),
  );
}

async function restoreChangedSource(repositoryRoot, snapshot) {
  const changed = [];
  for (const [path, original] of snapshot) {
    const absolutePath = join(repositoryRoot, path);
    let current;
    try {
      current = await readFile(absolutePath);
    } catch {
      current = null;
    }
    if (current === null || !current.equals(original)) {
      changed.push(path);
      await writeFile(absolutePath, original);
    }
  }
  return changed;
}

function qualificationEvidence({
  capabilityId,
  repositoryRevision,
  transcript,
  artifactDigest,
  startedAt,
  completedAt,
}) {
  return [{
    type: "ephemeral-qualification",
    locator: `playwright-qualification:${capabilityId}`,
    revision: repositoryRevision,
    digest: digest({
      artifactDigest,
      steps: transcript.map(({ id, exitCode, signal, warnings }) => ({
        id,
        exitCode,
        signal,
        warnings,
      })),
    }),
    started_at: startedAt,
    completed_at: completedAt,
  }];
}

function unavailableValidation({
  observation,
  capabilityIds,
  generatedAt,
  reasonCodes,
}) {
  const state = observation.disposition.state === "unavailable"
    ? "unavailable"
    : "unknown";
  return {
    schema_version: 1,
    kind: "validation",
    generated_at: generatedAt,
    repository: observation.repository,
    capability_catalog: observation.capability_catalog,
    provider_id: PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    disposition: {
      state,
      reason_codes: uniqueSorted(reasonCodes),
    },
    results: capabilityIds.map((capabilityId) => ({
      capability_id: capabilityId,
      status: "unknown",
      warnings: [],
      evidence: qualificationEvidence({
        capabilityId,
        repositoryRevision: observation.repository.revision,
        transcript: [],
        artifactDigest: null,
        startedAt: generatedAt,
        completedAt: generatedAt,
      }),
    })),
  };
}

export async function qualifyPlaywrightCandidate({
  observation,
  repositoryRoot,
  generatedAt,
  capabilityPath = join(repositoryRoot, "tests/e2e/capabilities.json"),
  createWorkspace = defaultCreateWorkspace,
  runStep = runQualificationStep,
  inspectCapability = defaultInspectCapability,
}) {
  const qualificationStartedAt = timestamp(generatedAt);
  const catalog = await readJson(capabilityPath);
  const catalogBinding = await readCapabilityCatalog(capabilityPath);
  const contractOptions = {
    capabilityIds: catalogBinding.ids,
    capabilityCatalogDigest: catalogBinding.digest,
  };
  const affectedCapabilities = uniqueSorted(
    observation.components.flatMap((component) =>
      component.affected_capabilities),
  );
  if (observation.disposition.state !== "candidate") {
    const validation = unavailableValidation({
      observation,
      capabilityIds: affectedCapabilities,
      generatedAt: qualificationStartedAt,
      reasonCodes: [
        ...observation.disposition.reason_codes,
        "CANDIDATE_NOT_AVAILABLE",
      ],
    });
    validateDocument(validation, contractOptions);
    return validation;
  }

  const candidate = decodedCandidate(observation);
  const sourceSnapshot = await snapshotSource(repositoryRoot);
  const transcript = [];
  const capabilityFailures = new Map(
    affectedCapabilities.map((id) => [id, []]),
  );
  const capabilityWarnings = new Map(
    affectedCapabilities.map((id) => [id, []]),
  );
  const artifactResults = new Map();
  const globalFailures = [];
  let workspace = null;
  let plan = null;

  async function execute(step) {
    let result;
    try {
      result = normalizeStepResult(await runStep(step));
    } catch (error) {
      result = {
        exitCode: 1,
        signal: null,
        warnings: [],
        error: error.message,
      };
    }
    transcript.push({ id: step.id, ...result });
    const warningTarget = step.capability_id === null
      ? affectedCapabilities
      : [step.capability_id];
    for (const capabilityId of warningTarget) {
      capabilityWarnings.get(capabilityId).push(...result.warnings);
    }
    return result;
  }

  try {
    workspace = await createWorkspace(repositoryRoot);
    plan = createPlaywrightQualificationPlan({
      observation,
      workspaceRoot: workspace.root,
      capabilityCatalog: catalog,
    });

    const applyResult = await execute(plan.apply);
    if (applyResult.exitCode !== 0) {
      globalFailures.push("APPLICATION_FAILED");
    } else {
      try {
        await verifyAppliedCandidate(workspace.root, candidate);
      } catch {
        globalFailures.push("APPLICATION_FAILED");
      }
    }

    if (globalFailures.length === 0) {
      for (const step of plan.preparation) {
        const result = await execute(step);
        if (result.exitCode !== 0) {
          capabilityFailures.get(step.capability_id).push(
            "PREPARATION_FAILED",
          );
        }
      }

      const packageResult = await execute(plan.package_tests);
      if (packageResult.exitCode !== 0) {
        globalFailures.push("PACKAGE_TESTS_FAILED");
      }

      if (globalFailures.length === 0) {
        for (const step of plan.execution) {
          if (capabilityFailures.get(step.capability_id).length > 0) {
            continue;
          }
          const result = await execute(step);
          if (result.exitCode !== 0) {
            capabilityFailures.get(step.capability_id).push(
              "EXECUTION_FAILED",
            );
          }
        }
      }

      if (globalFailures.length === 0) {
        const capabilitiesById = new Map(
          selectedPlaywrightCapabilities(catalog)
            .map((capability) => [capability.id, capability]),
        );
        for (const capabilityId of affectedCapabilities) {
          if (capabilityFailures.get(capabilityId).length > 0) {
            continue;
          }
          const inspection = await inspectCapability({
            workspaceRoot: workspace.root,
            capability: capabilitiesById.get(capabilityId),
          });
          artifactResults.set(capabilityId, inspection);
          capabilityWarnings.get(capabilityId).push(
            ...(inspection.warnings ?? []),
          );
          if (!inspection.passed) {
            capabilityFailures.get(capabilityId).push(
              "ARTIFACT_VALIDATION_FAILED",
            );
          }
        }
      }
    }
  } catch {
    globalFailures.push("QUALIFICATION_INFRASTRUCTURE_FAILED");
  } finally {
    const changedSource = await restoreChangedSource(
      repositoryRoot,
      sourceSnapshot,
    );
    if (changedSource.length > 0) {
      globalFailures.push("PACKAGE_STATE_MUTATED");
    }
    await workspace?.cleanup?.();
  }

  const qualificationCompletedAt = timestamp(generatedAt);
  const results = affectedCapabilities.map((capabilityId) => {
    const failures = uniqueSorted([
      ...globalFailures,
      ...capabilityFailures.get(capabilityId),
    ]);
    const warnings = uniqueSorted(capabilityWarnings.get(capabilityId));
    return {
      capability_id: capabilityId,
      status: failures.length === 0 ? "pass" : "fail",
      warnings,
      evidence: qualificationEvidence({
        capabilityId,
        repositoryRevision: observation.repository.revision,
        transcript: transcript.filter((step) => {
          const plannedStep = [
            plan?.apply,
            plan?.package_tests,
            ...(plan?.preparation ?? []),
            ...(plan?.execution ?? []),
          ].find(({ id } = {}) => id === step.id);
          return plannedStep?.capability_id == null ||
            plannedStep.capability_id === capabilityId;
        }),
        artifactDigest: artifactResults.get(capabilityId)?.digest ?? null,
        startedAt: qualificationStartedAt,
        completedAt: qualificationCompletedAt,
      }),
    };
  });
  const reasonCodes = uniqueSorted([
    ...globalFailures,
    ...[...capabilityFailures.values()].flat(),
    ...(results.some((result) => result.warnings.length > 0)
      ? ["VALIDATION_WARNINGS"]
      : []),
  ]);
  const qualified = results.every(
    (result) => result.status === "pass" && result.warnings.length === 0,
  );
  const validation = {
    schema_version: 1,
    kind: "validation",
    generated_at: qualificationCompletedAt,
    repository: observation.repository,
    capability_catalog: observation.capability_catalog,
    provider_id: PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    disposition: qualified
      ? { state: "independently-qualified", reason_codes: [] }
      : { state: "blocked", reason_codes: reasonCodes },
    results,
  };
  validateDocument(validation, contractOptions);
  if (qualified) {
    validateIndependentQualification(
      observation,
      validation,
      contractOptions,
    );
  }
  return validation;
}

export const PLAYWRIGHT_MANAGED_PATHS = [PACKAGE_PATH, LOCK_PATH];
