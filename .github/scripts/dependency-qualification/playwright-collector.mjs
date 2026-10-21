import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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
const RUNTIME_METADATA_PREFIX = "OCULIX_PLAYWRIGHT_RUNTIME=";
const RUNTIME_METADATA_SCRIPT = [
  'import { chromium } from "playwright-core";',
  "const executablePath = chromium.executablePath();",
  "const match = /(?:^|[\\\\/])(?:chromium|chromium_headless_shell)-(\\d+)(?:[\\\\/]|$)/u.exec(executablePath);",
  "process.stdout.write(",
  `  ${JSON.stringify(RUNTIME_METADATA_PREFIX)} +`,
  '    JSON.stringify({ browser: "chromium", executablePath, revision: match?.[1] ?? null }) +',
  '    "\\n",',
  ");",
].join("\n");

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

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const PARTIAL_VERSION_PATTERN =
  /^(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}$/u;
const INTEGRITY_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;

function assertSemver(value, label) {
  exactString(value, label);
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new MetadataError(
      "SEMVER_METADATA_INVALID",
      `${label} must be a strict semantic version`,
    );
  }
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some((identifier) =>
      /^\d+$/u.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0"))
  ) {
    throw new MetadataError(
      "SEMVER_METADATA_INVALID",
      `${label} has a numeric prerelease identifier with a leading zero`,
    );
  }
  return value;
}

function validComparator(token) {
  const match = /^(?:[<>]=?|[=~^])?(.*)$/u.exec(token);
  if (match === null) {
    return false;
  }
  const version = match[1];
  if (SEMVER_PATTERN.test(version)) {
    return true;
  }
  if (!PARTIAL_VERSION_PATTERN.test(version)) {
    return false;
  }
  const segments = version.split(".");
  const wildcard = segments.findIndex((segment) => /^[xX*]$/u.test(segment));
  return wildcard === -1 ||
    segments.slice(wildcard).every((segment) => /^[xX*]$/u.test(segment));
}

function assertSemverRange(value, label) {
  exactString(value, label);
  const normalized = value.trim().replace(
    /([<>]=?|[=~^])\s+(?=[0-9xX*])/gu,
    "$1",
  );
  if (normalized.length === 0 || /[,;]/u.test(normalized)) {
    throw new MetadataError(
      "SEMVER_RANGE_INVALID",
      `${label} must be a valid semantic-version range`,
    );
  }
  for (const alternative of normalized.split(/\s*\|\|\s*/u)) {
    if (alternative.length === 0) {
      throw new MetadataError(
        "SEMVER_RANGE_INVALID",
        `${label} contains an empty range alternative`,
      );
    }
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(alternative);
    const valid = hyphen === null
      ? alternative.split(/\s+/u).every(validComparator)
      : validComparator(hyphen[1]) && validComparator(hyphen[2]);
    if (!valid) {
      throw new MetadataError(
        "SEMVER_RANGE_INVALID",
        `${label} must be a valid semantic-version range`,
      );
    }
  }
  return value.trim();
}

function assertIntegrity(value, label) {
  if (typeof value !== "string" || !INTEGRITY_PATTERN.test(value)) {
    throw new MetadataError(
      "PACKAGE_INTEGRITY_INVALID",
      `${label} must be a valid SRI digest`,
    );
  }
  const encoded = value.slice(value.indexOf("-") + 1);
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    throw new MetadataError(
      "PACKAGE_INTEGRITY_INVALID",
      `${label} must contain canonical base64 digest bytes`,
    );
  }
  return value;
}

