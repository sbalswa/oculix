import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateCatalog } from "../plan-e2e.mjs";
import {
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

const execFileAsync = promisify(execFile);
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "../../..");
export const CYPRESS_PROVIDER_ID = "cypress";
export const CYPRESS_PACKAGE_DIRECTORY = "tests/e2e/cypress";
export const CYPRESS_MANAGED_PATHS = Object.freeze([
  `${CYPRESS_PACKAGE_DIRECTORY}/package.json`,
  `${CYPRESS_PACKAGE_DIRECTORY}/package-lock.json`,
]);
const PACKAGE_DIRECTORY = CYPRESS_PACKAGE_DIRECTORY;
const PACKAGE_PATH = `${PACKAGE_DIRECTORY}/package.json`;
const LOCK_PATH = `${PACKAGE_DIRECTORY}/package-lock.json`;
const BINARY_POLICY_PATH = `${PACKAGE_DIRECTORY}/cypress.config.mjs`;
const CATALOG_PATH = "tests/e2e/capabilities.json";
const NODE_CONFIG_PATH = "mise/config.web-e2e.toml";
const NODE_LOCK_PATH = "mise/mise.web-e2e.lock";
const PROVIDER_ID = CYPRESS_PROVIDER_ID;
const ELECTRON = "electron";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function hash(value) {
  const contents = ArrayBuffer.isView(value)
    ? value
    : typeof value === "string"
      ? value
      : JSON.stringify(stableValue(value));
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function metadataDigest(value) {
  return hash(JSON.stringify(stableValue(value)));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function assertNonemptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
}

function assertExactVersion(value, name) {
  assertNonemptyString(value, name);
  if (!EXACT_VERSION_PATTERN.test(value)) {
    throw new Error(`${name} must be an exact package version`);
  }
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase sha256 digest`);
  }
}

function normalizeWarnings(value, name) {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((warning) => typeof warning !== "string" || warning === "")
  ) {
    throw new Error(`${name}.warnings must be an array of nonempty strings`);
  }
  return sortedUnique(value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function repositoryPath(root, path) {
  return resolve(root, ...path.split("/"));
}

async function repositoryEvidence({
  generatedAt,
  path,
  repositoryRevision,
  repositoryRoot,
}) {
  return {
    type: "repository-file",
    locator: path,
    revision: repositoryRevision,
    digest: hash(await readFile(repositoryPath(repositoryRoot, path))),
    observed_at: generatedAt,
  };
}

function npmMetadata(name, raw, generatedAt) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (raw.name !== name) {
    throw new Error(
      `npm evidence for ${name} identifies ${raw.name ?? "(missing)"}`,
    );
  }
  assertExactVersion(raw.version, `${name}.version`);
  assertNonemptyString(raw.dist?.tarball, `${name}.dist.tarball`);
  assertNonemptyString(raw.dist?.integrity, `${name}.dist.integrity`);
  const engines =
    raw.engines === undefined ? {} : structuredClone(raw.engines);
  if (
    engines === null ||
    typeof engines !== "object" ||
    Array.isArray(engines)
  ) {
    throw new Error(`${name}.engines must be an object`);
  }
  const immutable = {
    name,
    version: raw.version,
    dist: {
      integrity: raw.dist.integrity,
      tarball: raw.dist.tarball,
    },
    engines: stableValue(engines),
  };
  return {
    ...immutable,
    warnings: normalizeWarnings(raw.warnings, name),
    evidence: {
      type: "npm-registry",
      locator: raw.dist.tarball,
      revision: `${name}@${raw.version}`,
      digest: metadataDigest(immutable),
      observed_at: generatedAt,
    },
  };
}

function binaryMetadata(raw, generatedAt, name) {
  if (raw === null || raw === undefined) {
    return null;
  }
  assertExactVersion(raw.version, `${name}.version`);
  assertNonemptyString(raw.locator, `${name}.locator`);
  assertDigest(raw.digest, `${name}.digest`);
  return {
    version: raw.version,
    warnings: normalizeWarnings(raw.warnings, name),
    evidence: {
      type: "cypress-binary",
      locator: raw.locator,
      revision: raw.version,
      digest: raw.digest,
      observed_at: generatedAt,
    },
  };
}

function browserMetadata(raw, capability, generatedAt) {
  if (raw === null || raw === undefined) {
    return null;
  }
  for (const key of ["browser", "runner", "os", "version", "locator"]) {
    assertNonemptyString(raw[key], `browser evidence ${key}`);
  }
  assertDigest(raw.digest, "browser evidence digest");
  return {
    browser: raw.browser.toLowerCase(),
    runner: raw.runner,
    os: raw.os,
    version: raw.version,
    warnings: normalizeWarnings(raw.warnings, "browser evidence"),
    evidence: {
      type: "external-browser",
      locator: raw.locator,
      revision: `${raw.browser.toLowerCase()}@${raw.version}`,
      digest: raw.digest,
      observed_at: generatedAt,
    },
    capabilityId: capability.id,
  };
}

async function captureEvidence(provider, argument, normalize, reasonCode) {
  if (typeof provider !== "function") {
    return {
      value: null,
      reasonCodes: [reasonCode],
      warnings: [],
    };
  }
  try {
    const value = normalize(await provider(argument));
    return {
      value,
      reasonCodes: value === null ? [reasonCode] : [],
      warnings: value?.warnings ?? [],
    };
  } catch {
    return {
      value: null,
      reasonCodes: [reasonCode],
      warnings: [],
    };
  }
}

function lockPackage(lock, name) {
  return lock.packages?.[`node_modules/${name}`];
}

function validatePackageFiles(packageJson, lock) {
  if (packageJson.name !== "oculix-cypress-e2e") {
    throw new Error("Cypress package has an unexpected name");
  }
  if (lock.lockfileVersion !== 3) {
    throw new Error("Cypress package-lock must use lockfileVersion 3");
  }
  const root = lock.packages?.[""];
  if (root === undefined) {
    throw new Error("Cypress package-lock is missing its root package");
  }
  for (const name of ["cypress", "axe-core"]) {
    const directVersion = packageJson.dependencies?.[name];
    assertExactVersion(directVersion, `package.json dependencies.${name}`);
    if (root.dependencies?.[name] !== directVersion) {
      throw new Error(
        `package-lock root ${name} must equal package.json ${directVersion}`,
      );
    }
    const installed = lockPackage(lock, name);
    if (installed?.version !== directVersion) {
      throw new Error(
        `package-lock ${name} must resolve direct version ${directVersion}`,
      );
    }
    assertNonemptyString(installed.resolved, `${name} lock resolved`);
    assertNonemptyString(installed.integrity, `${name} lock integrity`);
  }
  const cypress = lockPackage(lock, "cypress");
  assertNonemptyString(cypress.engines?.node, "Cypress lock Node range");
  if (cypress.bin?.cypress !== "bin/cypress") {
    throw new Error("Cypress lock must declare the package binary");
  }
  return {
    axeCore: packageJson.dependencies["axe-core"],
    cypress: packageJson.dependencies.cypress,
    cypressNodeRange: cypress.engines.node,
  };
}

function parseNodeFiles(config, lock) {
  const configured = /^\s*node\s*=\s*"([^"]+)"\s*$/mu.exec(config)?.[1];
  const locked =
    /^\s*\[\[tools\.node\]\][\s\S]*?^\s*version\s*=\s*"([^"]+)"\s*$/mu
      .exec(lock)?.[1];
  assertNonemptyString(configured, "configured Node range");
  assertExactVersion(locked, "locked Node version");
  return {
    configured,
    locked,
  };
}

function selectCapabilities(catalog) {
  validateCatalog(catalog);
  const capabilities = catalog.capabilities
    .filter(
      (capability) =>
        capability.tool === "cypress" &&
        capability.stability === "stable",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (capabilities.length === 0) {
    throw new Error("Capability catalog contains no stable Cypress cell");
  }
  return capabilities;
}

function packageLockEvidence(lock, name, generatedAt) {
  const entry = lockPackage(lock, name);
  const immutable = {
    integrity: entry.integrity,
    name,
    resolved: entry.resolved,
    version: entry.version,
  };
  return {
    type: "package-lock",
    locator: LOCK_PATH,
    revision: `${name}@${entry.version}`,
    digest: metadataDigest(immutable),
    observed_at: generatedAt,
  };
}

function component({
  affectedCapabilities,
  candidate,
  current,
  ecosystem,
  id,
  managedPath,
}) {
  return {
    id,
    lane: PROVIDER_ID,
    ecosystem,
    current,
    candidate,
    eventual_managed_paths: [managedPath],
    affected_capabilities: affectedCapabilities,
  };
}

function relation({ constraint, from, hard, id, to, type }) {
  return {
    id,
    type,
    from,
    to,
    hard,
    constraint,
  };
}

function candidateVersion(currentVersion, upstream) {
  if (
    upstream?.version === undefined ||
    compareVersions(upstream.version, currentVersion) <= 0
  ) {
    return null;
  }
  return upstream.version;
}

function compareVersions(left, right) {
  const parse = (version) => {
    const withoutBuild = version.split("+", 1)[0];
    const separator = withoutBuild.indexOf("-");
    const core =
      separator === -1
        ? withoutBuild
        : withoutBuild.slice(0, separator);
    const prerelease =
      separator === -1 ? null : withoutBuild.slice(separator + 1);
    return {
      core: core.split(".").map(Number),
      prerelease,
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] - rightVersion.core[index];
    }
  }
  if (leftVersion.prerelease === rightVersion.prerelease) {
    return 0;
  }
  if (leftVersion.prerelease === null) {
    return 1;
  }
  if (rightVersion.prerelease === null) {
    return -1;
  }
  return leftVersion.prerelease < rightVersion.prerelease ? -1 : 1;
}

function evidenceWarnings(evidenceResults) {
  return sortedUnique(
    evidenceResults.flatMap((result) => result.warnings),
  );
}

function dispositionFor({ candidateCount, incompatible, reasonCodes, warnings }) {
  if (incompatible) {
    return {
      state: "unavailable",
      reason_codes: sortedUnique(reasonCodes),
    };
  }
  if (reasonCodes.length > 0) {
    return {
      state: "unavailable",
      reason_codes: sortedUnique(reasonCodes),
    };
  }
  if (warnings.length > 0) {
    return {
      state: "unknown",
      reason_codes: ["EVIDENCE_WARNINGS"],
    };
  }
  return {
    state: candidateCount > 0 ? "candidate" : "current",
    reason_codes: candidateCount > 0 ? ["CANDIDATE_AVAILABLE"] : [],
  };
}

async function repositoryIdentity(repositoryRoot) {
  const [{ stdout: revisionOutput }, { stdout: remoteOutput }] =
    await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
      execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    ]);
  const revision = revisionOutput.trim();
  const remote = remoteOutput.trim();
  const match =
    /github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote);
  if (match === null) {
    throw new Error(`Could not derive GitHub repository from ${remote}`);
  }
  return {
    name: match[1],
    revision,
  };
}

function browserVersion(browserEvidence) {
  return browserEvidence
    .map(
      (entry) =>
        `${entry.browser}@${entry.version} on ${entry.os}/${entry.runner}`,
    )
    .sort()
    .join(", ");
}

function browserConstraint(capabilities, browserEvidence) {
  return capabilities
    .map((capability) => {
      const evidence = browserEvidence.find(
        (entry) => entry.capabilityId === capability.id,
      );
      return (
        `${capability.id} requires ${capability.browser} on ` +
        `${capability.runner}` +
        (evidence === undefined ? "" : ` (${evidence.version})`)
      );
    })
    .sort()
    .join("; ");
}

function expectedPackage(name, currentVersion, currentLock, upstream) {
  if (upstream?.version !== undefined && upstream.version !== currentVersion) {
    return {
      name,
      version: upstream.version,
      resolved: upstream.dist.tarball,
      integrity: upstream.dist.integrity,
    };
  }
  const current = lockPackage(currentLock, name);
  return {
    name,
    version: current.version,
    resolved: current.resolved,
    integrity: current.integrity,
  };
}

function qualificationChecks(capabilities, cypressBinaryVersion) {
  const checks = [
    {
      id: "cypress-candidate-lock",
      kind: "command",
      scope: "global",
      command: "npm",
      arguments: [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      cwd: PACKAGE_DIRECTORY,
      environment: {},
      covers: ["candidate-lock"],
    },
    {
      id: "cypress-lock-evidence",
      kind: "lock-evidence",
      scope: "global",
      cwd: PACKAGE_DIRECTORY,
      covers: ["direct-packages", "package-binary", "node-range"],
    },
    {
      id: "cypress-candidate-install",
      kind: "command",
      scope: "global",
      command: "npm",
      arguments: ["ci", "--no-audit", "--no-fund"],
      cwd: PACKAGE_DIRECTORY,
      environment: {},
      covers: ["candidate-install", "package-binary"],
    },
    {
      id: "cypress-installed-binary",
      kind: "binary-evidence",
      scope: "global",
      command: "node",
      arguments: ["node_modules/cypress/bin/cypress", "version"],
      cwd: PACKAGE_DIRECTORY,
      environment: {},
      covers: ["package-binary"],
      expected_package_version: cypressBinaryVersion,
      expected_binary_version: cypressBinaryVersion,
    },
    {
      id: "cypress-package-tests",
      kind: "command",
      scope: "global",
      command: "npm",
      arguments: ["test"],
      cwd: PACKAGE_DIRECTORY,
      environment: {},
      covers: ["package-tests"],
    },
  ];
  for (const capability of capabilities) {
    for (const scenario of capability.scenarios) {
      checks.push({
        id: `${capability.id}-${scenario}`,
        kind: "command",
        scope: capability.id,
        command: "node",
        arguments: [
          "tests/e2e/cypress/task.mjs",
          scenario,
          "--browser",
          capability.browser,
        ],
        cwd: ".",
        environment: {
          E2E_BROWSER: capability.browser,
          E2E_OS: capability.os,
        },
        covers: [scenario],
      });
    }
    checks.push({
      id: `${capability.id}-artifact-contracts`,
      kind: "command",
      scope: capability.id,
      command: "node",
      arguments: [".github/scripts/validate-e2e-reports.mjs"],
      cwd: ".",
      environment: {
        E2E_CAPABILITY_ID: capability.id,
        E2E_EVIDENCE_FILE: capability.evidence,
        E2E_REQUIRED_FILES: JSON.stringify(capability.required_files),
        E2E_REQUIRE_ACCESSIBILITY: String(
          capability.require_accessibility,
        ),
        E2E_RESULT_REPORTS: JSON.stringify(capability.result_reports),
      },
      covers: ["reports", "accessibility", "evidence"],
    });
  }
  return checks;
}

function qualificationPlan({
  axeMetadata,
  capabilities,
  cypressMetadata,
  cypressBinary,
  currentLock,
  nodeRange,
  observation,
}) {
  if (observation.disposition.state !== "candidate") {
    return null;
  }
  const cypressBinaryVersion =
    candidateVersion(
      lockPackage(currentLock, "cypress").version,
      cypressMetadata,
    ) ?? lockPackage(currentLock, "cypress").version;
  return {
    schema_version: 1,
    provider_id: PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    repository: structuredClone(observation.repository),
    workspace: {
      kind: "ephemeral-copy",
      mutation_boundary: PACKAGE_DIRECTORY,
      managed_paths: [...CYPRESS_MANAGED_PATHS],
    },
    packages: [
      expectedPackage(
        "axe-core",
        lockPackage(currentLock, "axe-core").version,
        currentLock,
        axeMetadata,
      ),
      expectedPackage(
        "cypress",
        lockPackage(currentLock, "cypress").version,
        currentLock,
        cypressMetadata,
      ),
    ].sort((left, right) => left.name.localeCompare(right.name)),
    cypress_binary: {
      version: cypressBinaryVersion,
      evidence: structuredClone(cypressBinary.evidence),
    },
    node_range: nodeRange,
    selected_capabilities: capabilities.map((capability) => ({
      id: capability.id,
      browser: capability.browser,
      os: capability.os,
      runner: capability.runner,
      scenarios: [...capability.scenarios],
      evidence: capability.evidence,
      required_files: [...capability.required_files],
      result_reports: [...capability.result_reports],
      require_accessibility: capability.require_accessibility,
    })),
    checks: qualificationChecks(capabilities, cypressBinaryVersion),
  };
}

export async function collectCypressCohort({
  binaryEvidence,
  externalBrowserEvidence,
  generatedAt = new Date().toISOString(),
  npmEvidence,
  repository,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const identity = repository ?? (await repositoryIdentity(root));
  const packageJson = await readJson(repositoryPath(root, PACKAGE_PATH));
  const lock = await readJson(repositoryPath(root, LOCK_PATH));
  const current = validatePackageFiles(packageJson, lock);
  const [catalog, capabilityCatalog, nodeConfig, nodeLock] =
    await Promise.all([
      readJson(repositoryPath(root, CATALOG_PATH)),
      readCapabilityCatalog(repositoryPath(root, CATALOG_PATH)),
      readFile(repositoryPath(root, NODE_CONFIG_PATH), "utf8"),
      readFile(repositoryPath(root, NODE_LOCK_PATH), "utf8"),
    ]);
  const capabilities = selectCapabilities(catalog);
  const node = parseNodeFiles(nodeConfig, nodeLock);
  const affectedCapabilities = capabilities.map(({ id }) => id);
  const [
    packageFileEvidence,
    lockFileEvidence,
    catalogFileEvidence,
    nodeConfigEvidence,
    nodeLockEvidence,
  ] = await Promise.all(
    [
      PACKAGE_PATH,
      LOCK_PATH,
      CATALOG_PATH,
      NODE_CONFIG_PATH,
      NODE_LOCK_PATH,
    ].map((path) =>
      repositoryEvidence({
        generatedAt,
        path,
        repositoryRevision: identity.revision,
        repositoryRoot: root,
      }),
    ),
  );

  const cypressNpm = await captureEvidence(
    npmEvidence,
    {
      name: "cypress",
      currentVersion: current.cypress,
    },
    (raw) => npmMetadata("cypress", raw, generatedAt),
    "CYPRESS_NPM_EVIDENCE_UNAVAILABLE",
  );
  const axeNpm = await captureEvidence(
    npmEvidence,
    {
      name: "axe-core",
      currentVersion: current.axeCore,
    },
    (raw) => npmMetadata("axe-core", raw, generatedAt),
    "AXE_NPM_EVIDENCE_UNAVAILABLE",
  );
  const currentBinary = await captureEvidence(
    binaryEvidence,
    {
      packageVersion: current.cypress,
      phase: "current",
    },
    (raw) => binaryMetadata(raw, generatedAt, "current Cypress binary"),
    "CURRENT_CYPRESS_BINARY_EVIDENCE_UNAVAILABLE",
  );
  const candidateCypressVersion = candidateVersion(
    current.cypress,
    cypressNpm.value,
  );
  const candidateBinary =
    candidateCypressVersion === null
      ? { value: null, reasonCodes: [], warnings: [] }
      : await captureEvidence(
          binaryEvidence,
          {
            packageVersion: candidateCypressVersion,
            phase: "candidate",
          },
          (raw) =>
            binaryMetadata(raw, generatedAt, "candidate Cypress binary"),
          "CANDIDATE_CYPRESS_BINARY_EVIDENCE_UNAVAILABLE",
        );
  const browserResults = [];
  for (const capability of capabilities) {
    browserResults.push(
      await captureEvidence(
        externalBrowserEvidence,
        {
          browser: capability.browser,
          capabilityId: capability.id,
          os: capability.os,
          runner: capability.runner,
        },
        (raw) => browserMetadata(raw, capability, generatedAt),
        "CYPRESS_BROWSER_EVIDENCE_UNAVAILABLE",
      ),
    );
  }

  const evidenceResults = [
    cypressNpm,
    axeNpm,
    currentBinary,
    candidateBinary,
    ...browserResults,
  ];
  const reasonCodes = evidenceResults.flatMap(
    (result) => result.reasonCodes,
  );
  const warnings = evidenceWarnings(evidenceResults);
  const browserValues = browserResults
    .map(({ value }) => value)
    .filter((value) => value !== null);
  let incompatible = false;

  if (capabilities.some(({ browser }) => browser === ELECTRON)) {
    reasonCodes.push("DEPRECATED_ELECTRON_SELECTED");
    incompatible = true;
  }
  if (
    cypressNpm.value !== null &&
    compareVersions(cypressNpm.value.version, current.cypress) < 0
  ) {
    reasonCodes.push("CYPRESS_NPM_METADATA_REGRESSION");
  }
  if (
    axeNpm.value !== null &&
    compareVersions(axeNpm.value.version, current.axeCore) < 0
  ) {
    reasonCodes.push("AXE_NPM_METADATA_REGRESSION");
  }
  if (
    cypressNpm.value !== null &&
    typeof cypressNpm.value.engines.node !== "string"
  ) {
    reasonCodes.push("CYPRESS_NODE_RANGE_UNAVAILABLE");
  }
  if (
    currentBinary.value !== null &&
    currentBinary.value.version !== current.cypress
  ) {
    reasonCodes.push("CURRENT_CYPRESS_BINARY_VERSION_MISMATCH");
    incompatible = true;
  }
  if (
    candidateCypressVersion !== null &&
    candidateBinary.value !== null &&
    candidateBinary.value.version !== candidateCypressVersion
  ) {
    reasonCodes.push("CANDIDATE_CYPRESS_BINARY_VERSION_MISMATCH");
    incompatible = true;
  }
  for (const browser of browserValues) {
    const capability = capabilities.find(
      ({ id }) => id === browser.capabilityId,
    );
    if (
      capability === undefined ||
      browser.browser !== capability.browser ||
      browser.runner !== capability.runner ||
      browser.os !== capability.os
    ) {
      reasonCodes.push("CYPRESS_BROWSER_IDENTITY_MISMATCH");
      incompatible = true;
    }
  }

  const cypressCandidate =
    candidateCypressVersion === null
      ? null
      : {
          version: candidateCypressVersion,
          evidence: [
            cypressNpm.value.evidence,
            nodeConfigEvidence,
            nodeLockEvidence,
          ],
        };
  const axeCandidateVersion = candidateVersion(
    current.axeCore,
    axeNpm.value,
  );
  const axeCandidate =
    axeCandidateVersion === null
      ? null
      : {
          version: axeCandidateVersion,
          evidence: [axeNpm.value.evidence],
        };
  const binaryCandidate =
    candidateCypressVersion === null || candidateBinary.value === null
      ? null
      : {
          version: candidateBinary.value.version,
          evidence: [candidateBinary.value.evidence],
        };
  const candidateCount = [
    cypressCandidate,
    axeCandidate,
    binaryCandidate,
  ].filter((candidate) => candidate !== null).length;
  const nodeRange =
    cypressNpm.value?.engines.node ?? current.cypressNodeRange;
  const observation = {
    schema_version: 1,
    kind: "observation",
    generated_at: generatedAt,
    repository: structuredClone(identity),
    capability_catalog: {
      schema_version: capabilityCatalog.schemaVersion,
      digest: capabilityCatalog.digest,
    },
    provider_id: PROVIDER_ID,
    disposition: dispositionFor({
      candidateCount,
      incompatible,
      reasonCodes,
      warnings,
    }),
    components: [
      component({
        affectedCapabilities,
        candidate: cypressCandidate,
        current: {
          version: current.cypress,
          evidence: [
            packageFileEvidence,
            packageLockEvidence(lock, "cypress", generatedAt),
            nodeConfigEvidence,
            nodeLockEvidence,
          ],
        },
        ecosystem: "npm",
        id: "cypress-package",
        managedPath: PACKAGE_PATH,
      }),
      component({
        affectedCapabilities,
        candidate: axeCandidate,
        current: {
          version: current.axeCore,
          evidence: [
            lockFileEvidence,
            packageLockEvidence(lock, "axe-core", generatedAt),
          ],
        },
        ecosystem: "npm",
        id: "cypress-axe-core",
        managedPath: LOCK_PATH,
      }),
      component({
        affectedCapabilities,
        candidate: binaryCandidate,
        current: {
          version: currentBinary.value?.version ?? current.cypress,
          evidence: [
            currentBinary.value?.evidence ??
              packageLockEvidence(lock, "cypress", generatedAt),
          ],
        },
        ecosystem: "cypress-binary",
        id: "cypress-package-binary",
        managedPath: BINARY_POLICY_PATH,
      }),
      component({
        affectedCapabilities,
        candidate: null,
        current: {
          version:
            browserValues.length === capabilities.length
              ? browserVersion(browserValues)
              : capabilities
                  .map(
                    (capability) =>
                      `${capability.browser}@unknown on ` +
                      `${capability.os}/${capability.runner}`,
                  )
                  .sort()
                  .join(", "),
          evidence:
            browserValues.length === 0
              ? [catalogFileEvidence]
              : browserValues.map(({ evidence }) => evidence),
        },
        ecosystem: "runner",
        id: "cypress-external-browser",
        managedPath: CATALOG_PATH,
      }),
    ],
    relations: [
      relation({
        constraint:
          `${nodeRange}; repository Node ${node.locked} ` +
          `(configured ${node.configured})`,
        from: "cypress-package",
        hard: true,
        id: "cypress-package-requires-node-runtime",
        to: "node-runtime",
        type: "requires",
      }),
      relation({
        constraint:
          `Cypress package ${candidateCypressVersion ?? current.cypress} ` +
          "must match the downloaded Cypress binary",
        from: "cypress-package",
        hard: true,
        id: "cypress-package-matches-binary",
        to: "cypress-package-binary",
        type: "must-match",
      }),
      relation({
        constraint: browserConstraint(capabilities, browserValues),
        from: "cypress-package",
        hard: true,
        id: "cypress-package-uses-catalog-browser",
        to: "cypress-external-browser",
        type: "uses-external",
      }),
      relation({
        constraint:
          `axe-core ${axeCandidateVersion ?? current.axeCore} remains ` +
          "an independently tested accessibility advisory",
        from: "cypress-package",
        hard: false,
        id: "cypress-package-aligns-axe-core",
        to: "cypress-axe-core",
        type: "policy-align",
      }),
    ],
  };
  validateDocument(observation, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  return {
    observation,
    qualification_plan: qualificationPlan({
      axeMetadata: axeNpm.value,
      capabilities,
      cypressBinary:
        candidateBinary.value ?? currentBinary.value,
      cypressMetadata: cypressNpm.value,
      currentLock: lock,
      nodeRange,
      observation,
    }),
    warnings,
  };
}

export async function collectCypressObservation(options) {
  return (await collectCypressCohort(options)).observation;
}

export function createCypressQualificationPlan(collection) {
  const observation = collection?.observation;
  const plan = collection?.qualification_plan;
  if (observation?.disposition?.state !== "candidate" || plan === null) {
    throw new Error("Cypress qualification requires an available candidate");
  }
  if (plan.candidate_digest !== subjectDigest(observation)) {
    throw new Error("Cypress qualification plan is stale");
  }
  return structuredClone(plan);
}

function isWithin(root, path) {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

async function copyRepository(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter(path) {
      const repositoryRelative = relative(source, path);
      if (repositoryRelative === "") {
        return true;
      }
      return !repositoryRelative
        .split(sep)
        .some((part) =>
          [".git", "diagnostics", "node_modules", "target"].includes(part),
        );
    },
  });
}

async function applyCandidatePackages(plan, workspaceRoot) {
  const path = repositoryPath(workspaceRoot, PACKAGE_PATH);
  const packageJson = await readJson(path);
  packageJson.dependencies ??= {};
  for (const candidate of plan.packages) {
    packageJson.dependencies[candidate.name] = candidate.version;
  }
  packageJson.allowScripts ??= {};
  for (const key of Object.keys(packageJson.allowScripts)) {
    if (key.startsWith("cypress@")) {
      delete packageJson.allowScripts[key];
    }
  }
  packageJson.allowScripts[`cypress@${plan.cypress_binary.version}`] = true;
  await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function fileState(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? hash(await readFile(path)) : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function sourceState(repositoryRoot, managedPaths) {
  return Object.fromEntries(
    await Promise.all(
      managedPaths.map(async (path) => [
        path,
        await fileState(repositoryPath(repositoryRoot, path)),
      ]),
    ),
  );
}

async function treeEntries(root, directory = root) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const repositoryRelative = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      entries.push(...(await treeEntries(root, path)));
    } else if (entry.isFile()) {
      entries.push([
        repositoryRelative,
        hash(await readFile(path)),
      ]);
    }
  }
  return entries;
}

async function outsideBoundaryDigest(workspaceRoot, boundary) {
  const prefix = `${boundary}/`;
  const entries = (await treeEntries(workspaceRoot))
    .filter(
      ([path]) => path !== boundary && !path.startsWith(prefix),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return metadataDigest(entries);
}

function verifyLock(plan, workspaceRoot) {
  return readJson(repositoryPath(workspaceRoot, LOCK_PATH)).then((lock) => {
    const root = lock.packages?.[""];
    for (const expected of plan.packages) {
      if (root?.dependencies?.[expected.name] !== expected.version) {
        throw new Error(
          `Ephemeral lock root does not pin ` +
            `${expected.name}@${expected.version}`,
        );
      }
      const installed = lockPackage(lock, expected.name);
      for (const key of ["version", "resolved", "integrity"]) {
        if (installed?.[key] !== expected[key]) {
          throw new Error(
            `Ephemeral lock ${expected.name}.${key} does not match ` +
              "immutable npm evidence",
          );
        }
      }
    }
    const cypress = lockPackage(lock, "cypress");
    if (cypress.engines?.node !== plan.node_range) {
      throw new Error(
        "Ephemeral Cypress Node range does not match npm evidence",
      );
    }
    if (cypress.bin?.cypress !== "bin/cypress") {
      throw new Error("Ephemeral Cypress package binary is missing");
    }
  });
}

function commandEvidence(check, revision, output, startedAt, completedAt) {
  return {
    type: "qualification-check",
    locator: `cypress-check:${check.id}`,
    revision,
    digest: metadataDigest({
      arguments: check.arguments ?? [],
      command: check.command ?? check.kind,
      output,
    }),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

function outputWarnings(output) {
  return sortedUnique(
    output
      .split(/\r?\n/u)
      .filter((line) => /\bwarn(?:ing)?\b/iu.test(line))
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function runCommandCheck(check, {
  environment,
  revision,
  workspaceRoot,
}) {
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(
      check.command,
      check.arguments,
      {
        cwd: resolve(workspaceRoot, check.cwd),
        encoding: "utf8",
        env: {
          ...environment,
          ...check.environment,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const completedAt = new Date().toISOString();
    const output = `${stdout}${stderr}`;
    const binaryVersionMissing =
      check.kind === "binary-evidence" &&
      (!output.includes(
        `Cypress package version: ${check.expected_package_version}`,
      ) ||
        !output.includes(
          `Cypress binary version: ${check.expected_binary_version}`,
        ));
    return {
      status: binaryVersionMissing ? "fail" : "pass",
      warnings: outputWarnings(output),
      evidence: [
        commandEvidence(
          check,
          revision,
          output,
          startedAt,
          completedAt,
        ),
      ],
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`;
    return {
      status: "fail",
      warnings: outputWarnings(output),
      evidence: [
        commandEvidence(
          check,
          revision,
          output,
          startedAt,
          completedAt,
        ),
      ],
    };
  }
}

