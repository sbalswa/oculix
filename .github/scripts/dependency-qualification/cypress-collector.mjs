import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  glob,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
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
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const PARTIAL_VERSION_PATTERN =
  /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?$/u;
const CYPRESS_ACCESSIBILITY_POLICY = Object.freeze({
  blockingViolationCount: 1,
  incompleteBlocking: false,
  levels: ["A", "AA"],
  standards: ["WCAG 2.0", "WCAG 2.1", "WCAG 2.2"],
  tags: [
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
  ],
});

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
  parseSemver(value, name);
}

function parseSemver(value, name = "version") {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${name} must be a strict semantic version`);
  }
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/u.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    )
  ) {
    throw new Error(
      `${name} has a numeric prerelease identifier with a leading zero`,
    );
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    version: value,
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier
        ? 0
        : leftIdentifier === undefined
          ? -1
          : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier);
      const rightNumber = BigInt(rightIdentifier);
      return leftNumber === rightNumber
        ? 0
        : leftNumber < rightNumber
          ? -1
          : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  const leftVersion = parseSemver(left, "left version");
  const rightVersion = parseSemver(right, "right version");
  for (const key of ["major", "minor", "patch"]) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] < rightVersion[key] ? -1 : 1;
    }
  }
  return comparePrerelease(
    leftVersion.prerelease,
    rightVersion.prerelease,
  );
}

function partialBounds(value) {
  const match = PARTIAL_VERSION_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const identifiers = match.slice(1, 4);
  const wildcardIndex = identifiers.findIndex(
    (identifier) =>
      identifier === undefined || /^[xX*]$/u.test(identifier),
  );
  if (wildcardIndex === -1) {
    return null;
  }
  if (
    identifiers
      .slice(wildcardIndex)
      .some(
        (identifier) =>
          identifier !== undefined && !/^[xX*]$/u.test(identifier),
      )
  ) {
    throw new Error(`Invalid partial semantic version ${value}`);
  }
  const numbers = identifiers.map((identifier) =>
    identifier === undefined || /^[xX*]$/u.test(identifier)
      ? 0n
      : BigInt(identifier),
  );
  const minimum = `${numbers[0]}.${numbers[1]}.${numbers[2]}`;
  if (wildcardIndex === 0) {
    return { minimum: null, maximum: null };
  }
  const maximum = [...numbers];
  maximum[wildcardIndex - 1] += 1n;
  for (let index = wildcardIndex; index < maximum.length; index += 1) {
    maximum[index] = 0n;
  }
  return {
    minimum,
    maximum: maximum.join("."),
  };
}

function comparatorMatches(version, token) {
  const match = /^(<=|>=|<|>|=|~|\^)?(.+)$/u.exec(token);
  if (match === null) {
    throw new Error(`Invalid semantic-version comparator ${token}`);
  }
  const operator = match[1] ?? "";
  const target = match[2];
  const partial = partialBounds(target);
  if (partial !== null) {
    if (["", "="].includes(operator)) {
      return (
        (partial.minimum === null ||
          compareVersions(version, partial.minimum) >= 0) &&
        (partial.maximum === null ||
          compareVersions(version, partial.maximum) < 0)
      );
    }
    if (operator === ">=") {
      return (
        partial.minimum === null ||
        compareVersions(version, partial.minimum) >= 0
      );
    }
    if (operator === ">") {
      return (
        partial.maximum !== null &&
        compareVersions(version, partial.maximum) >= 0
      );
    }
    if (operator === "<") {
      return (
        partial.minimum !== null &&
        compareVersions(version, partial.minimum) < 0
      );
    }
    if (operator === "<=") {
      return (
        partial.maximum === null ||
        compareVersions(version, partial.maximum) < 0
      );
    }
    throw new Error(`Invalid partial semantic-version comparator ${token}`);
  }
  const parsed = parseSemver(target, `range comparator ${token}`);
  const comparison = compareVersions(version, target);
  if (operator === "") {
    return comparison === 0;
  }
  if (operator === "=") {
    return comparison === 0;
  }
  if (operator === ">") {
    return comparison > 0;
  }
  if (operator === ">=") {
    return comparison >= 0;
  }
  if (operator === "<") {
    return comparison < 0;
  }
  if (operator === "<=") {
    return comparison <= 0;
  }
  if (operator === "~") {
    const upper = `${parsed.major}.${parsed.minor + 1n}.0`;
    return comparison >= 0 && compareVersions(version, upper) < 0;
  }
  const upper =
    parsed.major > 0n
      ? `${parsed.major + 1n}.0.0`
      : parsed.minor > 0n
        ? `0.${parsed.minor + 1n}.0`
        : `0.0.${parsed.patch + 1n}`;
  return comparison >= 0 && compareVersions(version, upper) < 0;
}

function satisfiesRange(version, range, name = "Node range") {
  parseSemver(version, "resolved Node version");
  assertNonemptyString(range, name);
  const alternatives = range.split(/\s*\|\|\s*/u).map((alternative) => {
    if (alternative.length === 0) {
      throw new Error(`${name} contains an empty alternative`);
    }
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(alternative);
    if (hyphen !== null) {
      parseSemver(hyphen[1], `${name} lower bound`);
      parseSemver(hyphen[2], `${name} upper bound`);
      return (
        compareVersions(version, hyphen[1]) >= 0 &&
        compareVersions(version, hyphen[2]) <= 0
      );
    }
    const tokens = alternative.trim().split(/\s+/u);
    return tokens
      .map((token) => comparatorMatches(version, token))
      .every(Boolean);
  });
  return alternatives.some(Boolean);
}

function assertSemverRange(value, name) {
  satisfiesRange("24.0.0", value, name);
  return value;
}

function normalizedNodeVersion(value, name) {
  assertNonemptyString(value, name);
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  parseSemver(normalized, name);
  return normalized;
}

function assertAbsolutePath(value, name) {
  assertNonemptyString(value, name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
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
  assertSemverRange(engines.node, `${name}.engines.node`);
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
  assertAbsolutePath(raw.locator, `${name}.locator`);
  assertAbsolutePath(raw.realpath, `${name}.realpath`);
  assertDigest(raw.digest, `${name}.digest`);
  return {
    version: raw.version,
    locator: raw.locator,
    realpath: raw.realpath,
    digest: raw.digest,
    warnings: normalizeWarnings(raw.warnings, name),
    evidence: {
      type: "cypress-binary",
      locator: raw.realpath,
      revision: raw.version,
      digest: raw.digest,
      observed_at: generatedAt,
    },
    locatorEvidence: {
      type: "cypress-binary-locator",
      locator: raw.locator,
      revision: raw.realpath,
      digest: raw.digest,
      observed_at: generatedAt,
    },
  };
}

function browserMetadata(raw, capability, generatedAt) {
  if (raw === null || raw === undefined) {
    return null;
  }
  for (const key of [
    "browser",
    "runner",
    "os",
    "version",
    "path",
    "realpath",
  ]) {
    assertNonemptyString(raw[key], `browser evidence ${key}`);
  }
  assertAbsolutePath(raw.path, "browser evidence path");
  assertAbsolutePath(raw.realpath, "browser evidence realpath");
  assertDigest(raw.digest, "browser evidence digest");
  return {
    browser: raw.browser.toLowerCase(),
    runner: raw.runner,
    os: raw.os,
    version: raw.version,
    path: raw.path,
    realpath: raw.realpath,
    digest: raw.digest,
    warnings: normalizeWarnings(raw.warnings, "browser evidence"),
    evidence: {
      type: "external-browser",
      locator: raw.realpath,
      revision: `${raw.browser.toLowerCase()}@${raw.version}`,
      digest: raw.digest,
      observed_at: generatedAt,
    },
    locatorEvidence: {
      type: "external-browser-locator",
      locator: raw.path,
      revision: raw.realpath,
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
  const packageNodeRange = assertSemverRange(
    packageJson.engines?.node,
    "package.json engines.node",
  );
  if (root.engines?.node !== packageNodeRange) {
    throw new Error(
      "package-lock root engines.node must match package.json",
    );
  }
  const packageNodeRanges = {};
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
    packageNodeRanges[name] = assertSemverRange(
      installed.engines?.node,
      `${name} lock engines.node`,
    );
  }
  const cypress = lockPackage(lock, "cypress");
  assertNonemptyString(cypress.engines?.node, "Cypress lock Node range");
  if (cypress.bin?.cypress !== "bin/cypress") {
    throw new Error("Cypress lock must declare the package binary");
  }
  return {
    axeCore: packageJson.dependencies["axe-core"],
    cypress: packageJson.dependencies.cypress,
    packageNodeRange,
    packageNodeRanges,
  };
}

function parseNodeFiles(config, lock) {
  const configured = /^\s*node\s*=\s*"([^"]+)"\s*$/mu.exec(config)?.[1];
  const locked =
    /^\s*\[\[tools\.node\]\][\s\S]*?^\s*version\s*=\s*"([^"]+)"\s*$/mu
      .exec(lock)?.[1];
  if (typeof configured !== "string" || !/^[1-9]\d*$/u.test(configured)) {
    throw new Error("configured Node range must be one numeric major");
  }
  assertExactVersion(locked, "locked Node version");
  if (String(parseSemver(locked).major) !== configured) {
    throw new Error(
      `locked Node ${locked} does not resolve configured major ${configured}`,
    );
  }
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
  for (const capability of capabilities) {
    if (!capability.scenarios.includes("smoke")) {
      throw new Error(
        `${capability.id} must include the Cypress smoke scenario`,
      );
    }
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

async function inspectGitCheckout(repositoryRoot) {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ),
  ]);
  return {
    clean: status.length === 0,
    revision: revision.trim(),
  };
}

async function assertSourceCheckout(
  repositoryRoot,
  repository,
  inspector,
) {
  const checkout = await inspector(repositoryRoot);
  if (
    checkout?.clean !== true ||
    checkout?.revision !== repository.revision
  ) {
    throw new Error(
      `Cypress qualification requires a clean source checkout at ` +
        `${repository.revision}`,
    );
  }
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
      engines: structuredClone(upstream.engines),
    };
  }
  const current = lockPackage(currentLock, name);
  return {
    name,
    version: current.version,
    resolved: current.resolved,
    integrity: current.integrity,
    engines: structuredClone(current.engines),
  };
}

function qualificationChecks({
  capabilities,
  cypressBinary,
  node,
}) {
  const checks = [
    {
      id: "cypress-binary-source",
      kind: "file-evidence",
      scope: "global",
      cwd: ".",
      path: cypressBinary.locator,
      expected_realpath: cypressBinary.realpath,
      expected_digest: cypressBinary.digest,
      expected_version: cypressBinary.version,
      covers: ["package-binary", "immutable-binary-source"],
      writes: [],
    },
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
      writes: [PACKAGE_DIRECTORY],
    },
    {
      id: "cypress-lock-evidence",
      kind: "lock-evidence",
      scope: "global",
      cwd: PACKAGE_DIRECTORY,
      covers: ["direct-packages", "package-binary", "node-range"],
      writes: [],
    },
    {
      id: "cypress-candidate-install",
      kind: "command",
      scope: "global",
      command: "npm",
      arguments: ["ci", "--no-audit", "--no-fund"],
      cwd: PACKAGE_DIRECTORY,
      environment: {
        CYPRESS_INSTALL_BINARY: cypressBinary.realpath,
      },
      covers: ["candidate-install", "package-binary"],
      writes: [PACKAGE_DIRECTORY],
    },
    {
      id: "cypress-install-provenance",
      kind: "binary-provenance",
      scope: "global",
      cwd: PACKAGE_DIRECTORY,
      expected_archive_locator: cypressBinary.locator,
      expected_archive_realpath: cypressBinary.realpath,
      expected_archive_digest: cypressBinary.digest,
      expected_binary_version: cypressBinary.version,
      covers: ["candidate-install", "immutable-binary-source"],
      writes: [],
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
      expected_package_version: cypressBinary.version,
      expected_binary_version: cypressBinary.version,
      writes: [],
    },
    {
      id: "cypress-node-runtime",
      kind: "node-evidence",
      scope: "global",
      command: "node",
      arguments: ["--version"],
      cwd: PACKAGE_DIRECTORY,
      environment: {},
      expected_version: node.locked,
      covers: ["node-runtime", "node-range"],
      writes: [],
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
      writes: [],
    },
  ];
  for (const capability of capabilities) {
    checks.push({
      id: `${capability.id}-external-browser`,
      kind: "browser-evidence",
      scope: capability.id,
      command: capability.browser_evidence.realpath,
      arguments: ["--version"],
      cwd: ".",
      environment: {},
      expected_browser: capability.browser,
      expected_alias: capability.browser_evidence.path,
      expected_digest: capability.browser_evidence.digest,
      expected_realpath: capability.browser_evidence.realpath,
      expected_version: capability.browser_evidence.version,
      covers: ["external-browser"],
      writes: [],
    });
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
          CHROME_BIN: capability.browser_evidence.realpath,
          CYPRESS_BROWSER_PATH: capability.browser_evidence.realpath,
          CYPRESS_INSTALL_BINARY: cypressBinary.realpath,
          E2E_BROWSER: capability.browser,
          E2E_OS: capability.os,
        },
        covers: [scenario],
        writes: [`${PACKAGE_DIRECTORY}/diagnostics`],
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
      writes: [],
    });
    checks.push({
      id: `${capability.id}-artifact-semantics`,
      kind: "artifact-semantics",
      scope: capability.id,
      cwd: ".",
      capability_id: capability.id,
      covers: [
        "scenarios",
        "reports",
        "accessibility",
        "evidence",
        "browser-identity",
        "node-runtime",
      ],
      writes: [],
    });
  }
  return checks;
}

function qualificationPlanDigest(plan) {
  const { plan_digest: ignored, ...prescription } = plan;
  return metadataDigest(prescription);
}

function qualificationPlan({
  axeMetadata,
  capabilities,
  cypressMetadata,
  cypressBinary,
  currentLock,
  node,
  observation,
  browserEvidence,
}) {
  if (observation.disposition.state !== "candidate") {
    return null;
  }
  const cypressBinaryVersion =
    candidateVersion(
      lockPackage(currentLock, "cypress").version,
      cypressMetadata,
    ) ?? lockPackage(currentLock, "cypress").version;
  const binary = {
    version: cypressBinaryVersion,
    locator: cypressBinary.locator,
    realpath: cypressBinary.realpath,
    digest: cypressBinary.evidence.digest,
    evidence: structuredClone(cypressBinary.evidence),
    locator_evidence: structuredClone(cypressBinary.locatorEvidence),
  };
  const selectedCapabilities = capabilities.map((capability) => {
    const externalBrowser = browserEvidence.find(
      ({ capabilityId }) => capabilityId === capability.id,
    );
    if (externalBrowser === undefined) {
      throw new Error(
        `Missing browser evidence for ${capability.id}`,
      );
    }
    return {
      id: capability.id,
      browser: capability.browser,
      os: capability.os,
      runner: capability.runner,
      scenarios: [...capability.scenarios],
      evidence: capability.evidence,
      required_files: [...capability.required_files],
      result_reports: [...capability.result_reports],
      require_accessibility: capability.require_accessibility,
      accessibility_policy: capability.require_accessibility
        ? structuredClone(CYPRESS_ACCESSIBILITY_POLICY)
        : null,
      browser_evidence: {
        path: externalBrowser.path,
        realpath: externalBrowser.realpath,
        version: externalBrowser.version,
        digest: externalBrowser.digest,
        evidence: structuredClone(externalBrowser.evidence),
        locator_evidence: structuredClone(
          externalBrowser.locatorEvidence,
        ),
      },
    };
  });
  const plan = {
    schema_version: 1,
    kind: "cypress-qualification-plan",
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
      ...binary,
    },
    node: structuredClone(node),
    selected_capabilities: selectedCapabilities,
    checks: qualificationChecks({
      capabilities: selectedCapabilities,
      cypressBinary: binary,
      node,
    }),
  };
  return {
    ...plan,
    plan_digest: qualificationPlanDigest(plan),
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
          evidence: [
            candidateBinary.value.evidence,
            candidateBinary.value.locatorEvidence,
          ],
        };
  const candidateCount = [
    cypressCandidate,
    axeCandidate,
    binaryCandidate,
  ].filter((candidate) => candidate !== null).length;
  const nodeRanges = {
    package: current.packageNodeRange,
    cypress:
      cypressNpm.value?.engines.node ??
      current.packageNodeRanges.cypress,
    axeCore:
      axeNpm.value?.engines.node ??
      current.packageNodeRanges["axe-core"],
  };
  if (
    Object.values(nodeRanges).some(
      (range) => !satisfiesRange(node.locked, range),
    )
  ) {
    reasonCodes.push("NODE_RANGE_INCOMPATIBLE");
  }
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
            ...(currentBinary.value?.locatorEvidence === undefined
              ? []
              : [currentBinary.value.locatorEvidence]),
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
              : browserValues.flatMap(({ evidence, locatorEvidence }) => [
                  evidence,
                  locatorEvidence,
                ]),
        },
        ecosystem: "runner",
        id: "cypress-external-browser",
        managedPath: CATALOG_PATH,
      }),
    ],
    relations: [
      relation({
        constraint:
          `${nodeRanges.cypress}; repository Node ${node.locked} ` +
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
      node: {
        configured: node.configured,
        locked: node.locked,
        ranges: nodeRanges,
      },
      observation,
      browserEvidence: browserValues,
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
  if (plan.plan_digest !== qualificationPlanDigest(plan)) {
    throw new Error("Cypress qualification plan digest does not match");
  }
  return structuredClone(plan);
}

function candidateComponent(observation, id) {
  const component = observation.components.find(
    (entry) => entry.id === id,
  );
  if (component === undefined) {
    throw new Error(`Cypress observation is missing ${id}`);
  }
  return component;
}

function npmMetadataFromPlan({
  component,
  currentLock,
  name,
  plannedPackage,
}) {
  const expectedVersion =
    component.candidate?.version ?? component.current.version;
  if (
    plannedPackage.name !== name ||
    plannedPackage.version !== expectedVersion
  ) {
    throw new Error(
      `Cypress qualification package ${name} does not match observation`,
    );
  }
  assertSemverRange(
    plannedPackage.engines?.node,
    `planned ${name} engines.node`,
  );
  if (component.candidate === null) {
    const locked = lockPackage(currentLock, name);
    for (const [key, value] of [
      ["version", locked.version],
      ["resolved", locked.resolved],
      ["integrity", locked.integrity],
    ]) {
      if (plannedPackage[key] !== value) {
        throw new Error(
          `Cypress qualification current ${name}.${key} was mutated`,
        );
      }
    }
    if (
      JSON.stringify(stableValue(plannedPackage.engines)) !==
      JSON.stringify(stableValue(locked.engines))
    ) {
      throw new Error(
        `Cypress qualification current ${name}.engines was mutated`,
      );
    }
    return null;
  }
  const evidence = component.candidate.evidence.find(
    ({ type }) => type === "npm-registry",
  );
  if (evidence === undefined) {
    throw new Error(
      `Cypress observation lacks candidate npm evidence for ${name}`,
    );
  }
  const metadata = {
    name,
    version: plannedPackage.version,
    dist: {
      integrity: plannedPackage.integrity,
      tarball: plannedPackage.resolved,
    },
    engines: stableValue(plannedPackage.engines),
  };
  if (
    evidence.locator !== plannedPackage.resolved ||
    evidence.revision !== `${name}@${plannedPackage.version}` ||
    evidence.digest !== metadataDigest(metadata)
  ) {
    throw new Error(
      `Cypress qualification candidate ${name} metadata was mutated`,
    );
  }
  return {
    ...metadata,
    evidence: structuredClone(evidence),
    warnings: [],
  };
}

function binaryMetadataFromPlan(observation, plan) {
  const component = candidateComponent(
    observation,
    "cypress-package-binary",
  );
  const record = component.candidate ?? component.current;
  const evidence = record.evidence.find(
    ({ type }) => type === "cypress-binary",
  );
  const locatorEvidence = record.evidence.find(
    ({ type }) => type === "cypress-binary-locator",
  );
  if (
    evidence === undefined ||
    locatorEvidence === undefined ||
    plan.cypress_binary.version !== record.version ||
    plan.cypress_binary.locator !== locatorEvidence.locator ||
    plan.cypress_binary.realpath !== evidence.locator ||
    locatorEvidence.revision !== evidence.locator ||
    locatorEvidence.digest !== evidence.digest ||
    plan.cypress_binary.digest !== evidence.digest ||
    JSON.stringify(stableValue(plan.cypress_binary.evidence)) !==
      JSON.stringify(stableValue(evidence)) ||
    JSON.stringify(stableValue(plan.cypress_binary.locator_evidence)) !==
      JSON.stringify(stableValue(locatorEvidence))
  ) {
    throw new Error("Cypress qualification binary metadata was mutated");
  }
  return {
    version: record.version,
    locator: locatorEvidence.locator,
    realpath: evidence.locator,
    digest: evidence.digest,
    evidence: structuredClone(evidence),
    locatorEvidence: structuredClone(locatorEvidence),
    warnings: [],
  };
}

function browserMetadataFromPlan(observation, plan) {
  const component = candidateComponent(
    observation,
    "cypress-external-browser",
  );
  return plan.selected_capabilities.map((capability) => {
    const browser = capability.browser_evidence;
    const evidence = component.current.evidence.find(
      (item) =>
        item.type === "external-browser" &&
        item.revision === `${capability.browser}@${browser.version}` &&
        item.locator === browser.realpath,
    );
    const locatorEvidence = component.current.evidence.find(
      (item) =>
        item.type === "external-browser-locator" &&
        item.locator === browser.path &&
        item.revision === browser.realpath,
    );
    if (
      evidence === undefined ||
      locatorEvidence === undefined ||
      evidence.locator !== browser.realpath ||
      locatorEvidence.revision !== browser.realpath ||
      locatorEvidence.digest !== evidence.digest ||
      evidence.digest !== browser.digest ||
      JSON.stringify(stableValue(browser.evidence)) !==
        JSON.stringify(stableValue(evidence)) ||
      JSON.stringify(stableValue(browser.locator_evidence)) !==
        JSON.stringify(stableValue(locatorEvidence))
    ) {
      throw new Error(
        `Cypress qualification browser metadata for ` +
          `${capability.id} was mutated`,
      );
    }
    return {
      browser: capability.browser,
      runner: capability.runner,
      os: capability.os,
      version: browser.version,
      path: browser.path,
      realpath: browser.realpath,
      digest: browser.digest,
      warnings: [],
      evidence: structuredClone(evidence),
      locatorEvidence: structuredClone(locatorEvidence),
      capabilityId: capability.id,
    };
  });
}

async function validateQualificationPrescription(
  collection,
  repositoryRoot,
) {
  const plan = createCypressQualificationPlan(collection);
  const observation = collection.observation;
  const [catalog, catalogBinding, packageJson, currentLock, nodeConfig, nodeLock] =
    await Promise.all([
      readJson(repositoryPath(repositoryRoot, CATALOG_PATH)),
      readCapabilityCatalog(repositoryPath(repositoryRoot, CATALOG_PATH)),
      readJson(repositoryPath(repositoryRoot, PACKAGE_PATH)),
      readJson(repositoryPath(repositoryRoot, LOCK_PATH)),
      readFile(repositoryPath(repositoryRoot, NODE_CONFIG_PATH), "utf8"),
      readFile(repositoryPath(repositoryRoot, NODE_LOCK_PATH), "utf8"),
    ]);
  validateDocument(observation, {
    capabilityIds: catalogBinding.ids,
    capabilityCatalogDigest: catalogBinding.digest,
  });
  const current = validatePackageFiles(packageJson, currentLock);
  const nodeFiles = parseNodeFiles(nodeConfig, nodeLock);
  const packageByName = new Map(
    plan.packages.map((entry) => [entry.name, entry]),
  );
  if (
    packageByName.size !== 2 ||
    !packageByName.has("cypress") ||
    !packageByName.has("axe-core")
  ) {
    throw new Error("Cypress qualification package set was mutated");
  }
  const cypressMetadata = npmMetadataFromPlan({
    component: candidateComponent(observation, "cypress-package"),
    currentLock,
    name: "cypress",
    plannedPackage: packageByName.get("cypress"),
  });
  const axeMetadata = npmMetadataFromPlan({
    component: candidateComponent(observation, "cypress-axe-core"),
    currentLock,
    name: "axe-core",
    plannedPackage: packageByName.get("axe-core"),
  });
  const cypressBinary = binaryMetadataFromPlan(observation, plan);
  const browserEvidence = browserMetadataFromPlan(observation, plan);
  const node = {
    configured: nodeFiles.configured,
    locked: nodeFiles.locked,
    ranges: {
      package: current.packageNodeRange,
      cypress:
        cypressMetadata?.engines.node ??
        current.packageNodeRanges.cypress,
      axeCore:
        axeMetadata?.engines.node ??
        current.packageNodeRanges["axe-core"],
    },
  };
  const expected = qualificationPlan({
    axeMetadata,
    browserEvidence,
    capabilities: selectCapabilities(catalog),
    cypressBinary,
    cypressMetadata,
    currentLock,
    node,
    observation,
  });
  if (
    JSON.stringify(stableValue(plan)) !==
    JSON.stringify(stableValue(expected))
  ) {
    throw new Error(
      "Cypress qualification plan differs from the prescribed plan",
    );
  }
  return plan;
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

async function treeEntries(root, directory = root) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const repositoryRelative = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      entries.push([repositoryRelative, "directory"]);
      entries.push(...(await treeEntries(root, path)));
    } else if (entry.isFile()) {
      entries.push([
        repositoryRelative,
        hash(await readFile(path)),
      ]);
    } else if (entry.isSymbolicLink()) {
      entries.push([
        repositoryRelative,
        `symlink:${await readlink(path)}`,
      ]);
    } else {
      entries.push([repositoryRelative, "unsupported"]);
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

function effectiveCheckEnvironment(
  environment,
  workspaceRoot,
  checkEnvironment,
) {
  const packageRoot = repositoryPath(workspaceRoot, PACKAGE_DIRECTORY);
  const effective = {
    ...environment,
    GITHUB_WORKSPACE: workspaceRoot,
    CYPRESS_CACHE_FOLDER: join(packageRoot, ".cypress-cache"),
    npm_config_cache: join(packageRoot, ".npm-cache"),
    ...checkEnvironment,
  };
  if (effective.CHROME_BIN !== undefined) {
    effective.PATH =
      `${dirname(effective.CHROME_BIN)}${delimiter}${effective.PATH ?? ""}`;
  }
  return effective;
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
    if (cypress.engines?.node !== plan.node.ranges.cypress) {
      throw new Error(
        "Ephemeral Cypress Node range does not match npm evidence",
      );
    }
    if (cypress.bin?.cypress !== "bin/cypress") {
      throw new Error("Ephemeral Cypress package binary is missing");
    }
  });
}

async function verifyBinaryInstallProvenance(
  check,
  workspaceRoot,
  checkResults,
) {
  const install = checkResults.find(
    ({ id }) => id === "cypress-candidate-install",
  );
  if (
    install?.status !== "pass" ||
    install.environment?.CYPRESS_INSTALL_BINARY !==
      check.expected_archive_realpath
  ) {
    throw new Error(
      "Cypress install did not use the reviewed binary archive",
    );
  }
  const archiveRealpath = await realpath(
    check.expected_archive_locator,
  );
  const archiveDigest = hash(await readFile(archiveRealpath));
  if (
    archiveRealpath !== check.expected_archive_realpath ||
    archiveDigest !== check.expected_archive_digest
  ) {
    throw new Error(
      "Installed Cypress binary archive provenance does not match review",
    );
  }
  const packageRoot = repositoryPath(workspaceRoot, PACKAGE_DIRECTORY);
  const cachePath = join(packageRoot, ".cypress-cache");
  const cacheLink = await lstat(cachePath);
  if (cacheLink.isSymbolicLink()) {
    throw new Error("Cypress binary cache must not be a symbolic link");
  }
  const [resolvedPackage, resolvedCache] = await Promise.all([
    realpath(packageRoot),
    realpath(cachePath),
  ]);
  if (!isWithin(resolvedPackage, resolvedCache)) {
    throw new Error("Cypress binary cache escaped the package workspace");
  }
  const cacheEntries = (await treeEntries(resolvedCache)).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (
    !cacheEntries.some(
      ([path, value]) =>
        path.startsWith(`${check.expected_binary_version}/`) &&
        value.startsWith("sha256:"),
    )
  ) {
    throw new Error(
      "Cypress install produced no observed binary cache files",
    );
  }
  return {
    archive_digest: archiveDigest,
    archive_locator: check.expected_archive_locator,
    archive_realpath: archiveRealpath,
    binary_version: check.expected_binary_version,
    cache_digest: metadataDigest(cacheEntries),
  };
}

function assertPackageArtifactPath(path, name, { allowGlob = false } = {}) {
  assertNonemptyString(path, name);
  const normalized = path.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    !normalized.startsWith(`${PACKAGE_DIRECTORY}/`) ||
    (!allowGlob && /[*?[\]{}]/u.test(normalized))
  ) {
    throw new Error(`${name} must stay inside ${PACKAGE_DIRECTORY}`);
  }
  return normalized;
}

async function readNonemptyWorkspaceFile(
  workspaceRoot,
  path,
  name = path,
) {
  const normalized = assertPackageArtifactPath(path, name);
  const absolute = repositoryPath(workspaceRoot, normalized);
  if (!isWithin(workspaceRoot, absolute)) {
    throw new Error(`${name} escapes the ephemeral workspace`);
  }
  const linkMetadata = await lstat(absolute);
  if (linkMetadata.isSymbolicLink()) {
    throw new Error(`${name} must not be a symbolic link`);
  }
  const [resolvedWorkspace, resolvedPackage, resolvedFile] =
    await Promise.all([
      realpath(workspaceRoot),
      realpath(repositoryPath(workspaceRoot, PACKAGE_DIRECTORY)),
      realpath(absolute),
    ]);
  if (
    !isWithin(resolvedWorkspace, resolvedFile) ||
    !isWithin(resolvedPackage, resolvedFile) ||
    resolvedFile !== resolve(absolute)
  ) {
    throw new Error(`${name} escapes the ephemeral package workspace`);
  }
  const metadata = await stat(resolvedFile);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${name} must be a nonempty file`);
  }
  return readFile(resolvedFile);
}