function assertTarball(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("not HTTPS");
    }
  } catch {
    throw new MetadataError(
      "PACKAGE_TARBALL_INVALID",
      `${label} must be an absolute HTTPS URL`,
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
  const axe = assertSemver(
    packageJson.devDependencies?.["@axe-core/playwright"],
    "package.json @axe-core/playwright",
  );
  const test = assertSemver(
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
  const playwright = assertSemver(
    testEntry.dependencies?.playwright,
    "@playwright/test dependency on playwright",
  );
  const core = assertSemver(
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
  const packages = {
    "@axe-core/playwright": axe,
    "@playwright/test": test,
    playwright,
    "playwright-core": core,
  };
  const integrities = Object.fromEntries(
    PACKAGE_NAMES.map((name) => [
      name,
      assertIntegrity(
        packageEntry(lockfile, name).integrity,
        `${name} lock integrity`,
      ),
    ]),
  );
  const tarballs = Object.fromEntries(
    PACKAGE_NAMES.map((name) => [
      name,
      assertTarball(
        packageEntry(lockfile, name).resolved,
        `${name} lock tarball`,
      ),
    ]),
  );
  const nodeRanges = Object.fromEntries(
    PACKAGE_NAMES.map((name) => [
      name,
      assertSemverRange(
        packageEntry(lockfile, name).engines?.node,
        `${name} Node range`,
      ),
    ]),
  );
  return {
    packages,
    integrities,
    tarballs,
    nodeRanges,
    axePeerRange: assertSemverRange(
      axeEntry.peerDependencies?.["playwright-core"],
      "@axe-core/playwright playwright-core peer range",
    ),
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
  assertSemver(selected, `${name} version`);
  assertIntegrity(record.dist.integrity, `${name} npm integrity`);
  assertTarball(record.dist.tarball, `${name} npm tarball`);
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
  const playwrightVersion = assertSemver(
    test.dependencies?.playwright,
    "@playwright/test candidate dependency on playwright",
  );
  const playwright = registryVersion(
    packuments.playwright,
    "playwright",
    playwrightVersion,
  );
  const coreVersion = assertSemver(
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
  const records = {
    "@axe-core/playwright": axe,
    "@playwright/test": test,
    playwright,
    "playwright-core": core,
  };
  return {
    records,
    packages: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [name, record.version]),
    ),
    integrities: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [
        name,
        record.dist.integrity,
      ]),
    ),
    tarballs: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [
        name,
        record.dist.tarball,
      ]),
    ),
    nodeRanges: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [
        name,
        assertSemverRange(record.engines?.node, `${name} Node range`),
      ]),
    ),
    axePeerRange: assertSemverRange(
      axe.peerDependencies?.["playwright-core"],
      "@axe-core/playwright playwright-core peer range",
    ),
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

function packageVersion(cohort) {
  return stableJson({
    axePeerRange: cohort.axePeerRange,
    integrities: cohort.integrities,
    nodeRanges: cohort.nodeRanges,
    packages: cohort.packages,
    tarballs: cohort.tarballs,
  });
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
        version: packageVersion(current),
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
    packageVersion(candidate) !== packageVersion(current);
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
      version: packageVersion(candidate),
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
    ...JSON.parse(packages.version),
    browser: JSON.parse(browser.version),
    browserEvidence: browser.evidence[0],
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
    PLAYWRIGHT_BROWSERS_PATH: join(packageRoot, ".playwright-browsers"),
    PLAYWRIGHT_PROJECT: capability.browser,
    npm_config_cache: join(packageRoot, ".npm-cache"),
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
      environment: {
        npm_config_cache: join(packageRoot, ".npm-cache"),
      },
    },
    preparation: capabilities.flatMap((capability) => [
      {
        id: `prepare-packages-${capability.id}`,
        phase: "prepare",
        command: "npm",
        arguments: [
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        cwd: packageRoot,
        capability_id: capability.id,
        environment: environmentFor(capability),
      },
      {
        id: `prepare-browser-${capability.id}`,
        phase: "prepare",
        command: "npm",
        arguments: [
          "exec",
          "--",
          "playwright",
          "install",
          capability.browser,
        ],
        cwd: packageRoot,
        capability_id: capability.id,
        environment: environmentFor(capability),
      },
    ]),
    runtime_metadata: capabilities.map((capability) => ({
      id: `runtime-${capability.id}`,
      phase: "runtime-metadata",
      command: process.execPath,
      arguments: [
        "--input-type=module",
        "--eval",
        RUNTIME_METADATA_SCRIPT,
      ],
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
  const trackedPaths = (await gitOutput(sourceRoot, ["ls-files", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  for (const path of trackedPaths) {
    const destination = join(workspaceRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, path), destination, {
      preserveTimestamps: true,
    });
  }
  return {
    root: workspaceRoot,
    async cleanup() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

function warningDescription(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value !== null && typeof value === "object") {
    if (typeof value.message === "string") {
      return value.message.trim();
    }
    if (typeof value.title === "string") {
      return value.title.trim();
    }
    return stableJson(value);
  }
  return String(value);
}

function structuredWarnings(value, { warningContext = false } = {}) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      structuredWarnings(entry, { warningContext }));
  }
  if (typeof value !== "object") {
    return warningContext ? [warningDescription(value)] : [];
  }

  const warnings = [];
  const level = value.level ?? value.severity ?? value.type;
  const isWarning =
    typeof level === "string" &&
    /^warnings?$/iu.test(level.trim());
  if (warningContext || isWarning) {
    warnings.push(warningDescription(value));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/^warnings?$/iu.test(key)) {
      warnings.push(
        ...structuredWarnings(entry, { warningContext: true }),
      );
    } else if (
      ["annotations", "diagnostics", "messages"].includes(key)
    ) {
      warnings.push(...structuredWarnings(entry));
    }
  }
  return warnings.filter((warning) => warning.length > 0);
}

function outputWarnings(output) {
  const warnings = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (
      /\bwarn(?:ing)?s?\b/iu.test(line) ||
      /^::warning(?:\s|::)/iu.test(line)
    ) {
      warnings.push(line);
    }
    try {
      warnings.push(...structuredWarnings(JSON.parse(line)));
    } catch {
      // Non-JSON process output is handled by the textual warning matcher.
    }
  }
  return warnings;
}

function runtimeMetadataFromOutput(output) {
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith(RUNTIME_METADATA_PREFIX)) {
      try {
        return JSON.parse(line.slice(RUNTIME_METADATA_PREFIX.length));
      } catch {
        return null;
      }
    }
  }
  return null;
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
          ...outputWarnings(stdout),
          ...outputWarnings(stderr),
        ]),
        runtimeMetadata: runtimeMetadataFromOutput(stdout),
      });
    });
  });
}