function normalizeCheckResult(check, raw, revision, now) {
  const fallbackEvidence = commandEvidence(
    check,
    revision,
    "missing qualification evidence",
    now,
    now,
  );
  if (raw === null || raw === undefined) {
    return {
      ...check,
      status: "unknown",
      warnings: ["Qualification check returned no evidence"],
      evidence: [fallbackEvidence],
    };
  }
  const status = raw.status;
  if (!["blocked", "fail", "pass", "unknown"].includes(status)) {
    throw new Error(`${check.id} returned unsupported status ${status}`);
  }
  const warnings = normalizeWarnings(raw.warnings, check.id);
  const evidence = raw.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ...check,
      status: "unknown",
      warnings: sortedUnique([
        ...warnings,
        "Qualification check returned no evidence",
      ]),
      evidence: [fallbackEvidence],
    };
  }
  return {
    ...check,
    status,
    warnings,
    evidence: structuredClone(evidence),
  };
}

function aggregateStatus(checks) {
  if (checks.some(({ status }) => status === "fail")) {
    return "fail";
  }
  if (checks.some(({ status }) => status === "blocked")) {
    return "blocked";
  }
  if (checks.some(({ status }) => status === "unknown")) {
    return "unknown";
  }
  return "pass";
}

function validationDisposition(results) {
  if (
    results.every(
      (result) => result.status === "pass" && result.warnings.length === 0,
    )
  ) {
    return {
      state: "independently-qualified",
      reason_codes: [],
    };
  }
  if (results.some(({ status }) => status === "unknown")) {
    return {
      state: "unknown",
      reason_codes: ["QUALIFICATION_EVIDENCE_MISSING"],
    };
  }
  if (results.some(({ warnings }) => warnings.length > 0)) {
    return {
      state: "blocked",
      reason_codes: ["QUALIFICATION_WARNINGS"],
    };
  }
  return {
    state: "blocked",
    reason_codes: ["QUALIFICATION_FAILED"],
  };
}