async function readWorkspaceJson(workspaceRoot, path, name = path) {
  const contents = await readNonemptyWorkspaceFile(
    workspaceRoot,
    path,
    name,
  );
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`);
  }
}

function nestedArtifactPaths(value, paths = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        paths.push(entry);
      } else {
        nestedArtifactPaths(entry, paths);
      }
    }
    return paths;
  }
  if (value === null || typeof value !== "object") {
    return paths;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (["contentType", "name"].includes(key)) {
      continue;
    }
    if (typeof entry === "string") {
      paths.push(entry);
    } else {
      nestedArtifactPaths(entry, paths);
    }
  }
  return paths;
}

const ACCESSIBILITY_CATEGORIES = [
  "incomplete",
  "inapplicable",
  "passes",
  "violations",
];

function emptyAccessibilityCounts() {
  return Object.fromEntries(
    ACCESSIBILITY_CATEGORIES.map((category) => [
      category,
      { nodes: 0, rules: 0 },
    ]),
  );
}

function findingCounts(findings, name) {
  if (!Array.isArray(findings)) {
    throw new Error(`${name} must be an array`);
  }
  let nodes = 0;
  for (const [index, finding] of findings.entries()) {
    if (
      finding === null ||
      typeof finding !== "object" ||
      !Array.isArray(finding.nodes)
    ) {
      throw new Error(`${name}[${index}].nodes must be an array`);
    }
    nodes += finding.nodes.length;
  }
  return { nodes, rules: findings.length };
}

function assertAccessibilityCounts(actual, expected, name) {
  if (
    actual === null ||
    typeof actual !== "object" ||
    ACCESSIBILITY_CATEGORIES.some(
      (category) =>
        !Number.isSafeInteger(actual[category]?.nodes) ||
        actual[category].nodes < 0 ||
        !Number.isSafeInteger(actual[category]?.rules) ||
        actual[category].rules < 0 ||
        actual[category].nodes !== expected[category].nodes ||
        actual[category].rules !== expected[category].rules,
    )
  ) {
    throw new Error(`${name} does not match raw axe findings`);
  }
}

async function validateAccessibilityArtifact({
  axeVersion,
  expectedPolicy,
  path,
  reportAccessibility,
  scenario,
  workspaceRoot,
}) {
  const accessibility = await readWorkspaceJson(
    workspaceRoot,
    path,
    `${scenario} accessibility JSON`,
  );
  if (
    accessibility.schemaVersion !== 1 ||
    accessibility.tool !== "cypress" ||
    accessibility.scenario !== scenario ||
    accessibility.axeCoreVersion !== axeVersion ||
    !Array.isArray(accessibility.audits) ||
    accessibility.audits.length === 0 ||
    accessibility.policy === null ||
    typeof accessibility.policy !== "object" ||
    JSON.stringify(stableValue(accessibility.policy)) !==
      JSON.stringify(stableValue(expectedPolicy)) ||
    JSON.stringify(stableValue(reportAccessibility?.policy)) !==
      JSON.stringify(stableValue(expectedPolicy))
  ) {
    throw new Error(
      `${scenario} accessibility JSON does not match the candidate run`,
    );
  }
  const aggregate = emptyAccessibilityCounts();
  const states = [];
  for (const [index, audit] of accessibility.audits.entries()) {
    assertNonemptyString(
      audit?.state,
      `${scenario} accessibility audit ${index} state`,
    );
    states.push(audit.state);
    const expected = emptyAccessibilityCounts();
    for (const category of ACCESSIBILITY_CATEGORIES) {
      expected[category] = findingCounts(
        audit.result?.[category],
        `${scenario} accessibility audit ${index} ${category}`,
      );
      aggregate[category].nodes += expected[category].nodes;
      aggregate[category].rules += expected[category].rules;
    }
    assertAccessibilityCounts(
      audit.counts,
      expected,
      `${scenario} accessibility audit ${index} counts`,
    );
  }
  assertAccessibilityCounts(
    reportAccessibility?.counts,
    aggregate,
    `${scenario} run accessibility counts`,
  );
  if (
    JSON.stringify(reportAccessibility?.audits) !==
      JSON.stringify(states) ||
    !Number.isSafeInteger(accessibility.policy.blockingViolationCount) ||
    accessibility.policy.blockingViolationCount < 1
  ) {
    throw new Error(
      `${scenario} run accessibility summary does not match raw audits`,
    );
  }
  const blocking =
    aggregate.violations.rules >=
    accessibility.policy.blockingViolationCount;
  if (
    reportAccessibility.status !== (blocking ? "failed" : "passed") ||
    reportAccessibility.blocking !== blocking
  ) {
    throw new Error(
      `${scenario} run accessibility policy result is inconsistent`,
    );
  }
  return { aggregate, blocking, states };
}

async function validateRequiredArtifacts(capability, workspaceRoot) {
  const matched = new Set();
  for (const rawPattern of capability.required_files) {
    const pattern = assertPackageArtifactPath(
      rawPattern,
      "required artifact pattern",
      { allowGlob: true },
    );
    const paths = [];
    for await (const path of glob(pattern, {
      cwd: workspaceRoot,
      exclude: ["**/node_modules/**"],
    })) {
      paths.push(path.replaceAll("\\", "/"));
    }
    if (paths.length === 0) {
      throw new Error(`Required artifact pattern matched nothing: ${pattern}`);
    }
    for (const path of paths) {
      await readNonemptyWorkspaceFile(workspaceRoot, path);
      matched.add(path);
    }
  }
  return matched;
}

async function verifyArtifactSemantics(plan, check, workspaceRoot) {
  const capability = plan.selected_capabilities.find(
    ({ id }) => id === check.capability_id,
  );
  if (capability === undefined) {
    throw new Error(
      `Artifact check references unknown capability ${check.capability_id}`,
    );
  }
  if (!capability.scenarios.includes("smoke")) {
    throw new Error(`${capability.id} did not select Cypress smoke`);
  }
  const packageVersions = Object.fromEntries(
    plan.packages.map(({ name, version }) => [name, version]),
  );
  const requiredArtifacts = await validateRequiredArtifacts(
    capability,
    workspaceRoot,
  );
  const validatorCheck = plan.checks.find(
    ({ id }) => id === `${capability.id}-artifact-contracts`,
  );
  if (
    validatorCheck?.environment?.E2E_EVIDENCE_FILE !==
    capability.evidence
  ) {
    throw new Error(
      "Artifact semantics must consume the prescribed E2E_EVIDENCE_FILE",
    );
  }
  const evidencePath = assertPackageArtifactPath(
    validatorCheck.environment.E2E_EVIDENCE_FILE,
    "E2E_EVIDENCE_FILE",
  );
  await readNonemptyWorkspaceFile(
    workspaceRoot,
    evidencePath,
    "E2E_EVIDENCE_FILE",
  );
  if (!requiredArtifacts.has(evidencePath)) {
    throw new Error("E2E_EVIDENCE_FILE is not covered by required artifacts");
  }
  if (capability.result_reports.length !== capability.scenarios.length) {
    throw new Error(
      `${capability.id} must have one result report per scenario`,
    );
  }
  const observedScenarios = new Set();
  const allArtifacts = new Set();
  const reportDigests = [];
  for (const reportPath of capability.result_reports) {
    if (!requiredArtifacts.has(reportPath)) {
      throw new Error(`Required artifacts omit result report ${reportPath}`);
    }
    const report = await readWorkspaceJson(
      workspaceRoot,
      reportPath,
      "Cypress result report",
    );
    if (
      report.schemaVersion !== 1 ||
      report.capabilityId !== capability.id ||
      !capability.scenarios.includes(report.scenario) ||
      observedScenarios.has(report.scenario) ||
      report.status !== "passed" ||
      report.assertion?.status !== "passed"
    ) {
      throw new Error(
        `${reportPath} does not describe a unique passing selected scenario`,
      );
    }
    observedScenarios.add(report.scenario);
    if (
      report.tool?.name !== "cypress" ||
      report.tool?.version !== packageVersions.cypress ||
      report.versions?.axeCore !== packageVersions["axe-core"] ||
      normalizedNodeVersion(
        report.versions?.node,
        `${reportPath} Node version`,
      ) !== plan.node.locked
    ) {
      throw new Error(
        `${reportPath} dependency identity does not match the candidate`,
      );
    }
    if (
      report.browser?.requested !== capability.browser ||
      report.browser?.name !== capability.browser ||
      report.browser?.selectionSource !== "--browser" ||
      report.browser?.version !== capability.browser_evidence.version ||
      report.operatingSystem?.requested !== capability.os
    ) {
      throw new Error(
        `${reportPath} browser identity does not match reviewed evidence`,
      );
    }
    if (
      capability.require_accessibility &&
      (report.accessibility?.status !== "passed" ||
        report.accessibility?.blocking !== false ||
        !Array.isArray(report.accessibility?.audits) ||
        report.accessibility.audits.length === 0)
    ) {
      throw new Error(
        `${reportPath} lacks passing accessibility evidence`,
      );
    }
    const artifactPaths = nestedArtifactPaths(report.artifacts);
    for (const artifactPath of artifactPaths) {
      await readNonemptyWorkspaceFile(
        workspaceRoot,
        artifactPath,
        `${reportPath} artifact`,
      );
      allArtifacts.add(artifactPath);
    }
    if (capability.require_accessibility) {
      await validateAccessibilityArtifact({
        axeVersion: packageVersions["axe-core"],
        expectedPolicy: capability.accessibility_policy,
        path: report.artifacts?.accessibilityJson,
        reportAccessibility: report.accessibility,
        scenario: report.scenario,
        workspaceRoot,
      });
      await readNonemptyWorkspaceFile(
        workspaceRoot,
        report.artifacts?.accessibilityMarkdown,
        `${report.scenario} accessibility Markdown`,
      );
    }
    if (
      !Array.isArray(report.artifacts?.screenshots) ||
      report.artifacts.screenshots.length === 0 ||
      !Array.isArray(report.artifacts?.videos) ||
      report.artifacts.videos.length === 0
    ) {
      throw new Error(
        `${reportPath} lacks required screenshot or video evidence`,
      );
    }
    reportDigests.push({
      path: reportPath,
      digest: hash(await readFile(repositoryPath(workspaceRoot, reportPath))),
    });
  }
  if (
    JSON.stringify([...observedScenarios].sort()) !==
    JSON.stringify([...capability.scenarios].sort())
  ) {
    throw new Error(`${capability.id} did not cover every selected scenario`);
  }
  if (!allArtifacts.has(evidencePath)) {
    throw new Error(
      "E2E_EVIDENCE_FILE is not referenced by a result report",
    );
  }
  const summary = await readWorkspaceJson(
    workspaceRoot,
    `${PACKAGE_DIRECTORY}/diagnostics/summary.json`,
    "Cypress summary",
  );
  if (
    summary.schemaVersion !== 1 ||
    summary.status !== "passed" ||
    summary.capabilityId !== capability.id ||
    !Array.isArray(summary.scenarios) ||
    JSON.stringify(
      summary.scenarios.map(({ scenario }) => scenario).sort(),
    ) !== JSON.stringify([...capability.scenarios].sort())
  ) {
    throw new Error("Cypress summary does not cover the selected scenarios");
  }
  return JSON.stringify({
    browser: capability.browser_evidence,
    evidence: {
      path: evidencePath,
      digest: hash(
        await readFile(repositoryPath(workspaceRoot, evidencePath)),
      ),
    },
    reports: reportDigests.sort((left, right) =>
      left.path.localeCompare(right.path)),
    scenarios: [...observedScenarios].sort(),
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

export function detectCypressWarnings(output) {
  const completeOutput = output.trim();
  if (completeOutput.length > 0) {
    try {
      return sortedUnique(structuredWarnings(JSON.parse(completeOutput)));
    } catch {
      // Mixed or unstructured command output is processed line by line.
    }
  }
  const warnings = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      warnings.push(...structuredWarnings(JSON.parse(line)));
      continue;
    } catch {
      // Continue with text detection for non-JSON command output.
    }
    if (
      /\bwarn(?:ing)?s?\b/iu.test(line) ||
      /\b(?:deprecation|experimental)warnings?\b/iu.test(line) ||
      /^::warning(?:\s|::)/iu.test(line)
    ) {
      warnings.push(line);
    }
  }
  return sortedUnique(warnings);
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
    return JSON.stringify(stableValue(value));
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
  if (
    typeof level === "string" &&
    /^(?:(?:deprecation|experimental)?warnings?)$/iu.test(level.trim())
  ) {
    warnings.push(warningDescription(value));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/^warnings?count$/iu.test(key)) {
      const numericCount =
        typeof entry === "number" && Number.isSafeInteger(entry)
          ? BigInt(entry)
          : typeof entry === "string" && /^\d+$/u.test(entry)
            ? BigInt(entry)
            : null;
      if (numericCount === null || numericCount < 0n) {
        warnings.push(`${key}: invalid`);
      } else if (numericCount > 0n) {
        warnings.push(`${key}: ${entry}`);
      }
      continue;
    }
    if (
      /^(?:(?:deprecation|experimental)?warnings?)$/iu.test(key)
    ) {
      warnings.push(
        ...structuredWarnings(entry, { warningContext: true }),
      );
    } else if (
      ["annotations", "diagnostics", "messages"].includes(
        key.toLowerCase(),
      )
    ) {
      warnings.push(...structuredWarnings(entry));
    }
  }
  return warnings.filter(Boolean);
}

function checkBinding(check, {
  digest,
  locator,
  realpath: resolvedPath,
  version,
}) {
  if (check.kind === "file-evidence") {
    return {
      digest,
      locator,
      realpath: resolvedPath,
      version: check.expected_version,
    };
  }
  if (check.kind === "browser-evidence") {
    return {
      digest,
      locator,
      realpath: resolvedPath,
      version,
    };
  }
  if (check.kind === "binary-evidence") {
    return {
      version,
    };
  }
  if (check.kind === "node-evidence") {
    return {
      version,
    };
  }
  return undefined;
}

function expectedCheckBinding(check) {
  if (check.kind === "file-evidence") {
    return {
      digest: check.expected_digest,
      locator: check.path,
      realpath: check.expected_realpath,
      version: check.expected_version,
    };
  }
  if (check.kind === "browser-evidence") {
    return {
      digest: check.expected_digest,
      locator: check.expected_alias,
      realpath: check.expected_realpath,
      version: check.expected_version,
    };
  }
  if (check.kind === "binary-evidence") {
    return {
      version: check.expected_binary_version,
    };
  }
  if (check.kind === "node-evidence") {
    return {
      version: check.expected_version,
    };
  }
  return undefined;
}

async function runCommandCheck(check, {
  environment,
  revision,
  workspaceRoot,
}) {
  const startedAt = new Date().toISOString();
  if (check.kind === "file-evidence") {
    let actualDigest = null;
    let actualRealpath = null;
    try {
      actualRealpath = await realpath(check.path);
      actualDigest = hash(await readFile(actualRealpath));
    } catch {
      // The failed binding below is recorded as qualification evidence.
    }
    const completedAt = new Date().toISOString();
    const binding = checkBinding(check, {
      digest: actualDigest,
      locator: check.path,
      realpath: actualRealpath,
    });
    return {
      status:
        actualRealpath === check.expected_realpath &&
        actualDigest === check.expected_digest
          ? "pass"
          : "fail",
      warnings: [],
      binding,
      evidence: [
        commandEvidence(
          check,
          revision,
          JSON.stringify(binding),
          startedAt,
          completedAt,
        ),
      ],
    };
  }
  try {
    const executableRealpath =
      check.kind === "browser-evidence"
        ? await realpath(check.expected_alias)
        : null;
    const executableDigest =
      check.kind === "browser-evidence"
        ? hash(await readFile(executableRealpath))
        : null;
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
    const outputVersion =
      check.kind === "node-evidence"
        ? normalizedNodeVersion(output.trim(), "executed Node version")
        : check.kind === "browser-evidence"
          ? check.expected_version
          : check.kind === "binary-evidence"
            ? check.expected_binary_version
            : undefined;
    const browserVersionMissing =
      check.kind === "browser-evidence" &&
      !output.includes(check.expected_version);
    const nodeVersionMismatch =
      check.kind === "node-evidence" &&
      outputVersion !== check.expected_version;
    const binding = checkBinding(check, {
      digest: executableDigest,
      locator:
        check.kind === "browser-evidence"
          ? check.expected_alias
          : check.expected_source_locator,
      realpath: executableRealpath,
      version: outputVersion,
    });
    return {
      status:
        binaryVersionMissing ||
        browserVersionMissing ||
        nodeVersionMismatch ||
        (check.kind === "browser-evidence" &&
          (executableRealpath !== check.expected_realpath ||
            check.command !== check.expected_realpath ||
            executableDigest !== check.expected_digest))
          ? "fail"
          : "pass",
      warnings: detectCypressWarnings(output),
      binding,
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
      warnings: detectCypressWarnings(output),
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
  const expectedBinding = expectedCheckBinding(check);
  const bindingMatches =
    expectedBinding === undefined ||
    JSON.stringify(stableValue(raw.binding)) ===
      JSON.stringify(stableValue(expectedBinding));
  return {
    ...check,
    status: bindingMatches ? status : "fail",
    warnings,
    ...(expectedBinding === undefined
      ? {}
      : { binding: structuredClone(raw.binding) }),
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
    inspectSourceCheckout = inspectGitCheckout,
    materializeWorkspace = copyRepository,
    repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  } = {},
) {
  const observation = collection?.observation;
  if (
    observation?.disposition?.state !== "candidate" ||
    collection?.qualification_plan === null
  ) {
    throw new Error("Cypress qualification requires an available candidate");
  }
  const root = resolve(repositoryRoot);
  await assertSourceCheckout(
    root,
    observation.repository,
    inspectSourceCheckout,
  );
  const plan = await validateQualificationPrescription(
    collection,
    root,
  );
  const initialSource = metadataDigest(await treeEntries(root));
  const temporaryRoot = resolve(await createWorkspace());
  if (isWithin(root, temporaryRoot) || isWithin(temporaryRoot, root)) {
    throw new Error("Ephemeral workspace must be outside the repository");
  }
  const workspaceRoot = join(temporaryRoot, "repository");
  let result;
  let workError;
  try {
    await assertSourceCheckout(
      root,
      observation.repository,
      inspectSourceCheckout,
    );
    await materializeWorkspace(root, workspaceRoot);
    const outsideBefore = await outsideBoundaryDigest(
      workspaceRoot,
      plan.workspace.mutation_boundary,
    );
    await applyCandidatePackages(plan, workspaceRoot);
    const checkResults = [];
    for (const check of plan.checks) {
      let raw;
      if (check.id === "cypress-candidate-install") {
        await rm(
          join(
            repositoryPath(workspaceRoot, PACKAGE_DIRECTORY),
            ".cypress-cache",
          ),
          { force: true, recursive: true },
        );
      }
      if (
        check.kind === "file-evidence" ||
        check.kind === "browser-evidence"
      ) {
        raw = await runCommandCheck(check, {
          environment: effectiveCheckEnvironment(
            environment,
            workspaceRoot,
            check.environment,
          ),
          revision: observation.repository.revision,
          workspaceRoot,
        });
      } else if (check.kind === "lock-evidence") {
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
      } else if (check.kind === "binary-provenance") {
        const startedAt = new Date().toISOString();
        try {
          const provenance = await verifyBinaryInstallProvenance(
            check,
            workspaceRoot,
            checkResults,
          );
          const completedAt = new Date().toISOString();
          raw = {
            status: "pass",
            warnings: [],
            evidence: [
              commandEvidence(
                check,
                observation.repository.revision,
                JSON.stringify(provenance),
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
      } else if (check.kind === "artifact-semantics") {
        const startedAt = new Date().toISOString();
        try {
          const output = await verifyArtifactSemantics(
            plan,
            check,
            workspaceRoot,
          );
          const completedAt = new Date().toISOString();
          raw = {
            status: "pass",
            warnings: [],
            evidence: [
              commandEvidence(
                check,
                observation.repository.revision,
                output,
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
          environment: effectiveCheckEnvironment(
            environment,
            workspaceRoot,
            check.environment,
          ),
          revision: observation.repository.revision,
          workspaceRoot,
        });
      } else {
        const effectiveEnvironment = effectiveCheckEnvironment(
          environment,
          workspaceRoot,
          check.environment,
        );
        raw = await executeCheck(structuredClone(check), {
          environment: effectiveEnvironment,
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
  const finalSource = metadataDigest(await treeEntries(root));
  if (initialSource !== finalSource) {
    throw new Error("Cypress qualification mutated the source repository");
  }
  await assertSourceCheckout(
    root,
    observation.repository,
    inspectSourceCheckout,
  );
  if (workError !== undefined) {
    throw workError;
  }
  return result;
}