async function verifyAppliedCandidate(workspaceRoot, candidate) {
  const packageJson = await readJson(join(workspaceRoot, PACKAGE_PATH));
  const lockfile = await readJson(join(workspaceRoot, LOCK_PATH));
  const applied = currentPackageCohort(packageJson, lockfile);
  if (packageVersion(applied) !== packageVersion(candidate)) {
    throw new Error(
      "Ephemeral package versions, integrities, tarballs, or ranges " +
        "do not match the observed candidate cohort",
    );
  }
  return {
    integrities: applied.integrities,
    packages: applied.packages,
    tarballs: applied.tarballs,
  };
}

function pathInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !resolve(child).startsWith(`${resolve(parent)}${sep}..`);
}

async function verifyRuntimeBrowser({
  workspaceRoot,
  candidate,
  runtimeMetadata,
}) {
  const installedMetadataPath = join(
    workspaceRoot,
    PACKAGE_DIRECTORY,
    "node_modules/playwright-core/browsers.json",
  );
  const installedMetadata = await readJson(installedMetadataPath);
  const installedChromium = chromiumRecord(installedMetadata);
  if (
    digest(installedMetadata) !== candidate.browserEvidence.digest ||
    installedChromium.revision !== candidate.browser.revision
  ) {
    throw new Error(
      "Installed playwright-core browser metadata does not match " +
        "the observed candidate evidence",
    );
  }
  if (
    runtimeMetadata?.browser !== "chromium" ||
    runtimeMetadata.revision !== candidate.browser.revision ||
    typeof runtimeMetadata.executablePath !== "string"
  ) {
    throw new Error(
      "Runtime Chromium revision does not match the observed candidate",
    );
  }
  const browserRoot = join(
    workspaceRoot,
    PACKAGE_DIRECTORY,
    ".playwright-browsers",
  );
  if (!pathInside(browserRoot, runtimeMetadata.executablePath)) {
    throw new Error(
      "Runtime Chromium executable is outside the ephemeral package boundary",
    );
  }
  const executable = await stat(runtimeMetadata.executablePath);
  if (!executable.isFile() || executable.size === 0) {
    throw new Error("Runtime Chromium executable is missing or empty");
  }
}

async function filesBelow(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
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

function isObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    /Z$/u.test(value);
}