export async function qualifyCypressCandidate(
  collection,
  {
    createWorkspace = async () =>
      mkdtemp(join(tmpdir(), "oculix-cypress-qualification-")),
    environment = process.env,
    executeCheck,
    generatedAt = new Date().toISOString(),
    materializeWorkspace = copyRepository,
    repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  } = {},
) {
  const observation = collection?.observation;
  const plan = collection?.qualification_plan;
  if (observation?.disposition?.state !== "candidate" || plan === null) {
    throw new Error("Cypress qualification requires an available candidate");
  }
  if (plan.candidate_digest !== subjectDigest(observation)) {
    throw new Error("Cypress qualification plan is stale");
  }
  const root = resolve(repositoryRoot);
  const initialSource = await sourceState(
    root,
    plan.workspace.managed_paths,
  );
  const temporaryRoot = resolve(await createWorkspace());
  if (isWithin(root, temporaryRoot) || isWithin(temporaryRoot, root)) {
    throw new Error("Ephemeral workspace must be outside the repository");
  }
  const workspaceRoot = join(temporaryRoot, "repository");
  let result;
  let workError;
  try {
    await materializeWorkspace(root, workspaceRoot);
    const outsideBefore = await outsideBoundaryDigest(
      workspaceRoot,
      plan.workspace.mutation_boundary,
    );
    await applyCandidatePackages(plan, workspaceRoot);
    const checkResults = [];
    for (const check of plan.checks) {
      let raw;
      if (check.kind === "lock-evidence") {
        const startedAt = new Date().toISOString();
        try {
          await verifyLock(plan, workspaceRoot);
          const completedAt = new Date().toISOString();
          raw = {
            status: "pass",
            warnings: [],
            evidence: [
              commandEvidence(
                check,
                observation.repository.revision,
                "lock evidence matched",
                startedAt,
                completedAt,
              ),
            ],
          };
        } catch (error) {
          const completedAt = new Date().toISOString();
          raw = {
            status: "fail",
            warnings: [],
            evidence: [
              commandEvidence(
                check,
                observation.repository.revision,
                error.message,
                startedAt,
                completedAt,
              ),
            ],
          };
        }
      } else if (executeCheck === undefined) {
        raw = await runCommandCheck(check, {
          environment,
          revision: observation.repository.revision,
          workspaceRoot,
        });
      } else {
        raw = await executeCheck(structuredClone(check), {
          environment: {
            ...environment,
            ...check.environment,
          },
          packageRoot: repositoryPath(workspaceRoot, PACKAGE_DIRECTORY),
          workspaceRoot,
        });
      }
      checkResults.push(
        normalizeCheckResult(
          check,
          raw,
          observation.repository.revision,
          generatedAt,
        ),
      );
    }
    const outsideAfter = await outsideBoundaryDigest(
      workspaceRoot,
      plan.workspace.mutation_boundary,
    );
    if (outsideAfter !== outsideBefore) {
      throw new Error(
        "Cypress qualification modified files outside its package boundary",
      );
    }
    const globalChecks = checkResults.filter(
      ({ scope }) => scope === "global",
    );
    const results = plan.selected_capabilities.map((capability) => {
      const capabilityChecks = checkResults.filter(
        ({ scope }) => scope === capability.id,
      );
      const requiredChecks = [...globalChecks, ...capabilityChecks];
      return {
        capability_id: capability.id,
        status: aggregateStatus(requiredChecks),
        warnings: sortedUnique(
          requiredChecks.flatMap(({ warnings }) => warnings),
        ),
        evidence: requiredChecks.flatMap(({ evidence }) =>
          structuredClone(evidence),
        ),
      };
    });
    const validation = {
      schema_version: 1,
      kind: "validation",
      generated_at: generatedAt,
      repository: structuredClone(observation.repository),
      capability_catalog: structuredClone(
        observation.capability_catalog,
      ),
      provider_id: PROVIDER_ID,
      candidate_digest: plan.candidate_digest,
      disposition: validationDisposition(results),
      results,
    };
    const capabilityIds = new Set(
      plan.selected_capabilities.map(({ id }) => id),
    );
    validateDocument(validation, {
      capabilityIds,
      capabilityCatalogDigest: observation.capability_catalog.digest,
    });
    if (validation.disposition.state === "independently-qualified") {
      validateIndependentQualification(observation, validation, {
        capabilityIds,
        capabilityCatalogDigest: observation.capability_catalog.digest,
      });
    }
    result = {
      validation,
      checks: checkResults,
    };
  } catch (error) {
    workError = error;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  const finalSource = await sourceState(root, plan.workspace.managed_paths);
  if (JSON.stringify(initialSource) !== JSON.stringify(finalSource)) {
    throw new Error("Cypress qualification mutated the source repository");
  }
  if (workError !== undefined) {
    throw workError;
  }
  return result;
}
