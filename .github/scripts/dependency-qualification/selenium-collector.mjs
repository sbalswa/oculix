import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { validateCatalog } from "../plan-e2e.mjs";
import {
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

const execFileAsync = promisify(execFile);

export const SELENIUM_PACKAGE_DIRECTORY = "tests/e2e/selenium";
export const SELENIUM_MANAGED_PATHS = Object.freeze([
  `${SELENIUM_PACKAGE_DIRECTORY}/package.json`,
  `${SELENIUM_PACKAGE_DIRECTORY}/package-lock.json`,
]);
export const SELENIUM_PROVIDER_ID = "selenium";

const AXE_PACKAGE = "@axe-core/webdriverjs";
const SELENIUM_PACKAGE = "selenium-webdriver";
const PACKAGE_NAMES = Object.freeze([AXE_PACKAGE, SELENIUM_PACKAGE]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        return compareText(leftJson, rightJson);
      });
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  const content =
    typeof value === "string"
      ? value
      : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function parseJson(content, path) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} must contain valid JSON: ${error.message}`);
  }
}

function requireObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}

function requireVersion(value, path) {
  requireString(value, path);
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`${path} must be a stable numeric version`);
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = requireVersion(left, "left version")
    .split(".")
    .map(Number);
  const rightParts = requireVersion(right, "right version")
    .split(".")
    .map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function repositoryEvidence(path, revision, content, observedAt) {
  return {
    type: "repository-file",
    locator: path,
    revision,
    digest: sha256(content),
    observed_at: observedAt,
  };
}

function npmEvidence(metadata, observedAt) {
  return {
    type: "npm-package",
    locator: metadata.dist.tarball,
    revision: metadata.version,
    digest: sha256(metadata),
    observed_at: observedAt,
  };
}

function runnerContractEvidence(kind, evidence, observedAt) {
  return {
    type: `runner-${kind}`,
    locator: evidence.locator,
    revision: evidence.version,
    digest: evidence.digest,
    observed_at: observedAt,
  };
}

function catalogDigest(catalog) {
  return sha256(catalog);
}

function readCurrentPackages(packageJson, packageLock) {
  const manifest = requireObject(packageJson, "package.json");
  const dependencies = requireObject(
    manifest.dependencies,
    "package.json.dependencies",
  );
  const rootLock = requireObject(
    packageLock?.packages?.[""],
    'package-lock.json.packages[""]',
  );
  const lockedDependencies = requireObject(
    rootLock.dependencies,
    'package-lock.json.packages[""].dependencies',
  );
  const rootNodeRange = requireString(
    manifest.engines?.node,
    "package.json.engines.node",
  );
  if (rootLock.engines?.node !== rootNodeRange) {
    throw new Error(
      "package-lock.json root Node range must match package.json",
    );
  }

  const current = {};
  for (const packageName of PACKAGE_NAMES) {
    const declared = requireVersion(
      dependencies[packageName],
      `package.json.dependencies[${JSON.stringify(packageName)}]`,
    );
    if (lockedDependencies[packageName] !== declared) {
      throw new Error(
        `package-lock.json root dependency ${packageName} must match package.json`,
      );
    }
    const locked = requireObject(
      packageLock.packages[`node_modules/${packageName}`],
      `package-lock.json package ${packageName}`,
    );
    const lockedVersion = requireVersion(
      locked.version,
      `package-lock.json ${packageName}.version`,
    );
    if (lockedVersion !== declared) {
      throw new Error(
        `package-lock.json ${packageName} version must match package.json`,
      );
    }
    current[packageName] = {
      version: declared,
      nodeRange: requireString(
        locked.engines?.node,
        `package-lock.json ${packageName}.engines.node`,
      ),
      resolved: requireString(
        locked.resolved,
        `package-lock.json ${packageName}.resolved`,
      ),
      integrity: requireString(
        locked.integrity,
        `package-lock.json ${packageName}.integrity`,
      ),
      dependencies: locked.dependencies ?? {},
      peerDependencies: locked.peerDependencies ?? {},
    };
  }
  return { current, rootNodeRange };
}

function normalizeNpmMetadata(packageName, value) {
  const metadata = requireObject(value, `npm metadata for ${packageName}`);
  if (metadata.name !== packageName) {
    throw new Error(`npm metadata name must equal ${packageName}`);
  }
  const normalized = {
    name: packageName,
    version: requireVersion(
      metadata.version,
      `npm metadata ${packageName}.version`,
    ),
    dist: {
      tarball: requireString(
        metadata.dist?.tarball,
        `npm metadata ${packageName}.dist.tarball`,
      ),
      integrity: requireString(
        metadata.dist?.integrity,
        `npm metadata ${packageName}.dist.integrity`,
      ),
    },
    engines: {
      node: requireString(
        metadata.engines?.node,
        `npm metadata ${packageName}.engines.node`,
      ),
    },
  };
  if (packageName === AXE_PACKAGE) {
    normalized.dependencies = {
      "axe-core": requireString(
        metadata.dependencies?.["axe-core"],
        `npm metadata ${packageName}.dependencies["axe-core"]`,
      ),
    };
    normalized.peerDependencies = {
      "selenium-webdriver": requireString(
        metadata.peerDependencies?.["selenium-webdriver"],
        `npm metadata ${packageName}.peerDependencies["selenium-webdriver"]`,
      ),
    };
  }
  return normalized;
}

function normalizeRunnerEvidence(value, capabilities) {
  const evidence = requireObject(value, "runnerEvidence");
  const browser = requireObject(
    evidence.browser,
    "runnerEvidence.browser",
  );
  const driver = requireObject(evidence.driver, "runnerEvidence.driver");
  const normalized = {
    runner: requireString(evidence.runner, "runnerEvidence.runner"),
    browser: {
      name: requireString(browser.name, "runnerEvidence.browser.name"),
      version: requireString(
        browser.version,
        "runnerEvidence.browser.version",
      ),
      compatibilityKey: requireString(
        browser.compatibility_key,
        "runnerEvidence.browser.compatibility_key",
      ),
      locator: requireString(
        browser.locator,
        "runnerEvidence.browser.locator",
      ),
      digest: requireString(
        browser.digest,
        "runnerEvidence.browser.digest",
      ),
      path: requireString(browser.path, "runnerEvidence.browser.path"),
    },
    driver: {
      name: requireString(driver.name, "runnerEvidence.driver.name"),
      version: requireString(
        driver.version,
        "runnerEvidence.driver.version",
      ),
      compatibilityKey: requireString(
        driver.compatibility_key,
        "runnerEvidence.driver.compatibility_key",
      ),
      locator: requireString(
        driver.locator,
        "runnerEvidence.driver.locator",
      ),
      digest: requireString(
        driver.digest,
        "runnerEvidence.driver.digest",
      ),
      path: requireString(driver.path, "runnerEvidence.driver.path"),
    },
  };
  for (const [kind, item] of [
    ["browser", normalized.browser],
    ["driver", normalized.driver],
  ]) {
    if (!SHA256_PATTERN.test(item.digest)) {
      throw new Error(`runnerEvidence.${kind}.digest must be a SHA-256 digest`);
    }
    if (!isAbsolute(item.path)) {
      throw new Error(`runnerEvidence.${kind}.path must be absolute`);
    }
  }
  const runners = new Set(capabilities.map((capability) => capability.runner));
  if (runners.size !== 1 || !runners.has(normalized.runner)) {
    throw new Error(
      "runner evidence must identify the selected Selenium runner",
    );
  }
  const browsers = new Set(
    capabilities.map((capability) => capability.browser),
  );
  if (browsers.size !== 1 || !browsers.has(normalized.browser.name)) {
    throw new Error(
      "runner browser evidence must identify the selected catalog browser",
    );
  }
  if (normalized.driver.name !== "chromedriver") {
    throw new Error("runner driver evidence must identify chromedriver");
  }
  return normalized;
}

function selectCapabilities(catalog, selectedCapabilityIds) {
  validateCatalog(catalog);
  const seleniumCapabilities = catalog.capabilities.filter(
    (capability) => capability.tool === SELENIUM_PROVIDER_ID,
  );
  const byId = new Map(
    seleniumCapabilities.map((capability) => [capability.id, capability]),
  );
  const ids =
    selectedCapabilityIds === undefined
      ? [...byId.keys()]
      : [...selectedCapabilityIds];
  if (
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(
      "selectedCapabilityIds must contain unique Selenium capability IDs",
    );
  }
  const selected = ids.map((id) => {
    const capability = byId.get(id);
    if (capability === undefined) {
      throw new Error(`Unknown selected Selenium capability ${id}`);
    }
    return capability;
  });
  return selected.sort((left, right) => compareText(left.id, right.id));
}

function nodeConstraint(rootRange, currentRange, candidateRange) {
  return [
    `root=${rootRange}`,
    `current=${currentRange}`,
    `candidate=${candidateRange ?? "none"}`,
  ].join(";");
}

function axeConstraint(current, candidate) {
  const currentAxe = requireString(
    current.dependencies?.["axe-core"],
    "locked axe-core range",
  );
  const currentSelenium = requireString(
    current.peerDependencies?.["selenium-webdriver"],
    "locked Selenium peer range",
  );
  return [
    `current-axe-core=${currentAxe}`,
    `current-selenium-peer=${currentSelenium}`,
    `candidate-axe-core=${candidate?.dependencies?.["axe-core"] ?? "none"}`,
    `candidate-selenium-peer=${
      candidate?.peerDependencies?.["selenium-webdriver"] ?? "none"
    }`,
  ].join(";");
}

function runnerConstraint(runnerEvidence) {
  if (runnerEvidence === null) {
    return "runner-evidence=missing";
  }
  return [
    `runner=${runnerEvidence.runner}`,
    `browser=${runnerEvidence.browser.name}@${runnerEvidence.browser.version}`,
    `driver=${runnerEvidence.driver.name}@${runnerEvidence.driver.version}`,
    `browser-key=${runnerEvidence.browser.compatibilityKey}`,
    `driver-key=${runnerEvidence.driver.compatibilityKey}`,
  ].join(";");
}

function packageComponent({
  affectedCapabilities,
  candidate,
  candidateEvidence,
  current,
  currentEvidence,
  id,
  managedPath,
}) {
  return {
    id,
    lane: SELENIUM_PROVIDER_ID,
    ecosystem: "npm",
    current: {
      version: current.version,
      evidence: currentEvidence,
    },
    candidate:
      candidate === null
        ? null
        : {
            version: candidate.version,
            evidence: candidateEvidence,
          },
    eventual_managed_paths: [managedPath],
    affected_capabilities: affectedCapabilities,
  };
}

export async function readNpmMetadata(
  packageName,
  { execute = execFileAsync } = {},
) {
  const { stdout } = await execute(
    "npm",
    [
      "view",
      `${packageName}@latest`,
      "name",
      "version",
      "dist",
      "engines",
      "dependencies",
      "peerDependencies",
      "--json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  return parseJson(stdout, `npm metadata for ${packageName}`);
}

export async function collectSeleniumObservation({
  repositoryRoot,
  repository,
  generatedAt = new Date().toISOString(),
  npm = readNpmMetadata,
  runnerEvidence,
  selectedCapabilityIds,
} = {}) {
  requireString(repositoryRoot, "repositoryRoot");
  requireObject(repository, "repository");
  requireString(repository.name, "repository.name");
  requireString(repository.revision, "repository.revision");

  const packagePath = resolve(repositoryRoot, SELENIUM_MANAGED_PATHS[0]);
  const lockPath = resolve(repositoryRoot, SELENIUM_MANAGED_PATHS[1]);
  const catalogPath = resolve(repositoryRoot, "tests/e2e/capabilities.json");
  const [packageContent, lockContent, catalogContent] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(catalogPath, "utf8"),
  ]);
  const packageJson = parseJson(packageContent, SELENIUM_MANAGED_PATHS[0]);
  const packageLock = parseJson(lockContent, SELENIUM_MANAGED_PATHS[1]);
  const catalog = parseJson(catalogContent, "tests/e2e/capabilities.json");
  const capabilities = selectCapabilities(catalog, selectedCapabilityIds);
  const affectedCapabilities = capabilities.map(
    (capability) => capability.id,
  );
  const { current, rootNodeRange } = readCurrentPackages(
    packageJson,
    packageLock,
  );

  let candidates = null;
  let npmReason = null;
  try {
    const values = await Promise.all(
      PACKAGE_NAMES.map(async (packageName) => [
        packageName,
        normalizeNpmMetadata(packageName, await npm(packageName)),
      ]),
    );
    candidates = Object.fromEntries(values);
    if (
      PACKAGE_NAMES.some(
        (packageName) =>
          compareVersions(
            candidates[packageName].version,
            current[packageName].version,
          ) < 0,
      )
    ) {
      candidates = null;
      npmReason = "NPM_METADATA_REGRESSION";
    }
  } catch (error) {
    candidates = null;
    npmReason =
      error?.code !== undefined
        ? "NPM_METADATA_UNAVAILABLE"
        : "NPM_METADATA_INVALID";
  }

  let runner = null;
  let runnerReason = null;
  if (runnerEvidence === undefined || runnerEvidence === null) {
    runnerReason = "RUNNER_BROWSER_DRIVER_EVIDENCE_MISSING";
  } else {
    try {
      runner = normalizeRunnerEvidence(runnerEvidence, capabilities);
      if (
        runner.browser.compatibilityKey !==
        runner.driver.compatibilityKey
      ) {
        runnerReason = "RUNNER_BROWSER_DRIVER_MISMATCH";
      }
    } catch {
      runner = null;
      runnerReason = "RUNNER_BROWSER_DRIVER_EVIDENCE_INVALID";
    }
  }

  const updateAvailable =
    candidates !== null &&
    PACKAGE_NAMES.some(
      (packageName) =>
        candidates[packageName].version !== current[packageName].version,
    );
  const candidateCohort = updateAvailable ? candidates : null;
  const packageEvidence = [
    repositoryEvidence(
      SELENIUM_MANAGED_PATHS[0],
      repository.revision,
      packageContent,
      generatedAt,
    ),
    repositoryEvidence(
      SELENIUM_MANAGED_PATHS[1],
      repository.revision,
      lockContent,
      generatedAt,
    ),
  ];
  const runnerEvidenceItems =
    runner === null
      ? []
      : [
          runnerContractEvidence("browser", runner.browser, generatedAt),
          runnerContractEvidence("driver", runner.driver, generatedAt),
        ];

  let disposition;
  const failureReasons = [npmReason, runnerReason]
    .filter((reason) => reason !== null)
    .sort(compareText);
  if (failureReasons.length > 0) {
    const sourceUnavailable =
      npmReason !== null ||
      runnerReason === "RUNNER_BROWSER_DRIVER_EVIDENCE_INVALID";
    disposition = {
      state: sourceUnavailable ? "unavailable" : "unknown",
      reason_codes: failureReasons,
    };
  } else if (updateAvailable) {
    disposition = {
      state: "candidate",
      reason_codes: ["CANDIDATE_AVAILABLE"],
    };
  } else {
    disposition = { state: "current", reason_codes: [] };
  }

  const document = {
    schema_version: 1,
    kind: "observation",
    generated_at: generatedAt,
    repository,
    capability_catalog: {
      schema_version: catalog.schema_version,
      digest: catalogDigest(catalog),
    },
    provider_id: SELENIUM_PROVIDER_ID,
    disposition,
    components: [
      packageComponent({
        id: "selenium-axe-webdriverjs",
        current: current[AXE_PACKAGE],
        candidate: candidateCohort?.[AXE_PACKAGE] ?? null,
        currentEvidence: packageEvidence,
        candidateEvidence:
          candidateCohort === null
            ? null
            : [
                npmEvidence(candidateCohort[AXE_PACKAGE], generatedAt),
                ...runnerEvidenceItems,
              ],
        managedPath: SELENIUM_MANAGED_PATHS[1],
        affectedCapabilities,
      }),
      packageComponent({
        id: "selenium-webdriver",
        current: current[SELENIUM_PACKAGE],
        candidate: candidateCohort?.[SELENIUM_PACKAGE] ?? null,
        currentEvidence: packageEvidence,
        candidateEvidence:
          candidateCohort === null
            ? null
            : [
                npmEvidence(candidateCohort[SELENIUM_PACKAGE], generatedAt),
                ...runnerEvidenceItems,
              ],
        managedPath: SELENIUM_MANAGED_PATHS[0],
        affectedCapabilities,
      }),
    ],
    relations: [
      {
        id: "selenium-axe-node",
        type: "requires",
        from: "selenium-axe-webdriverjs",
        to: "node-runtime",
        hard: true,
        constraint: nodeConstraint(
          rootNodeRange,
          current[AXE_PACKAGE].nodeRange,
          candidateCohort?.[AXE_PACKAGE].engines.node ?? null,
        ),
      },
      {
        id: "selenium-axe-policy-alignment",
        type: "policy-align",
        from: "selenium-axe-webdriverjs",
        to: "selenium-webdriver",
        hard: false,
        constraint: axeConstraint(
          current[AXE_PACKAGE],
          candidateCohort?.[AXE_PACKAGE] ?? null,
        ),
      },
      {
        id: "selenium-runner-browser-driver",
        type: "must-match",
        from: "selenium-webdriver",
        to: "selenium-axe-webdriverjs",
        hard: true,
        constraint: runnerConstraint(runner),
      },
      {
        id: "selenium-webdriver-node",
        type: "requires",
        from: "selenium-webdriver",
        to: "node-runtime",
        hard: true,
        constraint: nodeConstraint(
          rootNodeRange,
          current[SELENIUM_PACKAGE].nodeRange,
          candidateCohort?.[SELENIUM_PACKAGE].engines.node ?? null,
        ),
      },
    ],
  };
  validateDocument(document, {
    capabilityIds: new Set(catalog.capabilities.map(({ id }) => id)),
    capabilityCatalogDigest: catalogDigest(catalog),
  });
  return document;
}

function sameStrings(left, right) {
  return (
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

function commandStep({
  command,
  environment = {},
  id,
  phase,
  writes = [],
}) {
  return {
    id,
    phase,
    working_directory: ".",
    command,
    environment: Object.fromEntries(
      Object.entries(environment).sort(([left], [right]) =>
        compareText(left, right),
      ),
    ),
    writes,
  };
}

export function createSeleniumQualificationPlan({
  observation,
  catalog,
  runnerEvidence,
  selectedCapabilityIds,
} = {}) {
  const capabilities = selectCapabilities(catalog, selectedCapabilityIds);
  const digest = catalogDigest(catalog);
  if (observation.capability_catalog?.digest !== digest) {
    throw new Error(
      "Qualification catalog must match the observed capability catalog",
    );
  }
  validateDocument(observation, {
    capabilityIds: new Set(catalog.capabilities.map(({ id }) => id)),
    capabilityCatalogDigest: digest,
  });
  const selectedIds = capabilities.map(({ id }) => id);
  const affectedIds = new Set(
    observation.components
      .filter((component) => component.candidate !== null)
      .flatMap((component) => component.affected_capabilities),
  );
  if (
    observation.provider_id !== SELENIUM_PROVIDER_ID ||
    observation.disposition.state !== "candidate"
  ) {
    throw new Error("Selenium qualification requires a candidate observation");
  }
  if (!sameStrings(selectedIds, affectedIds)) {
    throw new Error(
      "Qualification must admit the complete selected Selenium capability set",
    );
  }
  const runner = normalizeRunnerEvidence(runnerEvidence, capabilities);
  if (runner.browser.compatibilityKey !== runner.driver.compatibilityKey) {
    throw new Error("Runner browser and driver evidence must match");
  }
  const runnerRelation = observation.relations.find(
    (relation) => relation.id === "selenium-runner-browser-driver",
  );
  if (runnerRelation?.constraint !== runnerConstraint(runner)) {
    throw new Error(
      "Qualification runner evidence must match the candidate observation",
    );
  }
  const components = new Map(
    observation.components.map((component) => [component.id, component]),
  );
  const observedRunnerEvidence =
    components.get("selenium-webdriver")?.candidate?.evidence ?? [];
  for (const [kind, item] of [
    ["browser", runner.browser],
    ["driver", runner.driver],
  ]) {
    if (
      !observedRunnerEvidence.some(
        (evidence) =>
          evidence.type === `runner-${kind}` &&
          evidence.locator === item.locator &&
          evidence.revision === item.version &&
          evidence.digest === item.digest,
      )
    ) {
      throw new Error(
        "Qualification runner evidence must match the candidate observation",
      );
    }
  }
  const axeVersion = components.get("selenium-axe-webdriverjs")?.candidate
    ?.version;
  const seleniumVersion = components.get("selenium-webdriver")?.candidate
    ?.version;
  requireVersion(axeVersion, "candidate @axe-core/webdriverjs version");
  requireVersion(seleniumVersion, "candidate selenium-webdriver version");

  const steps = [
    commandStep({
      id: "apply-selenium-candidate",
      phase: "prepare",
      command: [
        "npm",
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--save-exact",
        "--prefix",
        SELENIUM_PACKAGE_DIRECTORY,
        `${AXE_PACKAGE}@${axeVersion}`,
        `${SELENIUM_PACKAGE}@${seleniumVersion}`,
      ],
      writes: SELENIUM_MANAGED_PATHS,
    }),
    commandStep({
      id: "install-selenium-candidate",
      phase: "prepare",
      command: [
        "npm",
        "ci",
        "--prefix",
        SELENIUM_PACKAGE_DIRECTORY,
      ],
      writes: [`${SELENIUM_PACKAGE_DIRECTORY}/node_modules`],
    }),
    commandStep({
      id: "test-selenium-package",
      phase: "test",
      command: [
        "npm",
        "--prefix",
        SELENIUM_PACKAGE_DIRECTORY,
        "test",
      ],
    }),
  ];

  for (const capability of capabilities) {
    const commonEnvironment = {
      E2E_BROWSER: capability.browser,
      E2E_BROWSER_BINARY: runner.browser.path,
      E2E_DRIVER_BINARY: runner.driver.path,
      E2E_OS: capability.os,
      MISE_ENV: capability.environment,
      MISE_LOCKED: "1",
    };
    steps.push(
      commandStep({
        id: `run-${capability.id}`,
        phase: "capability",
        command: ["mise", "run", capability.task],
        environment: commonEnvironment,
        writes: [
          capability.diagnostics.replace(/\/$/u, ""),
          `${SELENIUM_PACKAGE_DIRECTORY}/.runtime`,
        ],
      }),
      commandStep({
        id: `validate-${capability.id}`,
        phase: "evidence",
        command: ["node", ".github/scripts/validate-e2e-reports.mjs"],
        environment: {
          ...commonEnvironment,
          E2E_CAPABILITY_ID: capability.id,
          E2E_REQUIRED_FILES: JSON.stringify(capability.required_files),
          E2E_REQUIRE_ACCESSIBILITY: String(
            capability.require_accessibility,
          ),
          E2E_RESULT_REPORTS: JSON.stringify(capability.result_reports),
        },
      }),
    );
  }

  return {
    schema_version: 1,
    kind: "selenium-qualification-plan",
    provider_id: SELENIUM_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    repository: observation.repository,
    workspace: {
      kind: "ephemeral-copy",
      source_revision: observation.repository.revision,
      cleanup_required: true,
      repository_checkout_writable: false,
    },
    managed_paths: [...SELENIUM_MANAGED_PATHS],
    selected_capabilities: selectedIds,
    runner_evidence: {
      runner: runner.runner,
      browser: {
        name: runner.browser.name,
        version: runner.browser.version,
        compatibility_key: runner.browser.compatibilityKey,
        digest: runner.browser.digest,
        path: runner.browser.path,
      },
      driver: {
        name: runner.driver.name,
        version: runner.driver.version,
        compatibility_key: runner.driver.compatibilityKey,
        digest: runner.driver.digest,
        path: runner.driver.path,
      },
    },
    steps,
  };
}

export function createSeleniumValidation({
  observation,
  generatedAt = new Date().toISOString(),
  results,
} = {}) {
  if (
    observation.provider_id !== SELENIUM_PROVIDER_ID ||
    observation.disposition.state !== "candidate"
  ) {
    throw new Error("Selenium validation requires a candidate observation");
  }
  if (!Array.isArray(results)) {
    throw new Error("results must be an array");
  }
  const expected = new Set(
    observation.components
      .filter((component) => component.candidate !== null)
      .flatMap((component) => component.affected_capabilities),
  );
  const actual = results.map((result) => result.capability_id);
  if (
    actual.some((id) => typeof id !== "string") ||
    new Set(actual).size !== actual.length ||
    !sameStrings(actual, expected)
  ) {
    throw new Error(
      "Validation results must cover every selected Selenium capability",
    );
  }
  const normalizedResults = results
    .map((result) => ({
      capability_id: result.capability_id,
      status: result.status,
      warnings: [...result.warnings],
      evidence: structuredClone(result.evidence),
    }))
    .sort((left, right) =>
      compareText(left.capability_id, right.capability_id),
    );
  const qualified = normalizedResults.every(
    (result) => result.status === "pass" && result.warnings.length === 0,
  );
  const validation = {
    schema_version: 1,
    kind: "validation",
    generated_at: generatedAt,
    repository: observation.repository,
    capability_catalog: observation.capability_catalog,
    provider_id: SELENIUM_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    disposition: qualified
      ? {
          state: "independently-qualified",
          reason_codes: [],
        }
      : {
          state: "blocked",
          reason_codes: ["SELENIUM_QUALIFICATION_FAILED"],
        },
    results: normalizedResults,
  };
  const options = {
    capabilityIds: expected,
    capabilityCatalogDigest: observation.capability_catalog.digest,
  };
  validateDocument(validation, options);
  if (qualified) {
    validateIndependentQualification(observation, validation, options);
  }
  return validation;
}