async function validateArtifactSemantics(workspaceRoot, path) {
  const contents = await readFile(join(workspaceRoot, path));
  if (path.endsWith(".png")) {
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (
      contents.length < 24 ||
      !contents.subarray(0, 8).equals(pngSignature) ||
      contents.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      return `${path} is not a structurally identifiable PNG`;
    }
  } else if (path.endsWith(".webm") && contents.length === 0) {
    return `${path} is an empty video artifact`;
  } else if (path.endsWith(".html")) {
    const html = contents.toString("utf8");
    if (!/<html(?:\s|>)/iu.test(html) || !/<\/html>/iu.test(html)) {
      return `${path} is not a complete HTML document`;
    }
  } else if (path.endsWith(".json")) {
    try {
      JSON.parse(contents.toString("utf8"));
    } catch {
      return `${path} is not valid JSON`;
    }
  } else if (path.endsWith(".md") && contents.toString("utf8").trim() === "") {
    return `${path} is empty Markdown`;
  }
  return null;
}

function validateResultReport(report, capability, candidate, reportPath) {
  const problems = [];
  const scenario = report?.scenario;
  if (
    !isObject(report) ||
    report.schemaVersion !== 1 ||
    report.tool !== "playwright" ||
    report.capabilityId !== capability.id ||
    !capability.scenarios.includes(scenario) ||
    report.status !== "passed"
  ) {
    problems.push(
      `result report ${reportPath} has an invalid identity or status`,
    );
    return problems;
  }
  if (
    !isObject(report.assertion) ||
    report.assertion.status !== "passed" ||
    report.assertion.expectedStatus !== "passed" ||
    !Array.isArray(report.assertion.errors) ||
    report.assertion.errors.length !== 0
  ) {
    problems.push(`result report ${reportPath} has invalid assertions`);
  }
  if (
    !isObject(report.timestamps) ||
    !validTimestamp(report.timestamps.startedAt) ||
    !validTimestamp(report.timestamps.completedAt) ||
    !Number.isFinite(report.timestamps.durationMs) ||
    report.timestamps.durationMs < 0
  ) {
    problems.push(`result report ${reportPath} has invalid timestamps`);
  }
  if (
    !isObject(report.environment) ||
    report.environment.browser?.project !== capability.browser ||
    typeof report.environment.browser?.version !== "string" ||
    report.environment.browser.version.length === 0 ||
    !isObject(report.environment.versions) ||
    report.environment.versions.playwright !==
      candidate.packages["@playwright/test"] ||
    report.environment.versions.axe !==
      candidate.packages["@axe-core/playwright"] ||
    typeof report.environment.versions.node !== "string"
  ) {
    problems.push(`result report ${reportPath} has invalid runtime metadata`);
  }
  const scenarioRoot =
    `${PACKAGE_DIRECTORY}/test-results/${scenario}`;
  const expectedArtifacts = {
    htmlReport: `${scenarioRoot}/html-report/index.html`,
    nativeJsonReport: `${scenarioRoot}/playwright-report.json`,
    result: `${scenarioRoot}/result.json`,
  };
  if (
    !isObject(report.artifacts) ||
    !Object.entries(expectedArtifacts).every(
      ([key, value]) => report.artifacts[key] === value,
    ) ||
    !Array.isArray(report.artifacts.attachments)
  ) {
    problems.push(`result report ${reportPath} has invalid artifact paths`);
  }
  if (
    scenario === "web-calculator" &&
    (
      report.artifacts?.accessibility !==
        `${scenarioRoot}/accessibility.json` ||
      report.artifacts?.accessibilitySummary !==
        `${scenarioRoot}/accessibility-summary.json` ||
      report.artifacts?.accessibilitySummaryMarkdown !==
        `${scenarioRoot}/accessibility-summary.md` ||
      report.artifacts?.finalScreenshot !== `${scenarioRoot}/final.png`
    )
  ) {
    problems.push(
      `result report ${reportPath} does not bind accessibility evidence`,
    );
  }
  return problems;
}

function validateNativeReport(report, path) {
  if (
    !isObject(report) ||
    !isObject(report.config) ||
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    !isObject(report.stats) ||
    report.stats.unexpected !== 0
  ) {
    return [`native Playwright report ${path} is invalid or unsuccessful`];
  }
  return [];
}

function validFindingCounts(value) {
  return isObject(value) &&
    Number.isInteger(value.rules) &&
    value.rules >= 0 &&
    Number.isInteger(value.nodes) &&
    value.nodes >= 0;
}

function validateAccessibility(raw, summary, markdown) {
  const problems = [];
  if (
    !isObject(raw) ||
    !isObject(raw.testEngine) ||
    !isObject(raw.testEnvironment) ||
    !isObject(raw.testRunner) ||
    !validTimestamp(raw.timestamp) ||
    typeof raw.url !== "string" ||
    !["violations", "incomplete", "passes", "inapplicable"].every(
      (key) => Array.isArray(raw[key]),
    ) ||
    raw.violations.length !== 0
  ) {
    problems.push("raw accessibility report is invalid or has violations");
  }
  if (
    !isObject(summary) ||
    summary.status !== "passed" ||
    !isObject(summary.policy) ||
    !isObject(summary.counts) ||
    !["violations", "incomplete", "passes", "inapplicable"].every(
      (key) => validFindingCounts(summary.counts[key]),
    ) ||
    summary.counts.violations.rules !== 0 ||
    summary.counts.violations.nodes !== 0 ||
    !Array.isArray(summary.violations) ||
    summary.violations.length !== 0 ||
    !Array.isArray(summary.incomplete)
  ) {
    problems.push(
      "accessibility summary is invalid or reports blocking violations",
    );
  }
  if (
    typeof markdown !== "string" ||
    !/Status:\s+\*\*passed\*\*/iu.test(markdown) ||
    !/Violations:\s+0 rule\(s\)\s+\/\s+0 affected node\(s\)/iu.test(markdown)
  ) {
    problems.push("accessibility Markdown summary does not report zero violations");
  }
  return problems;
}

async function defaultInspectCapability({
  workspaceRoot,
  capability,
  candidate,
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
    for (const path of matches) {
      matchedFiles.add(path);
      const semanticProblem = await validateArtifactSemantics(
        workspaceRoot,
        path,
      );
      if (semanticProblem !== null) {
        problems.push(semanticProblem);
      }
    }
  }
  if (!allFiles.includes(capability.evidence)) {
    problems.push(`missing primary evidence ${capability.evidence}`);
  } else {
    matchedFiles.add(capability.evidence);
    const semanticProblem = await validateArtifactSemantics(
      workspaceRoot,
      capability.evidence,
    );
    if (semanticProblem !== null) {
      problems.push(semanticProblem);
    }
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
    problems.push(
      ...validateResultReport(report, capability, candidate, reportPath),
    );
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
    const scenarioRoot =
      `${PACKAGE_DIRECTORY}/test-results/${scenario}`;
    const nativePath = `${scenarioRoot}/playwright-report.json`;
    if (allFiles.includes(nativePath)) {
      try {
        problems.push(
          ...validateNativeReport(
            await readJson(join(workspaceRoot, nativePath)),
            nativePath,
          ),
        );
      } catch (error) {
        problems.push(`invalid native report ${nativePath}: ${error.message}`);
      }
    }
  }
  for (const scenario of capability.scenarios) {
    if (!observedScenarios.has(scenario)) {
      problems.push(`missing passing result for scenario ${scenario}`);
    }
  }
  if (capability.require_accessibility) {
    const root = `${PACKAGE_DIRECTORY}/test-results/web-calculator`;
    try {
      problems.push(
        ...validateAccessibility(
          await readJson(join(workspaceRoot, `${root}/accessibility.json`)),
          await readJson(
            join(workspaceRoot, `${root}/accessibility-summary.json`),
          ),
          await readFile(
            join(workspaceRoot, `${root}/accessibility-summary.md`),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      problems.push(`invalid accessibility artifacts: ${error.message}`);
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
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
    signal: result?.signal ?? null,
    warnings: uniqueSorted([
      ...structuredWarnings(result?.warnings, { warningContext: true }),
      ...structuredWarnings(result?.structuredWarnings, {
        warningContext: true,
      }),
      ...structuredWarnings(result?.annotations),
      ...outputWarnings(stdout),
      ...outputWarnings(stderr),
    ]),
    runtimeMetadata:
      result?.runtimeMetadata ?? runtimeMetadataFromOutput(stdout),
  };
}

async function gitOutput(repositoryRoot, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", arguments_, {
      cwd: repositoryRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        rejectPromise(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `git ${arguments_.join(" ")} exited ${exitCode}`,
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

function repositoryNameFromRemote(remote) {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/u
      .exec(remote.trim());
  return match?.[1] ?? null;
}

export async function inspectRepositoryState(repositoryRoot) {
  const [topLevel, revision, status, remote, tracked] = await Promise.all([
    gitOutput(repositoryRoot, ["rev-parse", "--show-toplevel"]),
    gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
    gitOutput(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    gitOutput(repositoryRoot, ["remote", "get-url", "origin"]),
    gitOutput(repositoryRoot, ["ls-files", "-z"]),
  ]);
  const trackedPaths = tracked
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const trackedFiles = new Map(
    await Promise.all(
      trackedPaths.map(async (path) => [
        path,
        digest(await readFile(join(repositoryRoot, path))),
      ]),
    ),
  );
  return {
    root: resolve(topLevel.toString("utf8").trim()),
    revision: revision.toString("utf8").trim(),
    repositoryName: repositoryNameFromRemote(
      remote.toString("utf8").trim(),
    ),
    clean: status.length === 0,
    trackedFiles,
  };
}

function sourceInspectionFailures(inspection, observation, repositoryRoot) {
  const failures = [];
  if (inspection.root !== resolve(repositoryRoot)) {
    failures.push("SOURCE_ROOT_MISMATCH");
  }
  if (inspection.revision !== observation.repository.revision) {
    failures.push("SOURCE_REVISION_MISMATCH");
  }
  if (inspection.repositoryName !== observation.repository.name) {
    failures.push("SOURCE_REPOSITORY_MISMATCH");
  }
  if (!inspection.clean) {
    failures.push("SOURCE_DIRTY");
  }
  if (!(inspection.trackedFiles instanceof Map)) {
    failures.push("SOURCE_MANIFEST_INVALID");
  }
  return failures;
}

async function verifyWorkspaceRevision(workspaceRoot, trackedFiles) {
  const actualPaths = await filesBelow(workspaceRoot);
  const expectedPaths = [...trackedFiles.keys()].sort();
  if (stableJson(actualPaths) !== stableJson(expectedPaths)) {
    throw new Error(
      "Ephemeral workspace contains files outside the repository revision",
    );
  }
  for (const [path, expectedDigest] of trackedFiles) {
    let contents;
    try {
      contents = await readFile(join(workspaceRoot, path));
    } catch {
      throw new Error(`Ephemeral workspace is missing tracked file ${path}`);
    }
    if (digest(contents) !== expectedDigest) {
      throw new Error(
        `Ephemeral workspace does not match the repository revision at ${path}`,
      );
    }
  }
}

async function snapshotTree(root) {
  return new Map(
    await Promise.all(
      (await filesBelow(root)).map(async (path) => [
        path,
        digest(await readFile(join(root, path))),
      ]),
    ),
  );
}

async function workspaceBoundaryViolations(workspaceRoot, baseline) {
  const current = await snapshotTree(workspaceRoot);
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  return [...paths]
    .filter((path) => {
      if (
        path === PACKAGE_DIRECTORY ||
        path.startsWith(`${PACKAGE_DIRECTORY}/`)
      ) {
        return false;
      }
      return baseline.get(path) !== current.get(path);
    })
    .sort();
}

async function sourceManifestChanges(repositoryRoot, trackedFiles) {
  const changed = [];
  for (const [path, expectedDigest] of trackedFiles) {
    try {
      if (
        digest(await readFile(join(repositoryRoot, path))) !== expectedDigest
      ) {
        changed.push(path);
      }
    } catch {
      changed.push(path);
    }
  }
  return changed.sort();
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
      steps: transcript.map((step) => ({
        id: step.id,
        exitCode: step.exitCode,
        signal: step.signal,
        warnings: step.warnings,
        installMetadata: step.installMetadata ?? null,
        runtimeMetadata: step.runtimeMetadata == null
          ? null
          : {
              browser: step.runtimeMetadata.browser,
              revision: step.runtimeMetadata.revision,
            },
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
  inspectRepository = inspectRepositoryState,
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
  let sourceInspection = null;
  let sourceSnapshot = null;
  let sourceAccepted = false;
  let workspaceBaseline = null;

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
    if (workspace !== null && workspaceBaseline !== null) {
      const boundaryChanges = await workspaceBoundaryViolations(
        workspace.root,
        workspaceBaseline,
      );
      if (boundaryChanges.length > 0) {
        globalFailures.push("WORKSPACE_BOUNDARY_VIOLATION");
      }
    }
    return result;
  }

  try {
    try {
      sourceInspection = await inspectRepository(repositoryRoot);
      globalFailures.push(
        ...sourceInspectionFailures(
          sourceInspection,
          observation,
          repositoryRoot,
        ),
      );
      sourceAccepted = globalFailures.length === 0;
      if (sourceAccepted) {
        sourceSnapshot = await snapshotSource(repositoryRoot);
      }
    } catch {
      globalFailures.push("SOURCE_INSPECTION_FAILED");
    }

    if (globalFailures.length === 0) {
      workspace = await createWorkspace(repositoryRoot);
      if (
        resolve(workspace.root) === resolve(repositoryRoot) ||
        pathInside(repositoryRoot, workspace.root) ||
        pathInside(workspace.root, repositoryRoot)
      ) {
        globalFailures.push("WORKSPACE_NOT_EPHEMERAL");
      } else {
        try {
          await verifyWorkspaceRevision(
            workspace.root,
            sourceInspection.trackedFiles,
          );
          workspaceBaseline = await snapshotTree(workspace.root);
        } catch {
          globalFailures.push("WORKSPACE_REVISION_MISMATCH");
        }
      }
    }

    if (globalFailures.length === 0) {
      plan = createPlaywrightQualificationPlan({
        observation,
        workspaceRoot: workspace.root,
        capabilityCatalog: catalog,
      });

      const applyResult = await execute(plan.apply);
      if (applyResult.exitCode !== 0) {
        globalFailures.push("APPLICATION_FAILED");
      } else if (globalFailures.length === 0) {
        try {
          const installMetadata = await verifyAppliedCandidate(
            workspace.root,
            candidate,
          );
          transcript.find(
            (step) => step.id === plan.apply.id,
          ).installMetadata = installMetadata;
        } catch {
          globalFailures.push("APPLICATION_FAILED");
        }
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

      if (globalFailures.length === 0) {
        for (const step of plan.runtime_metadata) {
          if (capabilityFailures.get(step.capability_id).length > 0) {
            continue;
          }
          const result = await execute(step);
          if (result.exitCode !== 0) {
            capabilityFailures.get(step.capability_id).push(
              "RUNTIME_BROWSER_MISMATCH",
            );
            continue;
          }
          try {
            await verifyRuntimeBrowser({
              workspaceRoot: workspace.root,
              candidate,
              runtimeMetadata: result.runtimeMetadata,
            });
          } catch {
            capabilityFailures.get(step.capability_id).push(
              "RUNTIME_BROWSER_MISMATCH",
            );
          }
        }
      }

      if (globalFailures.length === 0) {
        const packageResult = await execute(plan.package_tests);
        if (packageResult.exitCode !== 0) {
          globalFailures.push("PACKAGE_TESTS_FAILED");
        }
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
            candidate,
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
    const changedSource = sourceSnapshot === null
      ? []
      : await restoreChangedSource(repositoryRoot, sourceSnapshot);
    if (changedSource.length > 0) {
      globalFailures.push("PACKAGE_STATE_MUTATED");
    }
    if (
      sourceAccepted &&
      sourceInspection?.trackedFiles instanceof Map
    ) {
      const sourceChanges = await sourceManifestChanges(
        repositoryRoot,
        sourceInspection.trackedFiles,
      );
      if (sourceChanges.length > 0) {
        globalFailures.push("SOURCE_STATE_MUTATED");
      }
      try {
        const finalInspection = await inspectRepository(repositoryRoot);
        if (
          sourceInspectionFailures(
            finalInspection,
            observation,
            repositoryRoot,
          ).length > 0
        ) {
          globalFailures.push("SOURCE_STATE_MUTATED");
        }
      } catch {
        globalFailures.push("SOURCE_STATE_MUTATED");
      }
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
            ...(plan?.runtime_metadata ?? []),
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
