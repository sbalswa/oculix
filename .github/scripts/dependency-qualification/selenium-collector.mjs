import { execFile } from "node:child_process";
import {
  createHash,
  createPublicKey,
  sign as createSignature,
  verify as verifySignature,
} from "node:crypto";
import {
  cp,
  glob,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
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

import { validateCatalog } from "../plan-e2e.mjs";
import {
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

const execFileAsync = promisify(execFile);

export const SELENIUM_PROVIDER_ID = "selenium";
export const SELENIUM_PACKAGE_DIRECTORY = "tests/e2e/selenium";
export const SELENIUM_MANAGED_PATHS = Object.freeze([
  `${SELENIUM_PACKAGE_DIRECTORY}/package.json`,
  `${SELENIUM_PACKAGE_DIRECTORY}/package-lock.json`,
]);

const PACKAGE_PATH = SELENIUM_MANAGED_PATHS[0];
const LOCK_PATH = SELENIUM_MANAGED_PATHS[1];
const CATALOG_PATH = "tests/e2e/capabilities.json";
const BROWSER_POLICY_PATH = `${SELENIUM_PACKAGE_DIRECTORY}/configuration.mjs`;
const DRIVER_POLICY_PATH = `${SELENIUM_PACKAGE_DIRECTORY}/setup.mjs`;
const SELENIUM_SETUP_PATH = `${SELENIUM_PACKAGE_DIRECTORY}/setup.mjs`;
const SELENIUM_SMOKE_PATH = `${SELENIUM_PACKAGE_DIRECTORY}/smoke.mjs`;
const SELENIUM_WEB_CALCULATOR_PATH =
  `${SELENIUM_PACKAGE_DIRECTORY}/web-calculator.mjs`;
const SELENIUM_PACKAGE_TEST_PATHS = Object.freeze([
  `${SELENIUM_PACKAGE_DIRECTORY}/browser-selection.test.mjs`,
  `${SELENIUM_PACKAGE_DIRECTORY}/harness.test.mjs`,
  `${SELENIUM_PACKAGE_DIRECTORY}/reporting.test.mjs`,
]);
const WEB_CALCULATOR_LIFECYCLE_PATH =
  "tests/e2e/fixtures/web-calculator/lifecycle.mjs";
const REPORT_VALIDATOR_PATH =
  ".github/scripts/validate-e2e-reports.mjs";
const TRUSTED_EXECUTION_PATHS = Object.freeze([
  REPORT_VALIDATOR_PATH,
  SELENIUM_SETUP_PATH,
  SELENIUM_SMOKE_PATH,
  SELENIUM_WEB_CALCULATOR_PATH,
  ...SELENIUM_PACKAGE_TEST_PATHS,
  WEB_CALCULATOR_LIFECYCLE_PATH,
]);
const AXE_PACKAGE = "@axe-core/webdriverjs";
const AXE_CORE_PACKAGE = "axe-core";
const SELENIUM_PACKAGE = "selenium-webdriver";
const DIRECT_PACKAGE_NAMES = Object.freeze([
  AXE_PACKAGE,
  SELENIUM_PACKAGE,
]);
const PACKAGE_NAMES = Object.freeze([
  AXE_PACKAGE,
  AXE_CORE_PACKAGE,
  SELENIUM_PACKAGE,
]);
const AXE_COMPONENT = "selenium-axe-webdriverjs";
const SELENIUM_COMPONENT = "selenium-webdriver";
const BROWSER_COMPONENT = "selenium-runner-browser";
const DRIVER_COMPONENT = "selenium-runner-driver";
const NODE_COMPONENT = "node-runtime";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SRI_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const BROWSER_VERSION_PATTERN =
  /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2,3}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/u;
const EXECUTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_REQUEST_LIFETIME_MS = 15 * 60 * 1000;
const SELENIUM_MUTABLE_PATHS = Object.freeze([
  ...SELENIUM_MANAGED_PATHS,
  `${SELENIUM_PACKAGE_DIRECTORY}/.npm-cache`,
  `${SELENIUM_PACKAGE_DIRECTORY}/.runtime`,
  `${SELENIUM_PACKAGE_DIRECTORY}/diagnostics`,
  `${SELENIUM_PACKAGE_DIRECTORY}/node_modules`,
]);
const SOURCE_MANIFEST_KIND =
  "repository-source-materialization-manifest";
const MUTABLE_SEED_MANIFEST_KIND =
  "repository-mutable-seed-manifest";
const TRUSTED_INPUT_MANIFEST_KIND =
  "repository-trusted-input-manifest";
const GENERATED_LOCK_CLOSURE_KIND =
  "selenium-generated-npm-lock-closure";
const LOCK_CLOSURE_MANIFEST_KIND =
  "npm-package-lock-closure-manifest";
const EXECUTOR_CANDIDATE_CODE = "untrusted";
const EXECUTOR_NETWORK =
  "pinned-candidate-registry-plus-loopback-only";
const SAFE_ENVIRONMENT_OVERRIDES = new Set([
  "NPM_CONFIG_STRICT_SSL",
]);
const executableDigestCache = new Map();

class MetadataError extends Error {
  constructor(reasonCode, message, state = "unavailable") {
    super(message);
    this.reasonCode = reasonCode;
    this.state = state;
  }
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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
      .sort(compareText)
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function unorderedCanonicalValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(unorderedCanonicalValue)
      .sort((left, right) =>
        compareText(JSON.stringify(left), JSON.stringify(right)));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, unorderedCanonicalValue(value[key])]),
  );
}

function hash(value) {
  const content = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? value
      : stableJson(value);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function timestampMilliseconds(value, name) {
  const canonical = timestamp(value);
  if (canonical !== value) {
    throw new Error(`${name} must be a canonical ISO-8601 timestamp`);
  }
  return Date.parse(canonical);
}

function assertObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function assertString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertIntegrity(value, name) {
  assertString(value, name);
  if (!SRI_PATTERN.test(value)) {
    throw new Error(`${name} must be one npm SRI value`);
  }
  return value;
}

function assertHttpsUrl(value, name) {
  assertString(value, name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTPS URL without credentials or hash`);
  }
  return value;
}

function validateSemverIdentifiers(value, name, { prerelease = false } = {}) {
  if (value === undefined) {
    return;
  }
  for (const identifier of value.split(".")) {
    if (
      identifier.length === 0 ||
      !/^[0-9A-Za-z-]+$/u.test(identifier) ||
      (prerelease &&
        /^\d+$/u.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"))
    ) {
      throw new Error(`${name} contains an invalid semantic version identifier`);
    }
  }
}

export function parseExactSemver(value, name = "version") {
  assertString(value, name);
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${name} must be an exact semantic version`);
  }
  validateSemverIdentifiers(match[4], name, { prerelease: true });
  validateSemverIdentifiers(match[5], name);
  const numeric = match.slice(1, 4).map(Number);
  if (numeric.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`${name} contains an unsafe semantic version number`);
  }
  return {
    value,
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) {
      return -1;
    }
    if (right[index] === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/u.test(left[index]);
    const rightNumeric = /^\d+$/u.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(left[index]);
      const rightValue = BigInt(right[index]);
      if (leftValue !== rightValue) {
        return leftValue < rightValue ? -1 : 1;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const difference = compareText(left[index], right[index]);
      if (difference !== 0) {
        return difference;
      }
    }
  }
  return 0;
}

function compareSemver(left, right) {
  const leftVersion = parseExactSemver(left, left);
  const rightVersion = parseExactSemver(right, right);
  for (const key of ["major", "minor", "patch"]) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return comparePrerelease(
    leftVersion.prerelease,
    rightVersion.prerelease,
  );
}

function normalizeRangeToken(token, name) {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token);
  const operator = match[1] ?? "";
  const rawVersion = match[2];
  if (/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u.test(rawVersion)) {
    if (operator !== ">=") {
      throw new Error(
        `${name} uses an unsupported partial semantic version`,
      );
    }
    const parts = rawVersion.split(".");
    while (parts.length < 3) {
      parts.push("0");
    }
    const version = parts.join(".");
    parseExactSemver(version, name);
    return `${operator}${version}`;
  }
  const version = parseExactSemver(rawVersion, name).value;
  return `${operator}${version}`;
}

function normalizeRangeClauses(value, name) {
  assertString(value, name);
  const clauses = value.split("||").map((clause) => clause.trim());
  if (clauses.some((clause) => clause.length === 0)) {
    throw new Error(`${name} contains an empty range clause`);
  }
  return clauses.map((clause) => {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(clause);
    if (hyphen !== null) {
      throw new Error(`${name} uses an unsupported hyphen range`);
    }
    const compact = clause.replace(
      /(>=|<=|>|<|=|\^|~)\s+(?=[0-9])/gu,
      "$1",
    );
    const tokens = compact.split(/\s+/u).filter(Boolean);
    if (tokens.length === 0 || tokens.includes("-")) {
      throw new Error(`${name} contains an invalid range clause`);
    }
    return tokens.map((token) => normalizeRangeToken(token, name)).join(" ");
  });
}

export function normalizeSemverRange(value, name = "range") {
  return normalizeRangeClauses(value, name).join(" || ");
}

function intersectSemverRanges(...ranges) {
  let clauses = [""];
  for (const [index, range] of ranges.entries()) {
    const next = normalizeRangeClauses(range, `range[${index}]`);
    clauses = clauses.flatMap((left) =>
      next.map((right) => [left, right].filter(Boolean).join(" ")));
  }
  return sortedUnique(clauses).join(" || ");
}

function comparatorMatches(version, operator, expected) {
  parseExactSemver(version, version);
  parseExactSemver(expected, expected);
  const comparison = compareSemver(version, expected);
  switch (operator) {
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "":
    case "=":
      return comparison === 0;
    default:
      return false;
  }
}

function caretUpperBound(version) {
  const parsed = parseExactSemver(version, version);
  const parts = [parsed.major, parsed.minor, parsed.patch];
  if (parts[0] > 0) {
    return `${parts[0] + 1}.0.0`;
  }
  if (parts[1] > 0) {
    return `0.${parts[1] + 1}.0`;
  }
  return `0.0.${parts[2] + 1}`;
}

function tildeUpperBound(version) {
  const parsed = parseExactSemver(version, version);
  return `${parsed.major}.${parsed.minor + 1}.0`;
}

function rangeTokenMatches(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token);
  const operator = match[1] ?? "";
  const expected = match[2];
  if (operator === "^" || operator === "~") {
    const lower = parseExactSemver(expected, expected).value;
    const upper =
      operator === "^"
        ? caretUpperBound(expected)
        : tildeUpperBound(expected);
    return (
      compareSemver(version, lower) >= 0 &&
      compareSemver(version, upper) < 0
    );
  }
  return comparatorMatches(version, operator, expected);
}

export function semverRangeSatisfies(version, range) {
  const parsedVersion = parseExactSemver(version, "version");
  return normalizeRangeClauses(range, "range").some((clause) => {
    const tokens = clause.split(/\s+/u);
    if (
      parsedVersion.prerelease.length > 0 &&
      !tokens.some((token) => {
        const expected = /^(?:>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token)?.[1];
        if (expected === undefined) {
          return false;
        }
        const parsedExpected = parseExactSemver(expected, "range");
        return (
          parsedExpected.prerelease.length > 0 &&
          parsedExpected.major === parsedVersion.major &&
          parsedExpected.minor === parsedVersion.minor &&
          parsedExpected.patch === parsedVersion.patch
        );
      })
    ) {
      return false;
    }
    return tokens.every((token) =>
      rangeTokenMatches(version, token));
  });
}

function parseBrowserVersion(value, name) {
  assertString(value, name);
  if (!BROWSER_VERSION_PATTERN.test(value)) {
    throw new Error(`${name} must be a numeric browser version`);
  }
  return value;
}

function parseJson(content, path) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} must contain valid JSON: ${error.message}`);
  }
}

function repositoryEvidence(path, revision, content, observedAt) {
  return {
    type: "repository-file",
    locator: path,
    revision,
    digest: hash(content),
    observed_at: observedAt,
  };
}

function immutableNpmRecord(packageName, raw) {
  const metadata = assertObject(raw, `npm metadata for ${packageName}`);
  if (metadata.name !== packageName) {
    throw new Error(`npm metadata name must equal ${packageName}`);
  }
  const record = {
    name: packageName,
    version: parseExactSemver(
      metadata.version,
      `${packageName}.version`,
    ).value,
    dist: {
      tarball: assertHttpsUrl(
        metadata.dist?.tarball,
        `${packageName}.dist.tarball`,
      ),
      integrity: assertIntegrity(
        metadata.dist?.integrity,
        `${packageName}.dist.integrity`,
      ),
    },
    engines: {
      node: normalizeSemverRange(
        metadata.engines?.node,
        `${packageName}.engines.node`,
      ),
    },
  };
  if (packageName === AXE_PACKAGE) {
    record.dependencies = {
      "axe-core": normalizeSemverRange(
        metadata.dependencies?.["axe-core"],
        `${packageName}.dependencies.axe-core`,
      ),
    };
    record.peerDependencies = {
      "selenium-webdriver": normalizeSemverRange(
        metadata.peerDependencies?.["selenium-webdriver"],
        `${packageName}.peerDependencies.selenium-webdriver`,
      ),
    };
  }
  return record;
}

function npmEvidence(
  record,
  observedAt,
  type = "npm-package-metadata",
) {
  return {
    type,
    locator: record.dist.tarball,
    revision: stableJson(record),
    digest: hash(record),
    observed_at: observedAt,
  };
}

function packageBoundaryEvidence(
  rootNodeRange,
  packageContent,
  lockContent,
  observedAt,
) {
  const identity = {
    root_node_range: rootNodeRange,
    package_digest: hash(packageContent),
    lock_digest: hash(lockContent),
  };
  return {
    type: "selenium-package-boundary",
    locator: PACKAGE_PATH,
    revision: stableJson(identity),
    digest: hash(identity),
    observed_at: observedAt,
  };
}

function immutableRunnerIdentity(kind, raw) {
  const value = assertObject(raw, `runnerEvidence.${kind}`);
  if (value.kind !== undefined && value.kind !== kind) {
    throw new Error(`runnerEvidence.${kind}.kind must equal ${kind}`);
  }
  const name = assertString(value.name, `runnerEvidence.${kind}.name`);
  const version = parseBrowserVersion(
    value.version,
    `runnerEvidence.${kind}.version`,
  );
  const compatibilityKey = parseBrowserVersion(
    value.compatibility_key,
    `runnerEvidence.${kind}.compatibility_key`,
  );
  if (
    compatibilityKey.split(".").length !== 3 ||
    version.split(".").slice(0, 3).join(".") !== compatibilityKey
  ) {
    throw new Error(
      `runnerEvidence.${kind}.version must exactly match its three-part compatibility key`,
    );
  }
  const path = assertString(value.path, `runnerEvidence.${kind}.path`);
  if (!isAbsolute(path)) {
    throw new Error(`runnerEvidence.${kind}.path must be absolute`);
  }
  const resolvedPath = assertString(
    value.realpath,
    `runnerEvidence.${kind}.realpath`,
  );
  if (!isAbsolute(resolvedPath)) {
    throw new Error(`runnerEvidence.${kind}.realpath must be absolute`);
  }
  return {
    kind,
    name,
    version,
    compatibility_key: compatibilityKey,
    path,
    realpath: resolvedPath,
    executable_digest: assertDigest(
      value.executable_digest,
      `runnerEvidence.${kind}.executable_digest`,
    ),
    source_locator: assertHttpsUrl(
      value.source_locator ?? value.locator,
      `runnerEvidence.${kind}.locator`,
    ),
    source_digest: assertDigest(
      value.source_digest ?? value.digest,
      `runnerEvidence.${kind}.digest`,
    ),
  };
}

function runnerEvidence(identity, observedAt) {
  return {
    type: "runner-executable",
    locator: identity.path,
    revision: stableJson(identity),
    digest: hash(identity),
    observed_at: observedAt,
  };
}

function immutableExecutorToolIdentity(name, raw) {
  const value = assertObject(raw, `Selenium executor tool ${name}`);
  assertExactObjectKeys(
    value,
    new Set([
      "digest",
      ...("name" in value ? ["name"] : []),
      "path",
      "realpath",
      "version",
    ]),
    `Selenium executor tool ${name}`,
  );
  if ("name" in value && value.name !== name) {
    throw new Error(`Selenium executor tool ${name} name must match`);
  }
  const path = assertString(
    value.path,
    `Selenium executor tool ${name} path`,
  );
  const resolvedPath = assertString(
    value.realpath,
    `Selenium executor tool ${name} realpath`,
  );
  if (!isAbsolute(path) || !isAbsolute(resolvedPath)) {
    throw new Error(
      `Selenium executor tool ${name} paths must be absolute`,
    );
  }
  return {
    name,
    path,
    realpath: resolvedPath,
    digest: assertDigest(
      value.digest,
      `Selenium executor tool ${name} digest`,
    ),
    version: parseExactSemver(
      value.version,
      `Selenium executor tool ${name} version`,
    ).value,
  };
}

function normalizeExecutorTools(raw) {
  assertExactObjectKeys(
    raw,
    new Set(["node", "npm"]),
    "Selenium executor tools",
  );
  const tools = {
    node: immutableExecutorToolIdentity("node", raw.node),
    npm: immutableExecutorToolIdentity("npm", raw.npm),
  };
  if (
    tools.node.path === tools.npm.path ||
    tools.node.realpath === tools.npm.realpath
  ) {
    throw new Error("Selenium executor Node and npm paths must differ");
  }
  return tools;
}

function readCurrentPackages(packageJson, packageLock) {
  const manifest = assertObject(packageJson, "package.json");
  const dependencies = assertObject(
    manifest.dependencies,
    "package.json.dependencies",
  );
  const root = assertObject(
    packageLock?.packages?.[""],
    'package-lock.json.packages[""]',
  );
  const lockedDependencies = assertObject(
    root.dependencies,
    'package-lock.json.packages[""].dependencies',
  );
  const rootNodeRange = normalizeSemverRange(
    manifest.engines?.node,
    "package.json.engines.node",
  );
  if (
    normalizeSemverRange(
      root.engines?.node,
      'package-lock.json.packages[""].engines.node',
    ) !== rootNodeRange
  ) {
    throw new Error("package-lock root Node range must match package.json");
  }
  const packages = {};
  for (const name of PACKAGE_NAMES) {
    const direct = DIRECT_PACKAGE_NAMES.includes(name);
    const version = direct
      ? parseExactSemver(
          dependencies[name],
          `package.json.dependencies.${name}`,
        ).value
      : parseExactSemver(
          packageLock.packages[`node_modules/${name}`]?.version,
          `${name} lock version`,
        ).value;
    if (direct && lockedDependencies[name] !== version) {
      throw new Error(
        `package-lock root dependency ${name} must match package.json`,
      );
    }
    const entry = assertObject(
      packageLock.packages[`node_modules/${name}`],
      `package-lock entry for ${name}`,
    );
    if (
      parseExactSemver(entry.version, `${name} lock version`).value !==
      version
    ) {
      throw new Error(`${name} lock version must match package.json`);
    }
    packages[name] = {
      name,
      version,
      dist: {
        tarball: assertHttpsUrl(entry.resolved, `${name} lock resolved`),
        integrity: assertIntegrity(
          entry.integrity,
          `${name} lock integrity`,
        ),
      },
      engines: {
        node: normalizeSemverRange(
          entry.engines?.node,
          `${name} lock Node range`,
        ),
      },
    };
    if (name === AXE_PACKAGE) {
      packages[name].dependencies = {
        "axe-core": normalizeSemverRange(
          entry.dependencies?.["axe-core"],
          `${name} lock axe-core range`,
        ),
      };
      packages[name].peerDependencies = {
        "selenium-webdriver": normalizeSemverRange(
          entry.peerDependencies?.["selenium-webdriver"],
          `${name} lock Selenium peer range`,
        ),
      };
    }
  }
  return { packages, rootNodeRange };
}

function selectCapabilities(catalog, selectedCapabilityIds) {
  validateCatalog(catalog);
  const available = catalog.capabilities.filter(
    (capability) => capability.tool === SELENIUM_PROVIDER_ID,
  );
  const byId = new Map(
    available.map((capability) => [capability.id, capability]),
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
  return ids
    .map((id) => {
      const capability = byId.get(id);
      if (capability === undefined) {
        throw new Error(`Unknown selected Selenium capability ${id}`);
      }
      return capability;
    })
    .sort((left, right) => compareText(left.id, right.id));
}

function normalizeRunner(raw, capabilities) {
  const evidence = assertObject(raw, "runnerEvidence");
  const runner = assertString(evidence.runner, "runnerEvidence.runner");
  const browser = immutableRunnerIdentity("browser", evidence.browser);
  const driver = immutableRunnerIdentity("driver", evidence.driver);
  const runners = new Set(capabilities.map((capability) => capability.runner));
  const browsers = new Set(
    capabilities.map((capability) => capability.browser),
  );
  if (runners.size !== 1 || !runners.has(runner)) {
    throw new Error("runner evidence must match the selected runner");
  }
  if (browsers.size !== 1 || !browsers.has(browser.name)) {
    throw new Error("browser evidence must match the selected browser");
  }
  if (driver.name !== "chromedriver") {
    throw new Error("driver evidence must identify chromedriver");
  }
  if (browser.path === driver.path) {
    throw new Error("browser and driver executable paths must differ");
  }
  if (browser.realpath === driver.realpath) {
    throw new Error("browser and driver executable realpaths must differ");
  }
  return { runner, browser, driver };
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
    lane: SELENIUM_PROVIDER_ID,
    ecosystem,
    current,
    candidate,
    eventual_managed_paths: [managedPath],
    affected_capabilities: affectedCapabilities,
  };
}

function packageRecord(record, evidence) {
  return {
    version: record.version,
    evidence,
  };
}

function fallbackRunnerRecord(
  catalogContent,
  repository,
  generatedAt,
) {
  return {
    version: "unknown",
    evidence: [
      repositoryEvidence(
        CATALOG_PATH,
        repository.revision,
        catalogContent,
        generatedAt,
      ),
    ],
  };
}

function relationsFor({
  candidate,
  current,
  rootNodeRange,
  runner,
}) {
  const selected = candidate ?? current;
  const relations = [
    {
      id: "selenium-axe-node",
      type: "requires",
      from: AXE_COMPONENT,
      to: NODE_COMPONENT,
      hard: true,
      constraint: intersectSemverRanges(
        rootNodeRange,
        selected[AXE_PACKAGE].engines.node,
      ),
    },
    {
      id: "selenium-axe-policy-alignment",
      type: "policy-align",
      from: AXE_COMPONENT,
      to: SELENIUM_COMPONENT,
      hard: false,
      constraint:
        selected[AXE_PACKAGE]
          .peerDependencies["selenium-webdriver"],
    },
    {
      id: "selenium-webdriver-node",
      type: "requires",
      from: SELENIUM_COMPONENT,
      to: NODE_COMPONENT,
      hard: true,
      constraint: intersectSemverRanges(
        rootNodeRange,
        selected[SELENIUM_PACKAGE].engines.node,
      ),
    },
  ];
  if (runner !== null) {
    relations.push({
      id: "selenium-runner-browser-driver",
      type: "must-match",
      from: BROWSER_COMPONENT,
      to: DRIVER_COMPONENT,
      hard: true,
      constraint: `=${runner.browser.compatibility_key}`,
    });
  } else {
    relations.push({
      id: "selenium-runner-browser-driver",
      type: "must-match",
      from: BROWSER_COMPONENT,
      to: DRIVER_COMPONENT,
      hard: true,
      constraint: null,
    });
  }
  return relations.sort((left, right) => compareText(left.id, right.id));
}

export async function readNpmMetadata(
  packageName,
  selector = "latest",
  { execute = execFileAsync } = {},
) {
  let exactSelector = selector;
  if (selector !== "latest") {
    try {
      exactSelector = parseExactSemver(
        selector,
        `${packageName} npm selector`,
      ).value;
    } catch {
      const { stdout: versionsOutput } = await execute(
        "npm",
        ["view", `${packageName}@${selector}`, "version", "--json"],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );
      const discovered = parseJson(
        versionsOutput,
        `npm versions for ${packageName}@${selector}`,
      );
      const versions = Array.isArray(discovered)
        ? discovered
        : [discovered];
      if (
        versions.length === 0 ||
        versions.some(
          (version) =>
            parseExactSemver(
              version,
              `${packageName} discovered version`,
            ).value !== version ||
            !semverRangeSatisfies(version, selector),
        )
      ) {
        throw new Error(
          `npm returned invalid versions for ${packageName}@${selector}`,
        );
      }
      exactSelector = sortedUnique(versions).sort(compareSemver).at(-1);
    }
  }
  const { stdout } = await execute(
    "npm",
    [
      "view",
      `${packageName}@${exactSelector}`,
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
  const metadata = parseJson(stdout, `npm metadata for ${packageName}`);
  if (
    Array.isArray(metadata) ||
    metadata?.version === undefined ||
    (exactSelector !== "latest" && metadata.version !== exactSelector)
  ) {
    throw new Error(
      `npm metadata for ${packageName} does not match exact selector ${exactSelector}`,
    );
  }
  return metadata;
}

export async function collectSeleniumObservation({
  repositoryRoot,
  repository,
  generatedAt = new Date().toISOString(),
  npm = readNpmMetadata,
  runnerEvidence: rawRunnerEvidence,
  selectedCapabilityIds,
} = {}) {
  assertString(repositoryRoot, "repositoryRoot");
  assertObject(repository, "repository");
  assertString(repository.name, "repository.name");
  if (!REVISION_PATTERN.test(repository.revision ?? "")) {
    throw new Error("repository.revision must be a full lowercase commit SHA");
  }
  const observedAt = timestamp(generatedAt);
  const packageFile = resolve(repositoryRoot, PACKAGE_PATH);
  const lockFile = resolve(repositoryRoot, LOCK_PATH);
  const catalogFile = resolve(repositoryRoot, CATALOG_PATH);
  const [packageContent, lockContent, catalogContent, catalogBinding] =
    await Promise.all([
      readFile(packageFile),
      readFile(lockFile),
      readFile(catalogFile, "utf8"),
      readCapabilityCatalog(catalogFile),
    ]);
  const packageJson = parseJson(packageContent, PACKAGE_PATH);
  const packageLock = parseJson(lockContent, LOCK_PATH);
  const catalog = parseJson(catalogContent, CATALOG_PATH);
  const capabilities = selectCapabilities(catalog, selectedCapabilityIds);
  const affectedCapabilities = capabilities.map(({ id }) => id);
  const current = readCurrentPackages(packageJson, packageLock);
  const currentEvidence = [
    repositoryEvidence(
      PACKAGE_PATH,
      repository.revision,
      packageContent,
      observedAt,
    ),
    repositoryEvidence(
      LOCK_PATH,
      repository.revision,
      lockContent,
      observedAt,
    ),
  ];

  let candidate = null;
  let npmProblem = null;
  try {
    const axeWebdriver = immutableNpmRecord(
      AXE_PACKAGE,
      await npm(AXE_PACKAGE),
    );
    candidate = {
      [AXE_PACKAGE]: axeWebdriver,
      [AXE_CORE_PACKAGE]: immutableNpmRecord(
        AXE_CORE_PACKAGE,
        await npm(
          AXE_CORE_PACKAGE,
          axeWebdriver.dependencies[AXE_CORE_PACKAGE],
        ),
      ),
      [SELENIUM_PACKAGE]: immutableNpmRecord(
        SELENIUM_PACKAGE,
        await npm(SELENIUM_PACKAGE),
      ),
    };
    if (
      !semverRangeSatisfies(
        candidate[AXE_CORE_PACKAGE].version,
        candidate[AXE_PACKAGE].dependencies[AXE_CORE_PACKAGE],
      )
    ) {
      throw new MetadataError(
        "NPM_METADATA_INCOMPATIBLE",
        "axe-core candidate does not satisfy @axe-core/webdriverjs",
      );
    }
    if (
      PACKAGE_NAMES.some(
        (name) =>
          compareSemver(
            candidate[name].version,
            current.packages[name].version,
          ) < 0,
      )
    ) {
      throw new MetadataError(
        "NPM_METADATA_REGRESSION",
        "npm latest metadata regresses a direct Selenium dependency",
      );
    }
  } catch (error) {
    candidate = null;
    npmProblem =
      error instanceof MetadataError
        ? error
        : new MetadataError(
            error?.code === undefined
              ? "NPM_METADATA_INVALID"
              : "NPM_METADATA_UNAVAILABLE",
            error.message,
          );
  }
  const packageChanged =
    candidate !== null &&
    PACKAGE_NAMES.some(
      (name) =>
        candidate[name].version !== current.packages[name].version,
    );
  const candidateCohort = packageChanged ? candidate : null;

  let runner = null;
  let runnerProblem = null;
  if (rawRunnerEvidence === undefined || rawRunnerEvidence === null) {
    runnerProblem = new MetadataError(
      "RUNNER_BROWSER_DRIVER_EVIDENCE_MISSING",
      "runner browser and driver evidence is required",
      "unknown",
    );
  } else {
    try {
      runner = normalizeRunner(rawRunnerEvidence, capabilities);
      if (
        runner.browser.compatibility_key !==
        runner.driver.compatibility_key
      ) {
        runnerProblem = new MetadataError(
          "RUNNER_BROWSER_DRIVER_MISMATCH",
          "runner browser and driver compatibility keys differ",
          "unknown",
        );
      }
    } catch (error) {
      runner = null;
      runnerProblem = new MetadataError(
        "RUNNER_BROWSER_DRIVER_EVIDENCE_INVALID",
        error.message,
      );
    }
  }

  const packageComponents = [
    component({
      affectedCapabilities,
      candidate:
        candidateCohort === null
          ? null
          : packageRecord(candidateCohort[AXE_PACKAGE], [
              npmEvidence(candidateCohort[AXE_PACKAGE], observedAt),
              npmEvidence(
                candidateCohort[AXE_CORE_PACKAGE],
                observedAt,
                "npm-transitive-package-metadata",
              ),
            ]),
      current: packageRecord(
        current.packages[AXE_PACKAGE],
        currentEvidence,
      ),
      ecosystem: "npm",
      id: AXE_COMPONENT,
      managedPath: LOCK_PATH,
    }),
    component({
      affectedCapabilities,
      candidate:
        candidateCohort === null
          ? null
          : packageRecord(candidateCohort[SELENIUM_PACKAGE], [
              npmEvidence(candidateCohort[SELENIUM_PACKAGE], observedAt),
              packageBoundaryEvidence(
                current.rootNodeRange,
                packageContent,
                lockContent,
                observedAt,
              ),
            ]),
      current: packageRecord(
        current.packages[SELENIUM_PACKAGE],
        currentEvidence,
      ),
      ecosystem: "npm",
      id: SELENIUM_COMPONENT,
      managedPath: PACKAGE_PATH,
    }),
  ];
  const runnerCurrent =
    runner === null
      ? {
          browser: fallbackRunnerRecord(
            catalogContent,
            repository,
            observedAt,
          ),
          driver: fallbackRunnerRecord(
            catalogContent,
            repository,
            observedAt,
          ),
        }
      : {
          browser: {
            version: runner.browser.compatibility_key,
            evidence: [runnerEvidence(runner.browser, observedAt)],
          },
          driver: {
            version: runner.driver.compatibility_key,
            evidence: [runnerEvidence(runner.driver, observedAt)],
          },
        };
  const runnerCandidate =
    candidateCohort === null || runner === null
      ? { browser: null, driver: null }
      : {
          browser: structuredClone(runnerCurrent.browser),
          driver: structuredClone(runnerCurrent.driver),
        };
  const components = [
    ...packageComponents,
    component({
      affectedCapabilities,
      candidate: runnerCandidate.browser,
      current: runnerCurrent.browser,
      ecosystem: "runner",
      id: BROWSER_COMPONENT,
      managedPath: BROWSER_POLICY_PATH,
    }),
    component({
      affectedCapabilities,
      candidate: runnerCandidate.driver,
      current: runnerCurrent.driver,
      ecosystem: "runner",
      id: DRIVER_COMPONENT,
      managedPath: DRIVER_POLICY_PATH,
    }),
  ].sort((left, right) => compareText(left.id, right.id));

  const problems = [npmProblem, runnerProblem].filter(Boolean);
  let disposition;
  if (problems.length > 0) {
    disposition = {
      state: problems.some(({ state }) => state === "unavailable")
        ? "unavailable"
        : "unknown",
      reason_codes: sortedUnique(
        problems.map(({ reasonCode }) => reasonCode),
      ),
    };
  } else if (candidateCohort !== null) {
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
    generated_at: observedAt,
    repository: structuredClone(repository),
    capability_catalog: {
      schema_version: catalogBinding.schemaVersion,
      digest: catalogBinding.digest,
    },
    provider_id: SELENIUM_PROVIDER_ID,
    disposition,
    components,
    relations: relationsFor({
      candidate: candidateCohort,
      current: current.packages,
      rootNodeRange: current.rootNodeRange,
      runner,
    }),
  };
  validateDocument(document, {
    capabilityIds: catalogBinding.ids,
    capabilityCatalogDigest: catalogBinding.digest,
  });
  return document;
}

function candidateComponent(observation, id) {
  const candidate = observation.components.find(
    (entry) => entry.id === id,
  )?.candidate;
  if (candidate === null || candidate === undefined) {
    throw new Error(`Selenium observation lacks candidate component ${id}`);
  }
  return candidate;
}

function decodeEvidenceRecord(record, type, name) {
  const evidence = record.evidence.find((entry) => entry.type === type);
  if (evidence === undefined) {
    throw new Error(`${name} lacks ${type} evidence`);
  }
  let value;
  try {
    value = JSON.parse(evidence.revision);
  } catch {
    throw new Error(`${name} evidence revision is not valid JSON`);
  }
  if (
    hash(value) !== evidence.digest ||
    (value.dist?.tarball ?? value.path) !== evidence.locator
  ) {
    throw new Error(`${name} evidence does not bind its immutable identity`);
  }
  return value;
}

function decodePackageBoundary(record) {
  const name = `${SELENIUM_COMPONENT} package boundary`;
  const evidence = record.evidence.find(
    (entry) => entry.type === "selenium-package-boundary",
  );
  if (evidence === undefined) {
    throw new Error(`${name} lacks selenium-package-boundary evidence`);
  }
  const value = parseJson(evidence.revision, `${name} evidence`);
  const rootNodeRange = normalizeSemverRange(
    value.root_node_range,
    `${name}.root_node_range`,
  );
  assertDigest(value.package_digest, `${name}.package_digest`);
  assertDigest(value.lock_digest, `${name}.lock_digest`);
  if (
    evidence.locator !== PACKAGE_PATH ||
    hash(value) !== evidence.digest
  ) {
    throw new Error(`${name} evidence does not bind its immutable identity`);
  }
  return {
    rootNodeRange,
    packageDigest: value.package_digest,
    lockDigest: value.lock_digest,
  };
}

function decodedCandidate(observation) {
  const axe = immutableNpmRecord(
    AXE_PACKAGE,
    decodeEvidenceRecord(
      candidateComponent(observation, AXE_COMPONENT),
      "npm-package-metadata",
      AXE_COMPONENT,
    ),
  );
  const selenium = immutableNpmRecord(
    SELENIUM_PACKAGE,
    decodeEvidenceRecord(
      candidateComponent(observation, SELENIUM_COMPONENT),
      "npm-package-metadata",
      SELENIUM_COMPONENT,
    ),
  );
  const axeCore = immutableNpmRecord(
    AXE_CORE_PACKAGE,
    decodeEvidenceRecord(
      candidateComponent(observation, AXE_COMPONENT),
      "npm-transitive-package-metadata",
      `${AXE_COMPONENT} transitive axe-core`,
    ),
  );
  const browser = immutableRunnerIdentity(
    "browser",
    decodeEvidenceRecord(
      candidateComponent(observation, BROWSER_COMPONENT),
      "runner-executable",
      BROWSER_COMPONENT,
    ),
  );
  const driver = immutableRunnerIdentity(
    "driver",
    decodeEvidenceRecord(
      candidateComponent(observation, DRIVER_COMPONENT),
      "runner-executable",
      DRIVER_COMPONENT,
    ),
  );
  const packageBoundary = decodePackageBoundary(
    candidateComponent(observation, SELENIUM_COMPONENT),
  );
  for (const [componentId, record] of [
    [AXE_COMPONENT, axe],
    [SELENIUM_COMPONENT, selenium],
  ]) {
    if (
      candidateComponent(observation, componentId).version !== record.version
    ) {
      throw new Error(`${componentId} version does not match npm evidence`);
    }
  }
  for (const [componentId, identity] of [
    [BROWSER_COMPONENT, browser],
    [DRIVER_COMPONENT, driver],
  ]) {
    if (
      candidateComponent(observation, componentId).version !==
      identity.compatibility_key
    ) {
      throw new Error(`${componentId} version does not match runner evidence`);
    }
  }
  return {
    packages: {
      [AXE_PACKAGE]: axe,
      [AXE_CORE_PACKAGE]: axeCore,
      [SELENIUM_PACKAGE]: selenium,
    },
    packageBoundary,
    runner: { browser, driver },
  };
}

async function verifySourcePackageBinding(observation, repositoryRoot) {
  const candidate = decodedCandidate(observation);
  const [packageContent, lockContent] = await Promise.all([
    readFile(resolve(repositoryRoot, PACKAGE_PATH)),
    readFile(resolve(repositoryRoot, LOCK_PATH)),
  ]);
  if (
    hash(packageContent) !== candidate.packageBoundary.packageDigest ||
    hash(lockContent) !== candidate.packageBoundary.lockDigest
  ) {
    throw new Error(
      "Selenium observation does not bind the source package boundary",
    );
  }
  const current = readCurrentPackages(
    parseJson(packageContent, PACKAGE_PATH),
    parseJson(lockContent, LOCK_PATH),
  );
  if (
    current.rootNodeRange !== candidate.packageBoundary.rootNodeRange
  ) {
    throw new Error(
      "Selenium observation Node range does not bind the source package boundary",
    );
  }
}

function sameStrings(left, right) {
  return (
    JSON.stringify([...left].sort(compareText)) ===
    JSON.stringify([...right].sort(compareText))
  );
}

function relativeStep({
  arguments: arguments_,
  capabilityId = null,
  command,
  cwd = ".",
  environment = {},
  id,
  kind,
  phase,
  scenario = null,
  tool = null,
}) {
  return {
    id,
    kind,
    phase,
    capability_id: capabilityId,
    scenario,
    command,
    arguments: arguments_,
    tool,
    cwd,
    environment: Object.fromEntries(
      Object.entries(environment).sort(([left], [right]) =>
        compareText(left, right),
      ),
    ),
  };
}

function capabilityEnvironment(capability, candidate) {
  return {
    E2E_BROWSER: capability.browser,
    E2E_BROWSER_BINARY: candidate.runner.browser.realpath,
    E2E_BROWSER_EXECUTABLE_DIGEST:
      candidate.runner.browser.executable_digest,
    E2E_BROWSER_EXECUTABLE_REALPATH:
      candidate.runner.browser.realpath,
    E2E_BROWSER_EXECUTABLE_VERSION:
      candidate.runner.browser.version,
    E2E_DRIVER_BINARY: candidate.runner.driver.realpath,
    E2E_DRIVER_EXECUTABLE_DIGEST:
      candidate.runner.driver.executable_digest,
    E2E_DRIVER_EXECUTABLE_REALPATH:
      candidate.runner.driver.realpath,
    E2E_DRIVER_EXECUTABLE_VERSION:
      candidate.runner.driver.version,
    E2E_OS: capability.os,
    E2E_SELENIUM_ALLOW_DOWNLOADS: "false",
    MISE_ENV: capability.environment,
    MISE_LOCKED: "1",
  };
}

function nodeStep(tools, properties) {
  return relativeStep({
    ...properties,
    command: tools.node.realpath,
    tool: "node",
  });
}

function npmStep(tools, properties) {
  return relativeStep({
    ...properties,
    command: tools.node.realpath,
    arguments: [tools.npm.realpath, ...properties.arguments],
    tool: "npm",
  });
}

function capabilitySteps(capability, candidate, tools) {
  const environment = capabilityEnvironment(capability, candidate);
  const steps = [
    nodeStep(tools, {
      id: `${capability.id}-setup`,
      kind: "command",
      phase: "capability",
      capabilityId: capability.id,
      arguments: [
        SELENIUM_SETUP_PATH,
        "--browser",
        capability.browser,
        "--os",
        capability.os,
      ],
      environment,
    }),
  ];
  for (const scenario of capability.scenarios) {
    for (const kind of ["browser", "driver"]) {
      const identity = candidate.runner[kind];
      steps.push(
        relativeStep({
          id: `${capability.id}-${scenario}-verify-${kind}-before`,
          kind: `${kind}-identity`,
          phase: "capability",
          capabilityId: capability.id,
          command: identity.realpath,
          arguments: ["--version"],
          environment,
          scenario,
        }),
      );
    }
    if (scenario === "smoke") {
      steps.push(
        nodeStep(tools, {
          id: `${capability.id}-smoke`,
          kind: "command",
          phase: "capability",
          capabilityId: capability.id,
          arguments: [
            SELENIUM_SMOKE_PATH,
            "--browser",
            capability.browser,
            "--os",
            capability.os,
          ],
          environment,
          scenario,
        }),
      );
    } else if (scenario === "web-calculator") {
      steps.push(
        nodeStep(tools, {
          id: `${capability.id}-web-calculator`,
          kind: "command",
          phase: "capability",
          capabilityId: capability.id,
          arguments: [
            WEB_CALCULATOR_LIFECYCLE_PATH,
            tools.node.realpath,
            SELENIUM_WEB_CALCULATOR_PATH,
            "--browser",
            capability.browser,
            "--os",
            capability.os,
          ],
          environment,
          scenario,
        }),
      );
    } else {
      throw new Error(
        `Unsupported Selenium qualification scenario ${scenario}`,
      );
    }
    for (const kind of ["browser", "driver"]) {
      const identity = candidate.runner[kind];
      steps.push(
        relativeStep({
          id: `${capability.id}-${scenario}-verify-${kind}-after`,
          kind: `${kind}-identity`,
          phase: "capability",
          capabilityId: capability.id,
          command: identity.realpath,
          arguments: ["--version"],
          environment,
          scenario,
        }),
      );
    }
  }
  steps.push(
    nodeStep(tools, {
      id: `${capability.id}-artifact-contracts`,
      kind: "command",
      phase: "evidence",
      capabilityId: capability.id,
      arguments: [REPORT_VALIDATOR_PATH],
      environment: {
        ...environment,
        E2E_CAPABILITY_ID: capability.id,
        E2E_EVIDENCE_FILE: capability.evidence,
        E2E_REQUIRED_FILES: JSON.stringify(capability.required_files),
        E2E_REQUIRE_ACCESSIBILITY: String(
          capability.require_accessibility,
        ),
        E2E_RESULT_REPORTS: JSON.stringify(capability.result_reports),
      },
    }),
  );
  return steps;
}

function qualificationCapability(capability) {
  const scenarios = [...capability.scenarios];
  if (
    scenarios.length === 0 ||
    new Set(scenarios).size !== scenarios.length
  ) {
    throw new Error(
      `${capability.id} must select a nonempty unique scenario set`,
    );
  }
  const resultReports = scenarios.map(
    (scenario) =>
      `${SELENIUM_PACKAGE_DIRECTORY}/diagnostics/${scenario}/result.json`,
  );
  return {
    id: capability.id,
    browser: capability.browser,
    os: capability.os,
    runner: capability.runner,
    scenarios,
    diagnostics: capability.diagnostics,
    evidence: capability.evidence,
    required_files: sortedUnique([
      ...capability.required_files,
      ...resultReports,
    ]),
    result_reports: resultReports,
    require_accessibility: capability.require_accessibility,
  };
}

function validateRepositoryFileManifest(
  manifest,
  repositoryRevision,
  {
    kind,
    label,
    requireExecutableInputs = false,
  },
) {
  assertExactObjectKeys(
    manifest,
    new Set([
      "files",
      "github_api_permission",
      "kind",
      "repository_revision",
      "schema_version",
    ]),
    label,
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== kind ||
    manifest.repository_revision !== repositoryRevision ||
    manifest.github_api_permission !== "none" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(
      `${label} must bind the repository revision, files, and no GitHub API permission`,
    );
  }
  const paths = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    assertExactObjectKeys(
      entry,
      new Set(["digest", "mode", "path", "type"]),
      `${label} file[${index}]`,
    );
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..") ||
      paths.has(entry.path) ||
      entry.type !== "file" ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw new Error(
        `${label} must contain unique repository files`,
      );
    }
    assertDigest(
      entry.digest,
      `${label} file[${index}].digest`,
    );
    paths.add(entry.path);
  }
  if (
    stableJson([...manifest.files].sort(({ path: left }, { path: right }) =>
      compareText(left, right))) !== stableJson(manifest.files)
  ) {
    throw new Error(`${label} files must be sorted`);
  }
  if (requireExecutableInputs) {
    for (const path of TRUSTED_EXECUTION_PATHS) {
      if (!paths.has(path)) {
        throw new Error(
          `${label} lacks executable input ${path}`,
        );
      }
    }
  }
  return structuredClone(manifest);
}

function manifestFromEntries(
  entries,
  repositoryRevision,
  kind,
  label,
  options = {},
) {
  return validateRepositoryFileManifest(
    {
      schema_version: 1,
      kind,
      repository_revision: repositoryRevision,
      github_api_permission: "none",
      files: entries
        .map(([path, entry]) => ({
          path,
          type: "file",
          mode: entry.mode,
          digest: entry.digest,
        }))
        .sort(({ path: left }, { path: right }) =>
          compareText(left, right)),
    },
    repositoryRevision,
    { kind, label, ...options },
  );
}

async function repositoryFileEntries(
  repositoryRoot,
  repositoryRevision,
) {
  if (!REVISION_PATTERN.test(repositoryRevision ?? "")) {
    throw new Error(
      "Selenium repository manifest revision must be a full lowercase commit SHA",
    );
  }
  const entries = await treeEntries(repositoryRoot, repositoryRoot, {
    excludeRootNames: new Set([".git"]),
  });
  if (entries.some(([, entry]) => entry.type !== "file")) {
    throw new Error(
      "Selenium trusted-input manifest does not permit repository symlinks",
    );
  }
  return entries;
}

export async function createSeleniumSourceMaterializationManifest(
  repositoryRoot,
  repositoryRevision,
) {
  return manifestFromEntries(
    await repositoryFileEntries(repositoryRoot, repositoryRevision),
    repositoryRevision,
    SOURCE_MANIFEST_KIND,
    "Selenium source materialization manifest",
  );
}

export async function createSeleniumMutableSeedManifest(
  repositoryRoot,
  repositoryRevision,
) {
  const entries = await repositoryFileEntries(
    repositoryRoot,
    repositoryRevision,
  );
  return manifestFromEntries(
    entries.filter(([path]) =>
      pathIsMutable(path, SELENIUM_MUTABLE_PATHS)),
    repositoryRevision,
    MUTABLE_SEED_MANIFEST_KIND,
    "Selenium mutable-seed manifest",
  );
}

export async function createSeleniumTrustedInputManifest(
  repositoryRoot,
  repositoryRevision,
) {
  const entries = await repositoryFileEntries(
    repositoryRoot,
    repositoryRevision,
  );
  return manifestFromEntries(
    entries.filter(([path]) =>
      !pathIsMutable(path, SELENIUM_MUTABLE_PATHS)),
    repositoryRevision,
    TRUSTED_INPUT_MANIFEST_KIND,
    "Selenium trusted-input manifest",
    { requireExecutableInputs: true },
  );
}

function validateWorkspaceManifestPartition({
  mutableSeedManifest,
  repositoryRevision,
  sourceMaterializationManifest,
  trustedInputManifest,
}) {
  const source = validateRepositoryFileManifest(
    sourceMaterializationManifest,
    repositoryRevision,
    {
      kind: SOURCE_MANIFEST_KIND,
      label: "Selenium source materialization manifest",
    },
  );
  const seed = validateRepositoryFileManifest(
    mutableSeedManifest,
    repositoryRevision,
    {
      kind: MUTABLE_SEED_MANIFEST_KIND,
      label: "Selenium mutable-seed manifest",
    },
  );
  const trusted = validateRepositoryFileManifest(
    trustedInputManifest,
    repositoryRevision,
    {
      kind: TRUSTED_INPUT_MANIFEST_KIND,
      label: "Selenium trusted-input manifest",
      requireExecutableInputs: true,
    },
  );
  const sourceByPath = new Map(
    source.files.map((entry) => [entry.path, entry]),
  );
  const seedPaths = new Set(seed.files.map(({ path }) => path));
  const trustedPaths = new Set(trusted.files.map(({ path }) => path));
  for (const path of seedPaths) {
    if (!pathIsMutable(path, SELENIUM_MUTABLE_PATHS)) {
      throw new Error(
        `Selenium mutable-seed manifest contains immutable path ${path}`,
      );
    }
    if (trustedPaths.has(path)) {
      throw new Error(
        `Selenium trusted and mutable-seed manifests overlap at ${path}`,
      );
    }
  }
  for (const path of trustedPaths) {
    if (pathIsMutable(path, SELENIUM_MUTABLE_PATHS)) {
      throw new Error(
        `Selenium trusted-input manifest labels mutable path ${path} read-only`,
      );
    }
  }
  const partition = [...seed.files, ...trusted.files]
    .sort(({ path: left }, { path: right }) => compareText(left, right));
  if (
    stableJson(partition) !== stableJson(source.files) ||
    partition.some((entry) =>
      stableJson(sourceByPath.get(entry.path)) !== stableJson(entry))
  ) {
    throw new Error(
      "Selenium source materialization manifest must exactly partition into mutable seed and immutable trusted inputs",
    );
  }
  return {
    source,
    seed,
    trusted,
    source_digest: hash(source),
    seed_digest: hash(seed),
    trusted_digest: hash(trusted),
    partition_digest: hash({
      mutable_paths: SELENIUM_MUTABLE_PATHS,
      seed_digest: hash(seed),
      source_digest: hash(source),
      trusted_digest: hash(trusted),
    }),
  };
}

export function createSeleniumQualificationPlan({
  observation,
  catalog,
  executorTools,
  mutableSeedManifest,
  sourceMaterializationManifest,
  trustedInputManifest,
} = {}) {
  validateCatalog(catalog);
  const capabilityDigest = hash(unorderedCanonicalValue(catalog));
  if (
    observation.provider_id !== SELENIUM_PROVIDER_ID ||
    observation.disposition.state !== "candidate"
  ) {
    throw new Error("Selenium qualification requires a candidate observation");
  }
  if (observation.capability_catalog.digest !== capabilityDigest) {
    throw new Error(
      "Qualification catalog must match the observed capability catalog",
    );
  }
  const capabilityIds = new Set(catalog.capabilities.map(({ id }) => id));
  validateDocument(observation, {
    capabilityIds,
    capabilityCatalogDigest: capabilityDigest,
  });
  const affected = new Set(
    observation.components
      .filter((entry) => entry.candidate !== null)
      .flatMap((entry) => entry.affected_capabilities),
  );
  const capabilities = selectCapabilities(catalog).filter(
    ({ id }) => affected.has(id),
  );
  if (!sameStrings(capabilities.map(({ id }) => id), affected)) {
    throw new Error(
      "Qualification must cover the complete selected Selenium capability set",
    );
  }
  const candidate = decodedCandidate(observation);
  const tools = normalizeExecutorTools(executorTools);
  const manifests = validateWorkspaceManifestPartition({
    mutableSeedManifest,
    repositoryRevision: observation.repository.revision,
    sourceMaterializationManifest,
    trustedInputManifest,
  });
  if (
    candidate.runner.browser.compatibility_key !==
    candidate.runner.driver.compatibility_key
  ) {
    throw new Error("Runner browser and driver evidence must match");
  }
  const expectedRelations = relationsFor({
    candidate: candidate.packages,
    current: null,
    rootNodeRange: candidate.packageBoundary.rootNodeRange,
    runner: candidate.runner,
  });
  if (stableJson(observation.relations) !== stableJson(expectedRelations)) {
    throw new Error(
      "Selenium relations do not exactly bind package and runner evidence",
    );
  }
  const selectedCapabilities = capabilities.map(qualificationCapability);
  const registryOrigins = new Set(
    PACKAGE_NAMES.map(
      (name) => new URL(candidate.packages[name].dist.tarball).origin,
    ),
  );
  if (registryOrigins.size !== 1) {
    throw new Error("Candidate npm tarballs must share one registry origin");
  }
  const [registryOrigin] = registryOrigins;
  const steps = [
    nodeStep(tools, {
      id: "verify-executor-node",
      kind: "node-identity",
      phase: "prepare",
      arguments: ["--version"],
    }),
    npmStep(tools, {
      id: "verify-executor-npm",
      kind: "npm-identity",
      phase: "prepare",
      arguments: ["--version"],
    }),
    ...PACKAGE_NAMES.map((name) =>
      npmStep(tools, {
        id: {
          [AXE_PACKAGE]: "cache-selenium-axe-webdriver-tarball",
          [AXE_CORE_PACKAGE]: "cache-selenium-axe-core-tarball",
          [SELENIUM_PACKAGE]: "cache-selenium-webdriver-tarball",
        }[name],
        kind: "command",
        phase: "prepare",
        cwd: SELENIUM_PACKAGE_DIRECTORY,
        arguments: [
          "cache",
          "add",
          candidate.packages[name].dist.tarball,
          "--cache",
          ".npm-cache",
        ],
      })),
    npmStep(tools, {
      id: "apply-selenium-tarballs",
      kind: "command",
      phase: "prepare",
      cwd: SELENIUM_PACKAGE_DIRECTORY,
      arguments: [
        "install",
        "--package-lock-only",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        ".npm-cache",
        "--prefer-offline",
        "--registry",
        registryOrigin,
        ...DIRECT_PACKAGE_NAMES.map(
          (name) => `${name}@${candidate.packages[name].version}`,
        ),
      ],
    }),
    npmStep(tools, {
      id: "install-selenium-candidate",
      kind: "command",
      phase: "prepare",
      cwd: SELENIUM_PACKAGE_DIRECTORY,
      arguments: [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        ".npm-cache",
        "--prefer-offline",
      ],
    }),
    relativeStep({
      id: "verify-runner-browser",
      kind: "browser-identity",
      phase: "prepare",
      command: candidate.runner.browser.realpath,
      arguments: ["--version"],
    }),
    relativeStep({
      id: "verify-runner-driver",
      kind: "driver-identity",
      phase: "prepare",
      command: candidate.runner.driver.realpath,
      arguments: ["--version"],
    }),
    nodeStep(tools, {
      id: "test-selenium-package",
      kind: "command",
      phase: "package-test",
      arguments: [
        "--test",
        ...SELENIUM_PACKAGE_TEST_PATHS,
      ],
    }),
    relativeStep({
      id: "verify-runner-browser-after-package-tests",
      kind: "browser-identity",
      phase: "package-test",
      command: candidate.runner.browser.realpath,
      arguments: ["--version"],
    }),
    relativeStep({
      id: "verify-runner-driver-after-package-tests",
      kind: "driver-identity",
      phase: "package-test",
      command: candidate.runner.driver.realpath,
      arguments: ["--version"],
    }),
    ...selectedCapabilities.flatMap((capability) =>
      capabilitySteps(capability, candidate, tools)),
  ];
  return {
    schema_version: 1,
    kind: "selenium-qualification-plan",
    provider_id: SELENIUM_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    repository: structuredClone(observation.repository),
    workspace: {
      kind: "isolated-executor",
      github_api_permission: "none",
      source_materialization: {
        kind: SOURCE_MANIFEST_KIND,
        manifest: manifests.source,
        manifest_digest: manifests.source_digest,
      },
      mutable_seed: {
        kind: MUTABLE_SEED_MANIFEST_KIND,
        manifest: manifests.seed,
        manifest_digest: manifests.seed_digest,
      },
      immutable_inputs: {
        kind: TRUSTED_INPUT_MANIFEST_KIND,
        access: "read-only",
        manifest: manifests.trusted,
        manifest_digest: manifests.trusted_digest,
      },
      mutable_paths: [...SELENIUM_MUTABLE_PATHS],
      managed_paths: [...SELENIUM_MANAGED_PATHS],
      partition_digest: manifests.partition_digest,
    },
    packages: PACKAGE_NAMES.map((name) =>
      structuredClone(candidate.packages[name])),
    tools,
    runner: structuredClone(candidate.runner),
    selected_capabilities: selectedCapabilities,
    steps,
  };
}

function isWithin(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function copyRepository(source, destination) {
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter(path) {
      const repositoryPath = relative(source, path);
      if (repositoryPath === "") {
        return true;
      }
      return !repositoryPath.split(sep).some((part) =>
        [".git", ".runtime", "diagnostics", "node_modules", "target"]
          .includes(part));
    },
  });
}

async function validateContainedSymlinks(root, label) {
  const absoluteRoot = resolve(root);
  const canonicalRoot = await realpath(absoluteRoot);
  const rootMetadata = await lstat(absoluteRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`${label} root must be a real directory`);
  }
  const entries = await treeEntries(absoluteRoot, absoluteRoot, {
    excludeRootNames: new Set([".git"]),
  });
  for (const [path, entry] of entries) {
    if (entry.type !== "symlink") {
      continue;
    }
    const linkPath = resolve(absoluteRoot, path);
    const lexicalTarget = isAbsolute(entry.target)
      ? resolve(entry.target)
      : resolve(dirname(linkPath), entry.target);
    if (!isWithin(absoluteRoot, lexicalTarget)) {
      throw new Error(`${label} symlink ${path} escapes its root`);
    }
    let canonicalTarget;
    try {
      canonicalTarget = await realpath(linkPath);
    } catch (error) {
      throw new Error(`${label} symlink ${path} is unresolved`, {
        cause: error,
      });
    }
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      throw new Error(`${label} symlink ${path} resolves outside its root`);
    }
  }
}

async function defaultCreateWorkspace() {
  return mkdtemp(join(tmpdir(), "oculix-selenium-qualification-"));
}

async function checkoutState(repositoryRoot) {
  const options = {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  };
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--verify", "HEAD"], options),
    execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
        "-z",
      ],
      options,
    ),
  ]);
  return {
    head: head.trim(),
    status,
  };
}

function warningLines(output) {
  const warningPattern =
    /(?:\bwarn(?:ing)?s?\b|\b[A-Za-z][A-Za-z0-9_-]*warnings?\b)/iu;
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => warningPattern.test(line) && line.length > 0);
}

function workspaceBindingDigests(plan) {
  return {
    source_materialization_digest:
      plan.workspace.source_materialization.manifest_digest,
    mutable_seed_digest:
      plan.workspace.mutable_seed.manifest_digest,
    trusted_inputs_digest:
      plan.workspace.immutable_inputs.manifest_digest,
    workspace_partition_digest: plan.workspace.partition_digest,
  };
}

function fileManifestContentDigest(manifest) {
  return hash(
    manifest.files.map(({ path, ...entry }) => [path, entry]),
  );
}

function commandEvidence(
  step,
  plan,
  raw,
  startedAt,
  completedAt,
) {
  return {
    type: "qualification-check",
    locator: `selenium-check:${step.id}`,
    revision: plan.repository.revision,
    digest: hash({
      candidate_digest: plan.candidate_digest,
      plan_digest: hash(plan),
      step,
      tools: plan.tools,
      ...workspaceBindingDigests(plan),
      runner: plan.runner,
      raw,
    }),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

function assertRawCommandResult(raw, stepId) {
  assertObject(raw, `${stepId} raw result`);
  const allowed = new Set(["exitCode", "signal", "stderr", "stdout"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${stepId} raw result contains untrusted fields: ${unknown.join(", ")}`,
    );
  }
  if (!Number.isInteger(raw.exitCode) || raw.exitCode < 0) {
    throw new Error(`${stepId} raw result exitCode must be nonnegative`);
  }
  if (typeof raw.stdout !== "string" || typeof raw.stderr !== "string") {
    throw new Error(`${stepId} raw output must be strings`);
  }
  if (raw.signal !== null && typeof raw.signal !== "string") {
    throw new Error(`${stepId} raw result signal must be null or a string`);
  }
  return {
    exitCode: raw.exitCode,
    signal: raw.signal ?? null,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

function assertExactObjectKeys(value, allowed, name) {
  assertObject(value, name);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${name} must contain exactly ${[...allowed].sort(compareText).join(", ")}`,
    );
  }
}

function validateEnvironmentOverrides(overrides) {
  assertObject(overrides, "Selenium executor environment overrides");
  const environment = {};
  for (const [name, value] of Object.entries(overrides)) {
    if (!SAFE_ENVIRONMENT_OVERRIDES.has(name)) {
      throw new Error(
        `Selenium executor environment variable ${name} is not allowlisted`,
      );
    }
    assertString(value, `Selenium executor environment ${name}`);
    if (name === "NPM_CONFIG_STRICT_SSL" && !["true", "false"].includes(value)) {
      throw new Error(
        "Selenium executor environment NPM_CONFIG_STRICT_SSL must be true or false",
      );
    }
    environment[name] = value;
  }
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      compareText(left, right)),
  );
}

function validateExecutor(executor, trustedAuthority) {
  assertExactObjectKeys(
    executor,
    new Set(["authority", "execute", "id", "path", "seal", "tools"]),
    "Selenium executor",
  );
  if (
    typeof executor.id !== "string" ||
    !EXECUTOR_ID_PATTERN.test(executor.id)
  ) {
    throw new Error("Selenium executor id must be a kebab-case identifier");
  }
  if (typeof executor.execute !== "function") {
    throw new Error("Selenium executor execute must be a function");
  }
  if (typeof executor.seal !== "function") {
    throw new Error("Selenium executor seal must be a function");
  }
  assertExactObjectKeys(
    executor.authority,
    new Set([
      "github_api_permission",
      "identity_digest",
      "kind",
      "public_key",
    ]),
    "Selenium executor authority",
  );
  if (
    executor.authority.kind !== "ed25519" ||
    executor.authority.github_api_permission !== "none"
  ) {
    throw new Error(
      "Selenium executor authority must be Ed25519 with no GitHub API permission",
    );
  }
  assertDigest(
    executor.authority.identity_digest,
    "Selenium executor authority identity_digest",
  );
  assertString(
    executor.authority.public_key,
    "Selenium executor authority public_key",
  );
  let publicKey;
  try {
    publicKey = createPublicKey(executor.authority.public_key);
  } catch (error) {
    throw new Error("Selenium executor authority public_key is invalid", {
      cause: error,
    });
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Selenium executor authority public_key must be Ed25519");
  }
  if (
    executor.authority.identity_digest !==
    hash(executor.authority.public_key)
  ) {
    throw new Error(
      "Selenium executor authority identity_digest must bind its public key",
    );
  }
  assertExactObjectKeys(
    trustedAuthority,
    new Set([
      "github_api_permission",
      "identity_digest",
      "kind",
      "public_key",
    ]),
    "Caller-trusted Selenium executor authority",
  );
  if (
    stableJson(executor.authority) !== stableJson(trustedAuthority)
  ) {
    throw new Error("Selenium executor authority is not caller-trusted");
  }
  if (
    !Array.isArray(executor.path) ||
    executor.path.length === 0 ||
    new Set(executor.path).size !== executor.path.length ||
    executor.path.some(
      (directory) =>
        typeof directory !== "string" || !isAbsolute(directory),
    )
  ) {
    throw new Error(
      "Selenium executor path must contain unique absolute directories",
    );
  }
  return {
    ...executor,
    authority: structuredClone(executor.authority),
    tools: normalizeExecutorTools(executor.tools),
  };
}

function sanitizedEnvironment(
  workspaceRoot,
  temporaryRoot,
  executorPath,
  overrides,
) {
  return {
    CI: "true",
    E2E_SELENIUM_CACHE: resolve(
      workspaceRoot,
      SELENIUM_PACKAGE_DIRECTORY,
      ".runtime",
      "selenium-cache",
    ),
    GITHUB_WORKSPACE: workspaceRoot,
    HOME: resolve(temporaryRoot, "executor-home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: resolve(
      workspaceRoot,
      SELENIUM_PACKAGE_DIRECTORY,
      ".npm-cache",
    ),
    NPM_CONFIG_FUND: "false",
    PATH: executorPath.join(delimiter),
    TMPDIR: resolve(temporaryRoot, "executor-tmp"),
    ...validateEnvironmentOverrides(overrides),
  };
}

function executorPolicy({
  executorAuthority,
  executorId,
  executorTools,
  immutableInputsDigest,
  mutablePaths,
  plan,
  baseEnvironment,
  temporaryRoot,
  workspaceRoot,
}) {
  const policyEnvironment = Object.fromEntries(
    Object.entries(baseEnvironment).map(([name, value]) => [
      name,
      typeof value === "string" &&
      (value === workspaceRoot || value.startsWith(`${workspaceRoot}${sep}`))
        ? value === workspaceRoot
          ? "${WORKSPACE_ROOT}"
          : `\${WORKSPACE_ROOT}/${relative(workspaceRoot, value)
              .split(sep)
              .join("/")}`
        : typeof value === "string" &&
            (value === temporaryRoot ||
              value.startsWith(`${temporaryRoot}${sep}`))
          ? value === temporaryRoot
            ? "${EXECUTOR_STATE_ROOT}"
            : `\${EXECUTOR_STATE_ROOT}/${relative(temporaryRoot, value)
                .split(sep)
                .join("/")}`
          : value,
    ]),
  );
  const executorStatePaths = [
    "${EXECUTOR_STATE_ROOT}/executor-home",
    "${EXECUTOR_STATE_ROOT}/executor-tmp",
  ];
  return {
    schema_version: 1,
    kind: "selenium-isolated-executor-policy",
    executor_id: executorId,
    candidate_code: EXECUTOR_CANDIDATE_CODE,
    candidate_digest: plan.candidate_digest,
    repository_revision: plan.repository.revision,
    plan_digest: hash(plan),
    authority: {
      github_api_permission: executorAuthority.github_api_permission,
      identity_digest: executorAuthority.identity_digest,
      kind: executorAuthority.kind,
      public_key_digest: hash(executorAuthority.public_key),
    },
    tools: structuredClone(executorTools),
    tools_digest: hash(executorTools),
    runner: structuredClone(plan.runner),
    isolation: {
      disposable: true,
      github_api_access: false,
      network: EXECUTOR_NETWORK,
      privileges: "unprivileged",
      repository_write_access: false,
      secrets: "none",
    },
    environment: {
      inherit_host: false,
      variables: policyEnvironment,
    },
    filesystem: {
      source_materialization: {
        digest: plan.workspace.source_materialization.manifest_digest,
        repository_revision: plan.repository.revision,
      },
      mutable_seed: {
        access: "read-write",
        digest: plan.workspace.mutable_seed.manifest_digest,
        repository_revision: plan.repository.revision,
      },
      immutable_inputs: {
        access: "read-only",
        digest: immutableInputsDigest,
        manifest_digest:
          plan.workspace.immutable_inputs.manifest_digest,
        repository_revision: plan.repository.revision,
      },
      partition_digest: plan.workspace.partition_digest,
      mutable_paths: {
        executor_state: executorStatePaths,
        repository: [...mutablePaths],
      },
      mutable_paths_digest: hash({
        executor_state: executorStatePaths,
        repository: mutablePaths,
      }),
    },
  };
}

function assertFreshExecutionRequest(request, now) {
  const issuedAt = timestampMilliseconds(
    request.issued_at,
    "Selenium executor request issued_at",
  );
  const expiresAt = timestampMilliseconds(
    request.expires_at,
    "Selenium executor request expires_at",
  );
  const observedAt = now instanceof Date ? now.getTime() : Date.parse(now);
  if (
    !Number.isFinite(observedAt) ||
    issuedAt >= expiresAt ||
    expiresAt - issuedAt > MAX_REQUEST_LIFETIME_MS ||
    observedAt < issuedAt ||
    observedAt >= expiresAt
  ) {
    throw new Error("Selenium executor request is stale or not yet valid");
  }
}

function executionRequest(policy, freshness, now) {
  assertExactObjectKeys(
    freshness,
    new Set(["challenge", "expires_at", "issued_at", "run_id"]),
    "Selenium executor request freshness",
  );
  if (
    typeof freshness.challenge !== "string" ||
    !CHALLENGE_PATTERN.test(freshness.challenge)
  ) {
    throw new Error(
      "Selenium executor challenge must be 64 lowercase hexadecimal characters",
    );
  }
  if (
    typeof freshness.run_id !== "string" ||
    !RUN_ID_PATTERN.test(freshness.run_id)
  ) {
    throw new Error(
      "Selenium executor run_id must be a bounded deterministic identifier",
    );
  }
  const request = {
    schema_version: 1,
    kind: "selenium-executor-request",
    authority_digest: hash(policy.authority),
    challenge: freshness.challenge,
    run_id: freshness.run_id,
    issued_at: freshness.issued_at,
    expires_at: freshness.expires_at,
    executor_id: policy.executor_id,
    candidate_digest: policy.candidate_digest,
    repository_revision: policy.repository_revision,
    plan_digest: policy.plan_digest,
    policy_digest: hash(policy),
    immutable_inputs_digest:
      policy.filesystem.immutable_inputs.digest,
    source_materialization_digest:
      policy.filesystem.source_materialization.digest,
    mutable_seed_digest:
      policy.filesystem.mutable_seed.digest,
    trusted_inputs_digest:
      policy.filesystem.immutable_inputs.manifest_digest,
    workspace_partition_digest:
      policy.filesystem.partition_digest,
    mutable_paths_digest: policy.filesystem.mutable_paths_digest,
    tools_digest: policy.tools_digest,
  };
  const bound = {
    ...request,
    request_digest: hash(request),
  };
  assertFreshExecutionRequest(bound, now);
  return bound;
}

function stepExecutableIdentity(step, policy) {
  if (step.tool === "node") {
    return policy.tools.node;
  }
  if (step.tool === "npm") {
    return {
      node: policy.tools.node,
      npm: policy.tools.npm,
    };
  }
  if (step.kind === "browser-identity") {
    return policy.runner.browser;
  }
  if (step.kind === "driver-identity") {
    return policy.runner.driver;
  }
  throw new Error(`${step.id} has no bound executor identity`);
}

export function createSeleniumExecutorAttestation({
  environment,
  execution,
  result,
  step,
} = {}) {
  const request = assertObject(
    execution?.request,
    "Selenium executor attestation request",
  );
  const policy = assertObject(
    execution?.policy,
    "Selenium executor attestation policy",
  );
  if (
    hash(policy) !== request.policy_digest ||
    policy.executor_id !== request.executor_id ||
    policy.candidate_code !== EXECUTOR_CANDIDATE_CODE ||
    policy.isolation?.network !== EXECUTOR_NETWORK
  ) {
    throw new Error(
      "Selenium executor attestation policy does not bind its request",
    );
  }
  const raw = assertRawCommandResult(result, step?.id ?? "unknown step");
  return {
    schema_version: 1,
    kind: "selenium-executor-attestation",
    authority_digest: request.authority_digest,
    challenge: request.challenge,
    run_id: request.run_id,
    issued_at: request.issued_at,
    expires_at: request.expires_at,
    executor_id: request.executor_id,
    candidate_code: policy.candidate_code,
    candidate_digest: request.candidate_digest,
    repository_revision: request.repository_revision,
    plan_digest: request.plan_digest,
    policy_digest: request.policy_digest,
    request_digest: request.request_digest,
    immutable_inputs_digest: request.immutable_inputs_digest,
    source_materialization_digest:
      request.source_materialization_digest,
    mutable_seed_digest: request.mutable_seed_digest,
    trusted_inputs_digest: request.trusted_inputs_digest,
    workspace_partition_digest: request.workspace_partition_digest,
    mutable_paths_digest: request.mutable_paths_digest,
    tools_digest: request.tools_digest,
    step_id: step.id,
    step_digest: hash(step),
    working_directory: step.cwd,
    environment_digest: hash(environment),
    executable_identity_digest: hash(
      stepExecutableIdentity(step, policy),
    ),
    result_digest: hash(raw),
    isolation: structuredClone(policy.isolation),
  };
}

export function signSeleniumExecutorAttestation(
  attestation,
  privateKey,
) {
  assertObject(attestation, "Selenium executor attestation");
  if ("signature" in attestation) {
    throw new Error("Selenium executor attestation is already signed");
  }
  return {
    ...structuredClone(attestation),
    signature: createSignature(
      null,
      Buffer.from(stableJson(attestation)),
      privateKey,
    ).toString("base64"),
  };
}

function signatureFor(value, privateKey) {
  return createSignature(
    null,
    Buffer.from(stableJson(value)),
    privateKey,
  ).toString("base64");
}

function verifyEd25519Signature(value, signature, publicKey) {
  if (
    typeof signature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)
  ) {
    return false;
  }
  const bytes = Buffer.from(signature, "base64");
  if (bytes.toString("base64") !== signature) {
    return false;
  }
  return verifySignature(
    null,
    Buffer.from(stableJson(value)),
    createPublicKey(publicKey),
    bytes,
  );
}

export function signSeleniumQualificationEnvelope(
  envelope,
  privateKey,
) {
  assertObject(envelope, "Selenium qualification envelope");
  if ("signature" in envelope) {
    throw new Error("Selenium qualification envelope is already signed");
  }
  return {
    ...structuredClone(envelope),
    signature: signatureFor(envelope, privateKey),
  };
}

function validateExecutorAttestation(
  attestation,
  {
    authority,
    environment,
    environmentDigest,
    policy,
    raw,
    request,
    step,
  },
) {
  const keys = new Set([
    "authority_digest",
    "candidate_code",
    "candidate_digest",
    "challenge",
    "expires_at",
    "environment_digest",
    "executable_identity_digest",
    "executor_id",
    "immutable_inputs_digest",
    "issued_at",
    "isolation",
    "kind",
    "mutable_paths_digest",
    "mutable_seed_digest",
    "plan_digest",
    "policy_digest",
    "repository_revision",
    "request_digest",
    "result_digest",
    "run_id",
    "schema_version",
    "signature",
    "source_materialization_digest",
    "step_digest",
    "step_id",
    "tools_digest",
    "trusted_inputs_digest",
    "workspace_partition_digest",
    "working_directory",
  ]);
  assertExactObjectKeys(
    attestation,
    keys,
    `${step.id} executor attestation`,
  );
  assertExactObjectKeys(
    attestation.isolation,
    new Set([
      "disposable",
      "github_api_access",
      "network",
      "privileges",
      "repository_write_access",
      "secrets",
    ]),
    `${step.id} executor attestation isolation`,
  );
  const expected = {
    schema_version: 1,
    kind: "selenium-executor-attestation",
    authority_digest: request.authority_digest,
    challenge: request.challenge,
    run_id: request.run_id,
    issued_at: request.issued_at,
    expires_at: request.expires_at,
    executor_id: request.executor_id,
    candidate_code: EXECUTOR_CANDIDATE_CODE,
    candidate_digest: request.candidate_digest,
    repository_revision: request.repository_revision,
    plan_digest: request.plan_digest,
    policy_digest: request.policy_digest,
    request_digest: request.request_digest,
    immutable_inputs_digest: request.immutable_inputs_digest,
    source_materialization_digest:
      request.source_materialization_digest,
    mutable_seed_digest: request.mutable_seed_digest,
    trusted_inputs_digest: request.trusted_inputs_digest,
    workspace_partition_digest: request.workspace_partition_digest,
    mutable_paths_digest: request.mutable_paths_digest,
    tools_digest: request.tools_digest,
    step_id: step.id,
    step_digest: hash(step),
    working_directory: step.cwd,
    environment_digest: environmentDigest ?? hash(environment),
    executable_identity_digest: hash(
      stepExecutableIdentity(step, policy),
    ),
    result_digest: hash(raw),
    isolation: {
      disposable: true,
      github_api_access: false,
      network: EXECUTOR_NETWORK,
      privileges: "unprivileged",
      repository_write_access: false,
      secrets: "none",
    },
  };
  const { signature, ...unsigned } = attestation;
  if (
    stableJson(unsigned) !== stableJson(expected) ||
    !verifyEd25519Signature(expected, signature, authority.public_key)
  ) {
    throw new Error(`${step.id} executor attestation is not exactly bound`);
  }
  return structuredClone(attestation);
}

function executorAttestationEvidence(
  attestation,
  plan,
  startedAt,
  completedAt,
) {
  return {
    type: "qualification-executor-attestation",
    locator: `selenium-executor:${attestation.executor_id}/${attestation.step_id}`,
    revision: plan.repository.revision,
    digest: hash(attestation),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

function executorAttestationSetEvidence(
  attestations,
  plan,
  request,
  startedAt,
  completedAt,
) {
  return {
    type: "qualification-executor-attestation-set",
    locator: `selenium-executor-set:${request.request_digest}`,
    revision: plan.repository.revision,
    digest: hash({
      attestations: attestations
        .map((attestation) => ({
          digest: hash(attestation),
          step_id: attestation.step_id,
        }))
        .sort(({ step_id: left }, { step_id: right }) =>
          compareText(left, right)),
      candidate_digest: plan.candidate_digest,
      expected_step_ids: plan.steps.map(({ id }) => id).sort(compareText),
      expires_at: request.expires_at,
      issued_at: request.issued_at,
      request_digest: request.request_digest,
      run_id: request.run_id,
      source_materialization_digest:
        request.source_materialization_digest,
      mutable_seed_digest: request.mutable_seed_digest,
      trusted_inputs_digest: request.trusted_inputs_digest,
      workspace_partition_digest:
        request.workspace_partition_digest,
    }),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

async function verifyExecutableIdentity(
  identity,
  { requireExecutable = true } = {},
) {
  const observedRealpath = await realpath(identity.path);
  const canonicalRealpath = await realpath(identity.realpath);
  if (
    observedRealpath !== identity.realpath ||
    canonicalRealpath !== identity.realpath
  ) {
    throw new Error(
      `${identity.kind} executable realpath does not match runner evidence`,
    );
  }
  const metadata = await lstat(identity.realpath);
  if (
    !metadata.isFile() ||
    (requireExecutable && (metadata.mode & 0o111) === 0)
  ) {
    throw new Error(
      `${identity.kind ?? identity.name} executable identity is invalid`,
    );
  }
  const expectedDigest = identity.executable_digest ?? identity.digest;
  const cacheKey = stableJson({
    ctime_ms: metadata.ctimeMs,
    device: metadata.dev,
    expected_digest: expectedDigest,
    inode: metadata.ino,
    mode: metadata.mode,
    mtime_ms: metadata.mtimeMs,
    path: identity.realpath,
    size: metadata.size,
  });
  let observedDigest = executableDigestCache.get(cacheKey);
  if (observedDigest === undefined) {
    observedDigest = hash(await readFile(identity.realpath));
    executableDigestCache.set(cacheKey, observedDigest);
  }
  if (observedDigest !== expectedDigest) {
    throw new Error(
      `${identity.kind} executable digest does not match runner evidence`,
    );
  }
}

function exactExecutableVersion(kind, output, identity) {
  if (kind === "node") {
    return output === `v${identity.version}\n` ||
      output === `v${identity.version}\r\n`;
  }
  if (kind === "npm") {
    return output === `${identity.version}\n` ||
      output === `${identity.version}\r\n`;
  }
  const labels = {
    browser: { chromium: "Chromium" },
    driver: { chromedriver: "ChromeDriver" },
  };
  const label = labels[kind]?.[identity.name];
  if (label === undefined) {
    throw new Error(`Unsupported ${kind} executable identity ${identity.name}`);
  }
  const match = new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} ([0-9]+(?:\\.[0-9]+){2,3})\\r?\\n?$`,
    "u",
  ).exec(output);
  if (match === null) {
    throw new Error(`${kind} executable version output is not exact`);
  }
  return (
    parseBrowserVersion(match[1], `${kind} executable version`) ===
    identity.version
  );
}

function controlledStepPassed(step, raw, policy) {
  if (raw.exitCode !== 0) {
    return false;
  }
  try {
    if (step.kind === "node-identity") {
      return exactExecutableVersion(
        "node",
        raw.stdout,
        policy.tools.node,
      );
    }
    if (step.kind === "npm-identity") {
      return exactExecutableVersion(
        "npm",
        raw.stdout,
        policy.tools.npm,
      );
    }
    if (step.kind === "browser-identity") {
      return exactExecutableVersion(
        "browser",
        raw.stdout,
        policy.runner.browser,
      );
    }
    if (step.kind === "driver-identity") {
      return exactExecutableVersion(
        "driver",
        raw.stdout,
        policy.runner.driver,
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyStepToolBinding(step, policy) {
  if (step.tool === "node") {
    if (step.command !== policy.tools.node.realpath) {
      throw new Error(`${step.id} does not use the measured Node realpath`);
    }
    await verifyExecutableIdentity(policy.tools.node);
    return;
  }
  if (step.tool === "npm") {
    if (
      step.command !== policy.tools.node.realpath ||
      step.arguments[0] !== policy.tools.npm.realpath
    ) {
      throw new Error(
        `${step.id} does not use the measured Node and npm realpaths`,
      );
    }
    await Promise.all([
      verifyExecutableIdentity(policy.tools.node),
      verifyExecutableIdentity(policy.tools.npm, {
        requireExecutable: false,
      }),
    ]);
    return;
  }
  if (
    step.kind !== "browser-identity" &&
    step.kind !== "driver-identity"
  ) {
    throw new Error(`${step.id} does not declare a measured executable`);
  }
}

async function verifyExecutorToolIdentities(tools, environment) {
  await Promise.all([
    verifyExecutableIdentity(tools.node),
    verifyExecutableIdentity(tools.npm, { requireExecutable: false }),
  ]);
  const options = {
    encoding: "utf8",
    env: environment,
    maxBuffer: 1024 * 1024,
  };
  const [{ stdout: nodeVersion }, { stdout: npmVersion }] =
    await Promise.all([
      execFileAsync(tools.node.realpath, ["--version"], options),
      execFileAsync(
        tools.node.realpath,
        [tools.npm.realpath, "--version"],
        options,
      ),
    ]);
  if (
    !exactExecutableVersion("node", nodeVersion, tools.node) ||
    !exactExecutableVersion("npm", npmVersion, tools.npm)
  ) {
    throw new Error(
      "Selenium executor Node or npm version does not match its measured identity",
    );
  }
}

async function executeControlledStep(
  step,
  plan,
  {
    attestations,
    baseEnvironment,
    executor,
    executions,
    now,
    policy,
    request,
    workspaceRoot,
  },
) {
  const startedValue = now();
  assertFreshExecutionRequest(request, startedValue);
  const startedAt = timestamp(startedValue);
  let attestation = null;
  let attestedRaw = null;
  let commandOutput = "";
  let raw;
  const identity =
    step.kind === "browser-identity"
      ? plan.runner.browser
      : step.kind === "driver-identity"
        ? plan.runner.driver
        : null;
  try {
    await verifyStepToolBinding(step, policy);
    if (identity !== null) {
      if (step.command !== identity.realpath) {
        throw new Error(
          `${identity.kind} command does not match observed executable realpath`,
        );
      }
      await verifyExecutableIdentity(identity);
    }
    const controlledEnvironment = {
      ...baseEnvironment,
      ...step.environment,
      GITHUB_WORKSPACE: workspaceRoot,
    };
    const response = await executor.execute(structuredClone(step), {
      environment: controlledEnvironment,
      execution: {
        policy: structuredClone(policy),
        request: structuredClone(request),
      },
      cwd: resolve(workspaceRoot, step.cwd),
      packageRoot: resolve(workspaceRoot, SELENIUM_PACKAGE_DIRECTORY),
      workspaceRoot,
    });
    assertExactObjectKeys(
      response,
      new Set(["attestation", "result"]),
      `${step.id} executor response`,
    );
    raw = assertRawCommandResult(
      response.result,
      step.id,
    );
    attestedRaw = structuredClone(raw);
    commandOutput = `${raw.stdout}${raw.stderr}`;
    attestation = validateExecutorAttestation(
      response.attestation,
      {
        authority: executor.authority,
        environment: controlledEnvironment,
        policy,
        raw,
        request,
        step,
      },
    );
    attestations.push(attestation);
  } catch (error) {
    raw = {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: error.message,
    };
  }
  if (raw.exitCode === 0) {
    try {
      await verifyStepToolBinding(step, policy);
      if (identity !== null) {
        await verifyExecutableIdentity(identity);
      }
    } catch (error) {
      raw = {
        ...raw,
        exitCode: 1,
        stderr: `${raw.stderr}${error.message}`,
      };
    }
  }
  const completedValue = now();
  try {
    assertFreshExecutionRequest(request, completedValue);
  } catch (error) {
    raw = {
      ...raw,
      exitCode: 1,
      stderr: `${raw.stderr}${error.message}`,
    };
  }
  const completedAt = timestamp(completedValue);
  const check = {
    id: step.id,
    phase: step.phase,
    capability_id: step.capability_id,
    scenario: step.scenario,
    status: controlledStepPassed(step, raw, policy) ? "pass" : "fail",
    warnings: sortedUnique(warningLines(commandOutput)),
    evidence: [
      commandEvidence(step, plan, raw, startedAt, completedAt),
      ...(attestation === null
        ? []
        : [
            executorAttestationEvidence(
              attestation,
              plan,
              startedAt,
              completedAt,
            ),
          ]),
    ],
  };
  executions.push({
    step_id: step.id,
    started_at: startedAt,
    completed_at: completedAt,
    environment_digest:
      attestation?.environment_digest ?? null,
    result: attestedRaw,
    check_result: structuredClone(raw),
    attestation:
      attestation === null ? null : structuredClone(attestation),
  });
  return check;
}

function lockPackage(lock, name) {
  return lock.packages?.[`node_modules/${name}`];
}

function normalizeLockPackagePath(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a canonical relative package path`);
  }
  return value;
}

function packageNameFromLockPath(path, entry, label) {
  if (entry.name !== undefined) {
    return assertString(entry.name, `${label}.name`);
  }
  const marker = "node_modules/";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`${label}.name is required outside node_modules`);
  }
  const remainder = path.slice(markerIndex + marker.length);
  const parts = remainder.split("/");
  const name = parts[0]?.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  return assertString(name, `${label} derived name`);
}

function optionalLockString(value, label) {
  return value === undefined ? null : assertString(value, label);
}

function isInstalledLockPath(path) {
  return path.startsWith("node_modules/") ||
    path.includes("/node_modules/");
}

function canonicalPackageLockClosure(lock, label = "generated package-lock") {
  const document = assertObject(lock, label);
  const lockfileVersion = document.lockfileVersion;
  if (
    !Number.isInteger(lockfileVersion) ||
    lockfileVersion < 2 ||
    lockfileVersion > 3
  ) {
    throw new Error(`${label}.lockfileVersion must be 2 or 3`);
  }
  const packages = assertObject(document.packages, `${label}.packages`);
  const entries = Object.entries(packages)
    .map(([rawPath, rawEntry]) => {
      const path = normalizeLockPackagePath(
        rawPath,
        `${label} package path`,
      );
      const entry = assertObject(
        rawEntry,
        `${label}.packages[${JSON.stringify(path)}]`,
      );
      if (
        entry.link !== undefined &&
        typeof entry.link !== "boolean"
      ) {
        throw new Error(`${label} ${path || "<root>"} link must be boolean`);
      }
      const link = entry.link === true;
      const version = optionalLockString(
        entry.version,
        `${label} ${path || "<root>"} version`,
      );
      const resolved = optionalLockString(
        entry.resolved,
        `${label} ${path || "<root>"} resolved`,
      );
      const integrity = optionalLockString(
        entry.integrity,
        `${label} ${path || "<root>"} integrity`,
      );
      if (isInstalledLockPath(path) && !link && version === null) {
        throw new Error(
          `${label} installed package ${path} must declare a version`,
        );
      }
      if (link && resolved === null) {
        throw new Error(
          `${label} linked package ${path} must declare its target`,
        );
      }
      return {
        path,
        name: packageNameFromLockPath(
          path,
          entry,
          `${label}.packages[${JSON.stringify(path)}]`,
        ),
        version,
        resolved,
        integrity,
        link,
      };
    })
    .sort(({ path: left }, { path: right }) => compareText(left, right));
  if (entries.length === 0 || entries[0].path !== "") {
    throw new Error(`${label} must contain its root package entry`);
  }
  return {
    schema_version: 1,
    kind: LOCK_CLOSURE_MANIFEST_KIND,
    lockfile_version: lockfileVersion,
    packages: entries,
  };
}

function packageDependencyRecords(entry) {
  return [
    ["dependencies", true],
    ["devDependencies", true],
    ["optionalDependencies", false],
    ["peerDependencies", false],
  ].flatMap(([field, required]) => {
    const dependencies = entry[field];
    if (dependencies === undefined) {
      return [];
    }
    return Object.keys(
      assertObject(dependencies, `package-lock entry ${field}`),
    ).map((name) => ({ name, required }));
  }).sort(({ name: left }, { name: right }) => compareText(left, right));
}

function packageAncestorPaths(path) {
  const ancestors = [path];
  let current = path;
  while (current.includes("node_modules/")) {
    const marker = current.lastIndexOf("node_modules/");
    current = current.slice(0, marker).replace(/\/$/u, "");
    ancestors.push(current);
  }
  if (!ancestors.includes("")) {
    ancestors.push("");
  }
  return ancestors;
}

function dependencyLockPath(packages, fromPath, dependencyName) {
  for (const ancestor of packageAncestorPaths(fromPath)) {
    const candidate = `${ancestor === "" ? "" : `${ancestor}/`}node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) {
      return candidate;
    }
  }
  return null;
}

function workspacePatterns(rootEntry) {
  const raw = rootEntry.workspaces;
  const patterns = Array.isArray(raw)
    ? raw
    : raw === undefined
      ? []
      : assertObject(raw, "package-lock root workspaces").packages;
  if (!Array.isArray(patterns)) {
    throw new Error("package-lock root workspaces must be an array");
  }
  return patterns.map((pattern) => {
    assertString(pattern, "package-lock workspace pattern");
    if (
      pattern.includes("\\") ||
      pattern.startsWith("/") ||
      pattern.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(
        "package-lock workspace patterns must be canonical relative paths",
      );
    }
    return pattern;
  });
}

function workspacePatternMatches(pattern, path) {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  function matches(patternIndex, pathIndex) {
    if (patternIndex === patternParts.length) {
      return pathIndex === pathParts.length;
    }
    const part = patternParts[patternIndex];
    if (part === "**") {
      return matches(patternIndex + 1, pathIndex) ||
        (pathIndex < pathParts.length &&
          matches(patternIndex, pathIndex + 1));
    }
    if (pathIndex >= pathParts.length) {
      return false;
    }
    return (
      (part === "*" || part === pathParts[pathIndex]) &&
      matches(patternIndex + 1, pathIndex + 1)
    );
  }
  return matches(0, 0);
}

function validateReachableLockClosure(lock, manifest) {
  const packages = lock.packages;
  const reachable = new Set([""]);
  const queue = [""];
  const patterns = workspacePatterns(packages[""]);
  for (const [path, entry] of Object.entries(packages)) {
    if (
      path !== "" &&
      !isInstalledLockPath(path) &&
      patterns.some((pattern) => workspacePatternMatches(pattern, path))
    ) {
      reachable.add(path);
      queue.push(path);
      for (const [linkPath, linkEntry] of Object.entries(packages)) {
        if (linkEntry.link === true && linkEntry.resolved === path) {
          reachable.add(linkPath);
          queue.push(linkPath);
        }
      }
    }
  }
  while (queue.length > 0) {
    const path = queue.shift();
    const entry = packages[path];
    for (const { name: dependencyName, required } of
      packageDependencyRecords(entry)) {
      const dependencyPath = dependencyLockPath(
        packages,
        path,
        dependencyName,
      );
      if (dependencyPath === null && required) {
        throw new Error(
          `Generated package-lock lacks required dependency ${dependencyName} from ${path || "<root>"}`,
        );
      }
      if (dependencyPath !== null && !reachable.has(dependencyPath)) {
        reachable.add(dependencyPath);
        queue.push(dependencyPath);
      }
    }
    if (entry.link === true) {
      const target = normalizeLockPackagePath(
        assertString(entry.resolved, `linked package ${path} target`),
        `linked package ${path} target`,
      );
      if (!Object.hasOwn(packages, target)) {
        throw new Error(`Linked package ${path} target is absent from lock`);
      }
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const unreachable = manifest.packages
    .filter(({ path }) => path !== "" && !reachable.has(path))
    .map(({ path }) => path);
  if (unreachable.length > 0) {
    throw new Error(
      `Generated package-lock contains unreachable package entries: ${unreachable.join(", ")}`,
    );
  }
}

function generatedLockClosureUnsigned({
  applyAttestation,
  capturedAt,
  lock,
  lockByteDigest,
  plan,
  policy,
  request,
}) {
  const canonicalLock = stableValue(lock);
  const closureManifest = canonicalPackageLockClosure(canonicalLock);
  validateReachableLockClosure(canonicalLock, closureManifest);
  return {
    schema_version: 1,
    kind: GENERATED_LOCK_CLOSURE_KIND,
    authority_digest: request.authority_digest,
    candidate_digest: plan.candidate_digest,
    repository_revision: plan.repository.revision,
    plan_digest: hash(plan),
    policy_digest: hash(policy),
    request_digest: request.request_digest,
    apply_attestation_digest: hash(applyAttestation),
    captured_at: capturedAt,
    lock_byte_digest: assertDigest(
      lockByteDigest,
      "Selenium generated lock byte digest",
    ),
    lock_canonical_digest: hash(canonicalLock),
    closure_digest: hash(closureManifest),
    canonical_lock: canonicalLock,
    closure_manifest: closureManifest,
  };
}

function validateGeneratedLockClosure(
  signedClosure,
  {
    applyAttestation,
    authority,
    plan,
    policy,
    request,
  },
) {
  assertExactObjectKeys(
    signedClosure,
    new Set([
      "apply_attestation_digest",
      "authority_digest",
      "candidate_digest",
      "canonical_lock",
      "captured_at",
      "closure_digest",
      "closure_manifest",
      "kind",
      "lock_byte_digest",
      "lock_canonical_digest",
      "plan_digest",
      "policy_digest",
      "repository_revision",
      "request_digest",
      "schema_version",
      "signature",
    ]),
    "Selenium generated lock closure",
  );
  const { signature, ...unsigned } = signedClosure;
  const expected = generatedLockClosureUnsigned({
    applyAttestation,
    capturedAt: signedClosure.captured_at,
    lock: signedClosure.canonical_lock,
    lockByteDigest: signedClosure.lock_byte_digest,
    plan,
    policy,
    request,
  });
  assertArtifactTimeWithinRequest(
    signedClosure.captured_at,
    signedClosure.captured_at,
    request,
    "Selenium generated lock closure",
  );
  if (
    stableJson(unsigned) !== stableJson(expected) ||
    !verifyEd25519Signature(unsigned, signature, authority.public_key)
  ) {
    throw new Error(
      "Selenium generated lock closure is missing, stale, tampered, or unsigned",
    );
  }
  return structuredClone(signedClosure);
}

async function captureGeneratedLockClosure(
  plan,
  workspaceRoot,
  {
    applyAttestation,
    executor,
    now,
    policy,
    request,
  },
) {
  const lockBytes = await readFile(resolve(workspaceRoot, LOCK_PATH));
  const lock = parseJson(lockBytes, LOCK_PATH);
  const unsigned = generatedLockClosureUnsigned({
    applyAttestation,
    capturedAt: timestamp(now()),
    lock,
    lockByteDigest: hash(lockBytes),
    plan,
    policy,
    request,
  });
  const signed = await executor.seal(structuredClone(unsigned));
  return validateGeneratedLockClosure(signed, {
    applyAttestation,
    authority: executor.authority,
    plan,
    policy,
    request,
  });
}

async function verifyAppliedLock(plan, workspaceRoot) {
  const [manifest, lock] = await Promise.all([
    readFile(resolve(workspaceRoot, PACKAGE_PATH), "utf8").then(
      (value) => parseJson(value, PACKAGE_PATH),
    ),
    readFile(resolve(workspaceRoot, LOCK_PATH), "utf8").then(
      (value) => parseJson(value, LOCK_PATH),
    ),
  ]);
  const root = assertObject(
    lock.packages?.[""],
    'candidate package-lock packages[""]',
  );
  const expectedDirectDependencies = Object.fromEntries(
    plan.packages
      .filter(({ name }) => DIRECT_PACKAGE_NAMES.includes(name))
      .map(({ name, version }) => [name, version])
      .sort(([left], [right]) => compareText(left, right)),
  );
  if (
    stableJson(manifest.dependencies) !==
      stableJson(expectedDirectDependencies) ||
    stableJson(root.dependencies) !==
      stableJson(expectedDirectDependencies)
  ) {
    throw new Error(
      "Candidate manifest and lock root dependencies must exactly match the selected direct packages",
    );
  }
  for (const expected of plan.packages) {
    const direct = DIRECT_PACKAGE_NAMES.includes(expected.name);
    if (
      direct &&
      (manifest.dependencies?.[expected.name] !== expected.version ||
        root.dependencies?.[expected.name] !== expected.version)
    ) {
      throw new Error(
        `Candidate manifest and lock must pin ${expected.name}@${expected.version}`,
      );
    }
    const installed = assertObject(
      lockPackage(lock, expected.name),
      `candidate lock ${expected.name}`,
    );
    for (const [key, value] of [
      ["version", expected.version],
      ["resolved", expected.dist.tarball],
      ["integrity", expected.dist.integrity],
    ]) {
      if (installed[key] !== value) {
        throw new Error(
          `Candidate lock ${expected.name}.${key} does not match immutable npm evidence`,
        );
      }
    }
    if (
      normalizeSemverRange(
        installed.engines?.node,
        `${expected.name} applied Node range`,
      ) !== expected.engines.node
    ) {
      throw new Error(
        `Candidate lock ${expected.name} Node range does not match npm evidence`,
      );
    }
    if (expected.name === AXE_PACKAGE) {
      if (
        normalizeSemverRange(
          installed.dependencies?.["axe-core"],
          "applied axe-core range",
        ) !== expected.dependencies["axe-core"] ||
        normalizeSemverRange(
          installed.peerDependencies?.["selenium-webdriver"],
          "applied Selenium peer range",
        ) !== expected.peerDependencies["selenium-webdriver"]
      ) {
        throw new Error(
          "Candidate axe dependency ranges do not match immutable npm evidence",
        );
      }
    }
  }
  const axeWebdriver = plan.packages.find(
    ({ name }) => name === AXE_PACKAGE,
  );
  const axeCore = plan.packages.find(
    ({ name }) => name === AXE_CORE_PACKAGE,
  );
  if (
    !semverRangeSatisfies(
      axeCore.version,
      axeWebdriver.dependencies[AXE_CORE_PACKAGE],
    )
  ) {
    throw new Error(
      "Candidate axe-core does not satisfy @axe-core/webdriverjs",
    );
  }
}

async function discoverInstalledPackagePaths(
  packageRoot,
  workspacePackagePaths,
) {
  const discovered = [];
  async function visit(nodeModulesPath, relativeNodeModulesPath) {
    const entries = await readdir(nodeModulesPath, { withFileTypes: true });
    for (const entry of entries.sort(({ name: left }, { name: right }) =>
      compareText(left, right))) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") {
        continue;
      }
      if (entry.name.startsWith("@")) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`Installed scope ${entry.name} must be a directory`);
        }
        const scopePath = join(nodeModulesPath, entry.name);
        const scopedEntries = await readdir(scopePath, {
          withFileTypes: true,
        });
        for (const scoped of scopedEntries.sort(
          ({ name: left }, { name: right }) => compareText(left, right),
        )) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) {
            throw new Error(
              `Installed scoped package ${entry.name}/${scoped.name} has unsupported type`,
            );
          }
          const packagePath =
            `${relativeNodeModulesPath}/${entry.name}/${scoped.name}`;
          discovered.push(packagePath);
          if (scoped.isDirectory() && !scoped.isSymbolicLink()) {
            const nested = join(scopePath, scoped.name, "node_modules");
            try {
              await visit(nested, `${packagePath}/node_modules`);
            } catch (error) {
              if (error.code !== "ENOENT") {
                throw error;
              }
            }
          }
        }
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error(
          `Installed node_modules entry ${entry.name} has unsupported type`,
        );
      }
      const packagePath = `${relativeNodeModulesPath}/${entry.name}`;
      discovered.push(packagePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const nested = join(nodeModulesPath, entry.name, "node_modules");
        try {
          await visit(nested, `${packagePath}/node_modules`);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  }
  await visit(join(packageRoot, "node_modules"), "node_modules");
  for (const workspacePath of workspacePackagePaths) {
    const nested = join(
      packageRoot,
      ...workspacePath.split("/"),
      "node_modules",
    );
    try {
      await visit(nested, `${workspacePath}/node_modules`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return discovered.sort(compareText);
}

async function verifyInstalledPackages(lockClosure, workspaceRoot) {
  const packageRoot = resolve(
    workspaceRoot,
    SELENIUM_PACKAGE_DIRECTORY,
  );
  const currentLockBytes = await readFile(resolve(workspaceRoot, LOCK_PATH));
  const currentLock = parseJson(currentLockBytes, LOCK_PATH);
  const currentClosure = canonicalPackageLockClosure(currentLock);
  if (
    hash(currentLockBytes) !== lockClosure.lock_byte_digest ||
    hash(stableValue(currentLock)) !== lockClosure.lock_canonical_digest ||
    hash(currentClosure) !== lockClosure.closure_digest ||
    stableJson(currentClosure) !==
      stableJson(lockClosure.closure_manifest)
  ) {
    throw new Error("npm ci changed the signed generated package-lock");
  }

  const hiddenLockPath = join(
    packageRoot,
    "node_modules",
    ".package-lock.json",
  );
  const hiddenLock = parseJson(
    await readFile(hiddenLockPath),
    "installed node_modules/.package-lock.json",
  );
  const expectedHiddenPackages = Object.fromEntries(
    Object.entries(lockClosure.canonical_lock.packages)
      .filter(([path]) => isInstalledLockPath(path))
      .sort(([left], [right]) => compareText(left, right)),
  );
  if (
    stableJson(hiddenLock.packages) !==
      stableJson(expectedHiddenPackages)
  ) {
    throw new Error(
      "Installed hidden lock package entries do not exactly match the signed generated lock",
    );
  }
  const hiddenClosure = canonicalPackageLockClosure({
    ...hiddenLock,
    packages: {
      "": currentLock.packages[""],
      ...hiddenLock.packages,
    },
  }, "installed node_modules hidden lock");
  const expectedInstalled = lockClosure.closure_manifest.packages
    .filter(({ path }) => isInstalledLockPath(path));
  const observedInstalled = hiddenClosure.packages
    .filter(({ path }) => isInstalledLockPath(path));
  if (stableJson(observedInstalled) !== stableJson(expectedInstalled)) {
    throw new Error(
      "Installed hidden lock does not exactly match generated dependency closure",
    );
  }

  const workspacePackagePaths = lockClosure.closure_manifest.packages
    .filter(
      ({ path }) => path !== "" && !isInstalledLockPath(path),
    )
    .map(({ path }) => path);
  const discovered = await discoverInstalledPackagePaths(
    packageRoot,
    workspacePackagePaths,
  );
  const expectedPaths = expectedInstalled.map(({ path }) => path);
  if (stableJson(discovered) !== stableJson(expectedPaths)) {
    throw new Error(
      "Installed node_modules contains extra or missing package entries",
    );
  }
  const byPath = new Map(
    lockClosure.closure_manifest.packages.map((entry) => [
      entry.path,
      entry,
    ]),
  );
  for (const expected of expectedInstalled) {
    const absolute = join(packageRoot, ...expected.path.split("/"));
    const metadata = await lstat(absolute);
    if (expected.link) {
      if (!metadata.isSymbolicLink()) {
        throw new Error(`Installed ${expected.path} must be a link`);
      }
      const target = normalizeLockPackagePath(
        expected.resolved,
        `Installed ${expected.path} link target`,
      );
      const targetEntry = byPath.get(target);
      if (targetEntry === undefined) {
        throw new Error(
          `Installed ${expected.path} link target is absent from closure`,
        );
      }
      const actualTarget = await realpath(absolute);
      const expectedTarget = await realpath(join(packageRoot, ...target.split("/")));
      if (actualTarget !== expectedTarget) {
        throw new Error(`Installed ${expected.path} link target was substituted`);
      }
      const installed = parseJson(
        await readFile(join(absolute, "package.json"), "utf8"),
        `installed ${expected.path}`,
      );
      if (
        installed.name !== targetEntry.name ||
        (targetEntry.version !== null &&
          installed.version !== targetEntry.version)
      ) {
        throw new Error(`Installed ${expected.path} linked package was substituted`);
      }
      continue;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Installed ${expected.path} must be a real directory`);
    }
    const installed = parseJson(
      await readFile(join(absolute, "package.json"), "utf8"),
      `installed ${expected.path}`,
    );
    if (
      installed.name !== expected.name ||
      installed.version !== expected.version
    ) {
      throw new Error(`Installed ${expected.path} package was substituted`);
    }
  }
}

function internalCheckEvidence(
  id,
  plan,
  passed,
  message,
  startedAt,
  completedAt,
  additionalEvidence = [],
) {
  return {
    id,
    phase: "prepare",
    capability_id: null,
    scenario: null,
    status: passed ? "pass" : "fail",
    warnings: [],
    evidence: [
      {
        type: "qualification-check",
        locator: `selenium-check:${id}`,
        revision: plan.repository.revision,
        digest: hash({
          candidate_digest: plan.candidate_digest,
          id,
          message,
          plan_digest: hash(plan),
          runner: plan.runner,
          tools: plan.tools,
          ...workspaceBindingDigests(plan),
        }),
        started_at: startedAt,
        completed_at: completedAt,
      },
      ...additionalEvidence,
    ],
  };
}

function generatedLockClosureEvidence(
  lockClosure,
  plan,
  startedAt,
  completedAt,
) {
  return {
    type: "qualification-npm-lock-closure",
    locator: "selenium-lock:generated-closure",
    revision: plan.repository.revision,
    digest: hash(lockClosure),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

async function runInternalCheck(id, plan, now, callback) {
  const startedAt = timestamp(now());
  try {
    await callback();
    const completedAt = timestamp(now());
    return internalCheckEvidence(
      id,
      plan,
      true,
      "verified",
      startedAt,
      completedAt,
    );
  } catch (error) {
    const completedAt = timestamp(now());
    return internalCheckEvidence(
      id,
      plan,
      false,
      error.message,
      startedAt,
      completedAt,
    );
  }
}

async function filesForPattern(pattern, workspaceRoot) {
  if (!/[*?[\]{}]/u.test(pattern)) {
    return [pattern];
  }
  const matches = [];
  for await (const match of glob(pattern, {
    cwd: workspaceRoot,
    exclude: ["**/node_modules/**"],
  })) {
    matches.push(match.replaceAll("\\", "/"));
  }
  return matches.sort(compareText);
}

async function nonemptyFile(path, workspaceRoot) {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, path);
  if (!isWithin(root, absolute)) {
    throw new Error(`Artifact ${path} escapes the ephemeral workspace`);
  }
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Ephemeral workspace must be a real directory");
  }
  const canonicalRoot = await realpath(root);
  let current = root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`Artifact ${path} must not traverse a symlink`);
    }
  }
  const canonical = await realpath(absolute);
  if (!isWithin(canonicalRoot, canonical)) {
    throw new Error(`Artifact ${path} resolves outside the ephemeral workspace`);
  }
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Artifact ${path} must be a nonempty file`);
  }
  return readFile(canonical);
}

function reportCapabilityId(report) {
  return report.capabilityId ?? report.capability?.id ?? null;
}

async function inspectCapabilityArtifacts(capability, workspaceRoot, plan) {
  const paths = new Set();
  for (const pattern of capability.required_files) {
    const matches = await filesForPattern(pattern, workspaceRoot);
    if (matches.length === 0) {
      throw new Error(`Required artifact pattern matched no files: ${pattern}`);
    }
    matches.forEach((path) => paths.add(path));
  }
  await nonemptyFile(capability.evidence, workspaceRoot);
  paths.add(capability.evidence);
  if (
    capability.result_reports.length !== capability.scenarios.length ||
    new Set(capability.result_reports).size !== capability.result_reports.length
  ) {
    throw new Error(
      `${capability.id} must provide exactly one distinct report per scenario`,
    );
  }
  const actualReportPaths = await filesForPattern(
    `${SELENIUM_PACKAGE_DIRECTORY}/diagnostics/*/result.json`,
    workspaceRoot,
  );
  if (!sameStrings(actualReportPaths, capability.result_reports)) {
    throw new Error(
      `${capability.id} produced reports outside its exact selected scenario set`,
    );
  }
  const observedScenarios = new Set();
  const packageVersions = Object.fromEntries(
    plan.packages.map(({ name, version }) => [name, version]),
  );
  const expectedExecutableIdentities = {
    browser: {
      digest: plan.runner.browser.executable_digest,
      realpath: plan.runner.browser.realpath,
      version: plan.runner.browser.version,
    },
    driver: {
      digest: plan.runner.driver.executable_digest,
      realpath: plan.runner.driver.realpath,
      version: plan.runner.driver.version,
    },
  };
  for (const [index, reportPath] of capability.result_reports.entries()) {
    const expectedScenario = capability.scenarios[index];
    const expectedPath =
      `${SELENIUM_PACKAGE_DIRECTORY}/diagnostics/${expectedScenario}/result.json`;
    if (reportPath !== expectedPath) {
      throw new Error(
        `Result report ${reportPath} does not match scenario ${expectedScenario}`,
      );
    }
    const report = parseJson(
      await nonemptyFile(reportPath, workspaceRoot),
      reportPath,
    );
    if (
      report.schemaVersion !== 1 ||
      reportCapabilityId(report) !== capability.id ||
      report.scenario !== expectedScenario ||
      report.status !== "passed" ||
      report.assertion?.status !== "passed"
    ) {
      throw new Error(
        `Result report ${reportPath} did not pass for ${capability.id}`,
      );
    }
    if (
      report.tool?.name !== "selenium" ||
      report.tool?.version !== packageVersions[SELENIUM_PACKAGE] ||
      report.tool?.accessibility?.integration !== AXE_PACKAGE ||
      report.tool?.accessibility?.integrationVersion !==
        packageVersions[AXE_PACKAGE] ||
      report.tool?.accessibility?.engine !== AXE_CORE_PACKAGE ||
      report.tool?.accessibility?.engineVersion !==
        packageVersions[AXE_CORE_PACKAGE] ||
      report.environment?.browserVersion !== plan.runner.browser.version ||
      report.environment?.driverVersion !== plan.runner.driver.version ||
      stableJson(report.environment?.browserExecutable) !==
        stableJson(expectedExecutableIdentities.browser) ||
      stableJson(report.environment?.driverExecutable) !==
        stableJson(expectedExecutableIdentities.driver)
    ) {
      throw new Error(
        `Result report ${reportPath} does not bind exact package and runner identities`,
      );
    }
    const expectedAssertion =
      expectedScenario === "smoke"
        ? {
            actual: "clicked",
            expected: "clicked",
            name: "selenium smoke button state",
          }
        : {
            actual: "238",
            expected: "238",
            name: "web-calculator final display",
          };
    if (
      Object.entries(expectedAssertion).some(
        ([key, value]) => report.assertion?.[key] !== value,
      )
    ) {
      throw new Error(
        `Result report ${reportPath} does not bind its scenario assertion`,
      );
    }
    if (observedScenarios.has(report.scenario)) {
      throw new Error(
        `Scenario ${report.scenario} has more than one result report`,
      );
    }
    observedScenarios.add(report.scenario);
    if (
      capability.require_accessibility &&
      report.scenario === "web-calculator" &&
      (report.accessibility?.status !== "passed" ||
        report.accessibility?.counts?.violations !== 0)
    ) {
      throw new Error(
        `Result report ${reportPath} failed accessibility policy`,
      );
    }
    paths.add(reportPath);
  }
  if (!sameStrings(observedScenarios, capability.scenarios)) {
    throw new Error(
      `${capability.id} result reports do not exactly cover selected scenarios`,
    );
  }
  const files = [];
  for (const path of [...paths].sort(compareText)) {
    files.push({
      path,
      digest: hash(await nonemptyFile(path, workspaceRoot)),
    });
  }
  return files;
}

async function treeEntries(
  root,
  directory = root,
  { excludeRootNames = new Set() } = {},
) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && excludeRootNames.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    const repositoryPath = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      entries.push(
        ...(await treeEntries(root, path, { excludeRootNames })),
      );
    } else if (entry.isFile()) {
      const metadata = await lstat(path);
      entries.push([
        repositoryPath,
        {
          type: "file",
          mode: metadata.mode & 0o777,
          digest: hash(await readFile(path)),
        },
      ]);
    } else if (entry.isSymbolicLink()) {
      entries.push([
        repositoryPath,
        {
          type: "symlink",
          target: await readlink(path),
        },
      ]);
    } else {
      throw new Error(`Unsupported filesystem entry ${repositoryPath}`);
    }
  }
  return entries;
}

function pathIsMutable(path, mutablePaths) {
  return mutablePaths.some(
    (mutablePath) =>
      path === mutablePath || path.startsWith(`${mutablePath}/`),
  );
}

async function immutableWorkspaceDigest(workspaceRoot, mutablePaths) {
  const entries = (await treeEntries(workspaceRoot))
    .filter(([path]) => !pathIsMutable(path, mutablePaths))
    .sort(([left], [right]) => compareText(left, right));
  return hash(entries);
}

function aggregateStatus(checks) {
  return checks.some(({ status }) => status !== "pass") ? "fail" : "pass";
}

function disposition(results, failures) {
  if (
    failures.length === 0 &&
    results.every(
      (result) => result.status === "pass" && result.warnings.length === 0,
    )
  ) {
    return {
      state: "independently-qualified",
      reason_codes: [],
    };
  }
  return {
    state: "blocked",
    reason_codes: sortedUnique(
      failures.length > 0 ? failures : ["SELENIUM_QUALIFICATION_FAILED"],
    ),
  };
}

function artifactEvidence(capability, plan, files, startedAt, completedAt) {
  return {
    type: "qualification-artifacts",
    locator: capability.diagnostics,
    revision: plan.repository.revision,
    digest: hash({
      candidate_digest: plan.candidate_digest,
      capability_id: capability.id,
      files,
      runner: plan.runner,
      tools: plan.tools,
      ...workspaceBindingDigests(plan),
    }),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

function qualificationEnvelope({
  authority,
  checks,
  executions,
  failures,
  lockClosure,
  plan,
  policy,
  request,
  validation,
}) {
  const timestamps = checks.flatMap(({ evidence }) =>
    evidence.flatMap(({ started_at: startedAt, completed_at: completedAt }) =>
      [startedAt, completedAt]));
  if (timestamps.length === 0) {
    throw new Error("Selenium qualification envelope requires check evidence");
  }
  const milliseconds = timestamps.map((value) =>
    timestampMilliseconds(value, "Selenium qualification evidence timestamp"));
  return {
    schema_version: 1,
    kind: "selenium-qualification-result-envelope",
    authority_digest: hash(authority),
    candidate_digest: plan.candidate_digest,
    repository_revision: plan.repository.revision,
    plan_digest: hash(plan),
    policy_digest: hash(policy),
    request_digest: request.request_digest,
    source_materialization_digest:
      request.source_materialization_digest,
    mutable_seed_digest: request.mutable_seed_digest,
    trusted_inputs_digest: request.trusted_inputs_digest,
    workspace_partition_digest: request.workspace_partition_digest,
    executions_digest: hash(executions),
    checks_digest: hash(checks),
    failures_digest: hash(failures),
    lock_closure_digest:
      lockClosure === null ? null : hash(lockClosure),
    validation_digest: hash(validation),
    evidence_digest: hash(
      validation.results.map(({ capability_id: capabilityId, evidence }) => ({
        capability_id: capabilityId,
        evidence,
      })),
    ),
    status: validation.disposition.state,
    warnings: sortedUnique(
      validation.results.flatMap(({ warnings }) => warnings),
    ),
    generated_at: validation.generated_at,
    execution_started_at:
      new Date(Math.min(...milliseconds)).toISOString(),
    execution_completed_at:
      new Date(Math.max(...milliseconds)).toISOString(),
  };
}

function validateArtifactAuthority(authority, trustedAuthority) {
  const keys = new Set([
    "github_api_permission",
    "identity_digest",
    "kind",
    "public_key",
  ]);
  assertExactObjectKeys(
    authority,
    keys,
    "Selenium qualification artifact authority",
  );
  assertExactObjectKeys(
    trustedAuthority,
    keys,
    "Caller-trusted Selenium qualification authority",
  );
  assertDigest(
    authority.identity_digest,
    "Selenium qualification artifact authority identity_digest",
  );
  assertString(
    authority.public_key,
    "Selenium qualification artifact authority public_key",
  );
  let publicKey;
  try {
    publicKey = createPublicKey(authority.public_key);
  } catch (error) {
    throw new Error(
      "Selenium qualification artifact authority public_key is invalid",
      { cause: error },
    );
  }
  if (
    authority.kind !== "ed25519" ||
    authority.github_api_permission !== "none" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    authority.identity_digest !== hash(authority.public_key) ||
    stableJson(authority) !== stableJson(trustedAuthority)
  ) {
    throw new Error(
      "Selenium qualification artifact authority is not exactly caller-trusted",
    );
  }
}

function validateArtifactPolicy(policy, plan, authority) {
  assertExactObjectKeys(
    policy,
    new Set([
      "authority",
      "candidate_code",
      "candidate_digest",
      "environment",
      "executor_id",
      "filesystem",
      "isolation",
      "kind",
      "plan_digest",
      "repository_revision",
      "runner",
      "schema_version",
      "tools",
      "tools_digest",
    ]),
    "Selenium qualification artifact policy",
  );
  assertExactObjectKeys(
    policy.authority,
    new Set([
      "github_api_permission",
      "identity_digest",
      "kind",
      "public_key_digest",
    ]),
    "Selenium qualification artifact policy authority",
  );
  assertExactObjectKeys(
    policy.isolation,
    new Set([
      "disposable",
      "github_api_access",
      "network",
      "privileges",
      "repository_write_access",
      "secrets",
    ]),
    "Selenium qualification artifact policy isolation",
  );
  assertExactObjectKeys(
    policy.environment,
    new Set(["inherit_host", "variables"]),
    "Selenium qualification artifact policy environment",
  );
  assertExactObjectKeys(
    policy.filesystem,
    new Set([
      "immutable_inputs",
      "mutable_paths",
      "mutable_paths_digest",
      "mutable_seed",
      "partition_digest",
      "source_materialization",
    ]),
    "Selenium qualification artifact policy filesystem",
  );
  assertExactObjectKeys(
    policy.filesystem.source_materialization,
    new Set(["digest", "repository_revision"]),
    "Selenium qualification artifact source materialization policy",
  );
  assertExactObjectKeys(
    policy.filesystem.mutable_seed,
    new Set(["access", "digest", "repository_revision"]),
    "Selenium qualification artifact mutable-seed policy",
  );
  assertExactObjectKeys(
    policy.filesystem.immutable_inputs,
    new Set([
      "access",
      "digest",
      "manifest_digest",
      "repository_revision",
    ]),
    "Selenium qualification artifact immutable-input policy",
  );
  assertExactObjectKeys(
    policy.filesystem.mutable_paths,
    new Set(["executor_state", "repository"]),
    "Selenium qualification artifact mutable-path policy",
  );
  const expectedIsolation = {
    disposable: true,
    github_api_access: false,
    network: EXECUTOR_NETWORK,
    privileges: "unprivileged",
    repository_write_access: false,
    secrets: "none",
  };
  const expectedAuthority = {
    github_api_permission: authority.github_api_permission,
    identity_digest: authority.identity_digest,
    kind: authority.kind,
    public_key_digest: hash(authority.public_key),
  };
  const expectedExecutorState = [
    "${EXECUTOR_STATE_ROOT}/executor-home",
    "${EXECUTOR_STATE_ROOT}/executor-tmp",
  ];
  const expectedMutablePaths = {
    executor_state: expectedExecutorState,
    repository: plan.workspace.mutable_paths,
  };
  if (
    policy.schema_version !== 1 ||
    policy.kind !== "selenium-isolated-executor-policy" ||
    typeof policy.executor_id !== "string" ||
    !EXECUTOR_ID_PATTERN.test(policy.executor_id) ||
    policy.candidate_code !== EXECUTOR_CANDIDATE_CODE ||
    policy.candidate_digest !== plan.candidate_digest ||
    policy.repository_revision !== plan.repository.revision ||
    policy.plan_digest !== hash(plan) ||
    stableJson(policy.authority) !== stableJson(expectedAuthority) ||
    stableJson(policy.tools) !== stableJson(plan.tools) ||
    policy.tools_digest !== hash(plan.tools) ||
    stableJson(policy.runner) !== stableJson(plan.runner) ||
    stableJson(policy.isolation) !== stableJson(expectedIsolation) ||
    policy.environment.inherit_host !== false ||
    policy.filesystem.source_materialization.digest !==
      plan.workspace.source_materialization.manifest_digest ||
    policy.filesystem.source_materialization.repository_revision !==
      plan.repository.revision ||
    policy.filesystem.mutable_seed.access !== "read-write" ||
    policy.filesystem.mutable_seed.digest !==
      plan.workspace.mutable_seed.manifest_digest ||
    policy.filesystem.mutable_seed.repository_revision !==
      plan.repository.revision ||
    policy.filesystem.immutable_inputs.access !== "read-only" ||
    policy.filesystem.immutable_inputs.digest !==
      fileManifestContentDigest(
        plan.workspace.immutable_inputs.manifest,
      ) ||
    policy.filesystem.immutable_inputs.manifest_digest !==
      plan.workspace.immutable_inputs.manifest_digest ||
    policy.filesystem.immutable_inputs.repository_revision !==
      plan.repository.revision ||
    policy.filesystem.partition_digest !==
      plan.workspace.partition_digest ||
    stableJson(policy.filesystem.mutable_paths) !==
      stableJson(expectedMutablePaths) ||
    policy.filesystem.mutable_paths_digest !== hash(expectedMutablePaths)
  ) {
    throw new Error(
      "Selenium qualification artifact policy is not exactly bound to its plan and authority",
    );
  }
  assertDigest(
    policy.filesystem.immutable_inputs.digest,
    "Selenium qualification artifact immutable workspace digest",
  );
  const environmentKeys = new Set([
    "CI",
    "E2E_SELENIUM_CACHE",
    "GITHUB_WORKSPACE",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_FUND",
    "PATH",
    "TMPDIR",
  ]);
  if ("NPM_CONFIG_STRICT_SSL" in policy.environment.variables) {
    environmentKeys.add("NPM_CONFIG_STRICT_SSL");
  }
  assertExactObjectKeys(
    policy.environment.variables,
    environmentKeys,
    "Selenium qualification artifact policy environment variables",
  );
  const expectedEnvironment = {
    CI: "true",
    E2E_SELENIUM_CACHE:
      "${WORKSPACE_ROOT}/tests/e2e/selenium/.runtime/selenium-cache",
    GITHUB_WORKSPACE: "${WORKSPACE_ROOT}",
    HOME: "${EXECUTOR_STATE_ROOT}/executor-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE:
      "${WORKSPACE_ROOT}/tests/e2e/selenium/.npm-cache",
    NPM_CONFIG_FUND: "false",
    PATH: policy.environment.variables.PATH,
    TMPDIR: "${EXECUTOR_STATE_ROOT}/executor-tmp",
    ...("NPM_CONFIG_STRICT_SSL" in policy.environment.variables
      ? {
          NPM_CONFIG_STRICT_SSL:
            policy.environment.variables.NPM_CONFIG_STRICT_SSL,
        }
      : {}),
  };
  if (
    typeof expectedEnvironment.PATH !== "string" ||
    expectedEnvironment.PATH.length === 0 ||
    !["true", "false", undefined].includes(
      expectedEnvironment.NPM_CONFIG_STRICT_SSL,
    ) ||
    stableJson(policy.environment.variables) !==
      stableJson(expectedEnvironment)
  ) {
    throw new Error(
      "Selenium qualification artifact policy environment is not canonical",
    );
  }
}

function assertArtifactTimeWithinRequest(
  startedAt,
  completedAt,
  request,
  label,
) {
  const started = timestampMilliseconds(startedAt, `${label} started_at`);
  const completed = timestampMilliseconds(
    completedAt,
    `${label} completed_at`,
  );
  const issued = timestampMilliseconds(
    request.issued_at,
    "Selenium qualification artifact request issued_at",
  );
  const expires = timestampMilliseconds(
    request.expires_at,
    "Selenium qualification artifact request expires_at",
  );
  if (
    started < issued ||
    completed < started ||
    completed >= expires
  ) {
    throw new Error(`${label} executes outside the request window`);
  }
}

function validateArtifactEvidence(evidence, request, label) {
  assertExactObjectKeys(
    evidence,
    new Set([
      "completed_at",
      "digest",
      "locator",
      "revision",
      "started_at",
      "type",
    ]),
    label,
  );
  assertString(evidence.type, `${label} type`);
  assertString(evidence.locator, `${label} locator`);
  if (!REVISION_PATTERN.test(evidence.revision ?? "")) {
    throw new Error(`${label} revision must be a full lowercase commit SHA`);
  }
  assertDigest(evidence.digest, `${label} digest`);
  assertArtifactTimeWithinRequest(
    evidence.started_at,
    evidence.completed_at,
    request,
    label,
  );
}

function validateArtifactCheck(check, request, label) {
  assertExactObjectKeys(
    check,
    new Set([
      "capability_id",
      "evidence",
      "id",
      "phase",
      "scenario",
      "status",
      "warnings",
    ]),
    label,
  );
  assertString(check.id, `${label} id`);
  assertString(check.phase, `${label} phase`);
  if (
    check.capability_id !== null &&
    (typeof check.capability_id !== "string" ||
      !EXECUTOR_ID_PATTERN.test(check.capability_id))
  ) {
    throw new Error(`${label} capability_id must be null or kebab-case`);
  }
  if (
    check.scenario !== null &&
    (typeof check.scenario !== "string" || check.scenario.length === 0)
  ) {
    throw new Error(`${label} scenario must be null or nonempty`);
  }
  if (!["pass", "fail"].includes(check.status)) {
    throw new Error(`${label} status must be pass or fail`);
  }
  if (
    !Array.isArray(check.warnings) ||
    check.warnings.some(
      (warning) => typeof warning !== "string" || warning.length === 0,
    ) ||
    stableJson(sortedUnique(check.warnings)) !== stableJson(check.warnings)
  ) {
    throw new Error(`${label} warnings must be sorted unique strings`);
  }
  if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
    throw new Error(`${label} evidence must be nonempty`);
  }
  check.evidence.forEach((evidence, index) =>
    validateArtifactEvidence(
      evidence,
      request,
      `${label} evidence[${index}]`,
    ));
}

function validateArtifactExecution(
  execution,
  {
    authority,
    check,
    plan,
    policy,
    request,
    step,
  },
) {
  assertExactObjectKeys(
    execution,
    new Set([
      "attestation",
      "check_result",
      "completed_at",
      "environment_digest",
      "result",
      "started_at",
      "step_id",
    ]),
    `Selenium execution ${step.id}`,
  );
  if (execution.step_id !== step.id) {
    throw new Error("Selenium execution step identity is not exact");
  }
  assertArtifactTimeWithinRequest(
    execution.started_at,
    execution.completed_at,
    request,
    `Selenium execution ${step.id}`,
  );
  const checkResult = assertRawCommandResult(
    execution.check_result,
    `${step.id} check`,
  );
  let attestation = null;
  let executorResult = null;
  if (execution.attestation !== null) {
    assertDigest(
      execution.environment_digest,
      `${step.id} environment_digest`,
    );
    executorResult = assertRawCommandResult(
      execution.result,
      `${step.id} executor`,
    );
    attestation = validateExecutorAttestation(
      execution.attestation,
      {
        authority,
        environment: null,
        environmentDigest: execution.environment_digest,
        policy,
        raw: executorResult,
        request,
        step,
      },
    );
  } else if (
    execution.environment_digest !== null ||
    (execution.result !== null &&
      (typeof execution.result !== "object" ||
        Array.isArray(execution.result)))
  ) {
    throw new Error(
      `${step.id} unsigned execution must not claim an environment digest`,
    );
  }
  const expectedCheck = {
    id: step.id,
    phase: step.phase,
    capability_id: step.capability_id,
    scenario: step.scenario,
    status:
      controlledStepPassed(step, checkResult, policy) ? "pass" : "fail",
    warnings: sortedUnique(
      executorResult === null
        ? []
        : warningLines(
            `${executorResult.stdout}${executorResult.stderr}`,
          ),
    ),
    evidence: [
      commandEvidence(
        step,
        plan,
        checkResult,
        execution.started_at,
        execution.completed_at,
      ),
      ...(attestation === null
        ? []
        : [
            executorAttestationEvidence(
              attestation,
              plan,
              execution.started_at,
              execution.completed_at,
            ),
          ]),
    ],
  };
  if (stableJson(check) !== stableJson(expectedCheck)) {
    throw new Error(`${step.id} check does not match its signed execution`);
  }
  return attestation;
}

function validateArtifactEnvelope(artifact) {
  const expectedUnsigned = qualificationEnvelope({
    authority: artifact.authority,
    checks: artifact.checks,
    executions: artifact.executor.executions,
    failures: artifact.executor.failures,
    lockClosure: artifact.executor.generated_lock_closure,
    plan: artifact.executor.plan,
    policy: artifact.executor.policy,
    request: artifact.executor.request,
    validation: artifact.validation,
  });
  assertExactObjectKeys(
    artifact.envelope,
    new Set([...Object.keys(expectedUnsigned), "signature"]),
    "Selenium qualification artifact envelope",
  );
  const { signature, ...unsigned } = artifact.envelope;
  if (
    stableJson(unsigned) !== stableJson(expectedUnsigned) ||
    !verifyEd25519Signature(
      expectedUnsigned,
      signature,
      artifact.authority.public_key,
    )
  ) {
    throw new Error(
      "Selenium qualification artifact envelope is missing, tampered, or not signed by the trusted authority",
    );
  }
  assertArtifactTimeWithinRequest(
    artifact.envelope.execution_started_at,
    artifact.envelope.execution_completed_at,
    artifact.executor.request,
    "Selenium qualification artifact envelope",
  );
  const generatedAt = timestampMilliseconds(
    artifact.envelope.generated_at,
    "Selenium qualification artifact envelope generated_at",
  );
  const completedAt = timestampMilliseconds(
    artifact.envelope.execution_completed_at,
    "Selenium qualification artifact envelope execution_completed_at",
  );
  const expiresAt = timestampMilliseconds(
    artifact.executor.request.expires_at,
    "Selenium qualification artifact request expires_at",
  );
  if (generatedAt < completedAt || generatedAt >= expiresAt) {
    throw new Error(
      "Selenium qualification artifact envelope was generated outside the request window",
    );
  }
}

export function validateSeleniumQualificationArtifact(
  artifact,
  {
    catalog,
    observation,
    trustedExecutorAuthority,
  } = {},
) {
  assertExactObjectKeys(
    artifact,
    new Set([
      "authority",
      "checks",
      "envelope",
      "executor",
      "kind",
      "observation_digest",
      "schema_version",
      "validation",
    ]),
    "Selenium qualification artifact",
  );
  if (
    artifact.schema_version !== 1 ||
    artifact.kind !== "selenium-qualification-artifact"
  ) {
    throw new Error(
      "Selenium qualification artifact schema and kind are unsupported",
    );
  }
  validateArtifactAuthority(
    artifact.authority,
    trustedExecutorAuthority,
  );
  assertExactObjectKeys(
    artifact.executor,
    new Set([
      "attestations",
      "executions",
      "failures",
      "generated_lock_closure",
      "mutable_seed",
      "plan",
      "policy",
      "request",
      "source_materialization",
      "trusted_inputs",
    ]),
    "Selenium qualification artifact executor",
  );
  if (
    artifact.observation_digest !== subjectDigest(observation) ||
    observation.provider_id !== SELENIUM_PROVIDER_ID ||
    observation.disposition.state !== "candidate"
  ) {
    throw new Error(
      "Selenium qualification artifact does not bind its candidate observation",
    );
  }
  const expectedPlan = createSeleniumQualificationPlan({
    observation,
    catalog,
    executorTools: artifact.executor.plan?.tools,
    mutableSeedManifest: artifact.executor.mutable_seed,
    sourceMaterializationManifest:
      artifact.executor.source_materialization,
    trustedInputManifest: artifact.executor.trusted_inputs,
  });
  if (stableJson(artifact.executor.plan) !== stableJson(expectedPlan)) {
    throw new Error(
      "Selenium qualification artifact plan is missing, unknown, or tampered",
    );
  }
  const plan = artifact.executor.plan;
  const policy = artifact.executor.policy;
  validateArtifactPolicy(policy, plan, artifact.authority);
  const request = artifact.executor.request;
  assertExactObjectKeys(
    request,
    new Set([
      "authority_digest",
      "candidate_digest",
      "challenge",
      "executor_id",
      "expires_at",
      "immutable_inputs_digest",
      "issued_at",
      "kind",
      "mutable_paths_digest",
      "mutable_seed_digest",
      "plan_digest",
      "policy_digest",
      "repository_revision",
      "request_digest",
      "run_id",
      "schema_version",
      "source_materialization_digest",
      "tools_digest",
      "trusted_inputs_digest",
      "workspace_partition_digest",
    ]),
    "Selenium qualification artifact request",
  );
  const expectedRequest = executionRequest(
    policy,
    {
      challenge: request.challenge,
      expires_at: request.expires_at,
      issued_at: request.issued_at,
      run_id: request.run_id,
    },
    new Date(request.issued_at),
  );
  if (stableJson(request) !== stableJson(expectedRequest)) {
    throw new Error(
      "Selenium qualification artifact request is missing, unknown, or tampered",
    );
  }
  if (
    !Array.isArray(artifact.checks) ||
    artifact.checks.length === 0 ||
    !Array.isArray(artifact.executor.executions) ||
    !Array.isArray(artifact.executor.attestations) ||
    !Array.isArray(artifact.executor.failures) ||
    !(
      artifact.executor.generated_lock_closure === null ||
      (typeof artifact.executor.generated_lock_closure === "object" &&
        !Array.isArray(artifact.executor.generated_lock_closure))
    ) ||
    artifact.executor.failures.some(
      (failure) =>
        typeof failure !== "string" ||
        !new Set([
          "APPLICATION_FAILED",
          "ARTIFACT_VALIDATION_FAILED",
          "CAPABILITY_EXECUTION_FAILED",
          "EXECUTOR_ATTESTATION_INCOMPLETE",
          "INSTALLATION_FAILED",
          "INSTALLED_PACKAGE_MISMATCH",
          "LOCK_VERIFICATION_FAILED",
          "PACKAGE_TESTS_FAILED",
          "QUALIFICATION_WARNINGS",
          "RUNNER_EXECUTABLE_IDENTITY_MISMATCH",
        ]).has(failure),
    )
  ) {
    throw new Error(
      "Selenium qualification artifact checks, executions, attestations, and failures must be arrays",
    );
  }
  const checksById = new Map();
  for (const [index, check] of artifact.checks.entries()) {
    validateArtifactCheck(
      check,
      request,
      `Selenium qualification artifact check[${index}]`,
    );
    if (checksById.has(check.id)) {
      throw new Error(`Selenium qualification artifact repeats check ${check.id}`);
    }
    checksById.set(check.id, check);
  }
  const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
  const executionsById = new Map();
  const validatedAttestations = [];
  for (const execution of artifact.executor.executions) {
    const step = stepsById.get(execution?.step_id);
    if (step === undefined || executionsById.has(step.id)) {
      throw new Error(
        "Selenium qualification artifact execution references an unknown or repeated step",
      );
    }
    const check = checksById.get(step.id);
    if (check === undefined) {
      throw new Error(`${step.id} execution lacks its check`);
    }
    const attestation = validateArtifactExecution(execution, {
      authority: artifact.authority,
      check,
      plan,
      policy,
      request,
      step,
    });
    if (attestation !== null) {
      validatedAttestations.push(attestation);
    }
    executionsById.set(step.id, execution);
  }
  if (
    stableJson(validatedAttestations) !==
      stableJson(artifact.executor.attestations)
  ) {
    throw new Error(
      "Selenium qualification artifact attestation list does not exactly match signed executions",
    );
  }
  const applyAttestation = validatedAttestations.find(
    ({ step_id: stepId }) => stepId === "apply-selenium-tarballs",
  );
  let validatedLockClosure = null;
  if (artifact.executor.generated_lock_closure !== null) {
    if (applyAttestation === undefined) {
      throw new Error(
        "Selenium generated lock closure lacks its package-lock generation attestation",
      );
    }
    validatedLockClosure = validateGeneratedLockClosure(
      artifact.executor.generated_lock_closure,
      {
        applyAttestation,
        authority: artifact.authority,
        plan,
        policy,
        request,
      },
    );
    const applyExecution = executionsById.get("apply-selenium-tarballs");
    const installExecution = executionsById.get(
      "install-selenium-candidate",
    );
    if (
      applyExecution === undefined ||
      installExecution === undefined ||
      timestampMilliseconds(
        validatedLockClosure.captured_at,
        "Selenium generated lock closure captured_at",
      ) <
        timestampMilliseconds(
          applyExecution.completed_at,
          "Selenium package-lock generation completed_at",
        ) ||
      timestampMilliseconds(
        validatedLockClosure.captured_at,
        "Selenium generated lock closure captured_at",
      ) >
        timestampMilliseconds(
          installExecution.started_at,
          "Selenium package installation started_at",
        )
    ) {
      throw new Error(
        "Selenium generated lock closure must be signed after generation and before installation",
      );
    }
  }
  const allowedInternalChecks = new Set([
    "verify-selenium-lock",
    "verify-installed-selenium-packages",
    ...plan.selected_capabilities.map(
      ({ id }) => `${id}-artifact-inspection`,
    ),
  ]);
  for (const check of artifact.checks) {
    if (
      !stepsById.has(check.id) &&
      !allowedInternalChecks.has(check.id)
    ) {
      throw new Error(
        `Selenium qualification artifact contains unknown check ${check.id}`,
      );
    }
  }
  const lockCheck = checksById.get("verify-selenium-lock");
  if (lockCheck !== undefined) {
    const closureEvidence = lockCheck.evidence.filter(
      ({ type }) => type === "qualification-npm-lock-closure",
    );
    if (
      lockCheck.status === "pass" &&
      (validatedLockClosure === null ||
        closureEvidence.length !== 1 ||
        stableJson(closureEvidence[0]) !==
          stableJson(generatedLockClosureEvidence(
            validatedLockClosure,
            plan,
            closureEvidence[0].started_at,
            closureEvidence[0].completed_at,
          )))
    ) {
      throw new Error(
        "Passing Selenium lock verification must exactly bind the signed generated closure",
      );
    }
    if (
      lockCheck.status !== "pass" &&
      (validatedLockClosure !== null || closureEvidence.length !== 0)
    ) {
      throw new Error(
        "Failed Selenium lock verification must not publish closure evidence",
      );
    }
  } else if (validatedLockClosure !== null) {
    throw new Error(
      "Selenium generated lock closure lacks its verification check",
    );
  }
  if (
    artifact.validation.disposition.state === "independently-qualified" &&
    validatedLockClosure === null
  ) {
    throw new Error(
      "Independent Selenium qualification requires a signed generated lock closure",
    );
  }
  const globalChecks = artifact.checks.filter(
    ({ capability_id: capabilityId }) => capabilityId === null,
  );
  const expectedResults = plan.selected_capabilities.map((capability) => {
    const capabilityChecks = artifact.checks.filter(
      ({ capability_id: capabilityId }) =>
        capabilityId === capability.id,
    );
    const required = [...globalChecks, ...capabilityChecks];
    const existing = artifact.validation.results.find(
      ({ capability_id: capabilityId }) =>
        capabilityId === capability.id,
    );
    if (existing === undefined) {
      throw new Error(
        `Selenium qualification artifact lacks result ${capability.id}`,
      );
    }
    const checkEvidence = required.flatMap(({ evidence }) => evidence);
    const finalEvidence = existing.evidence.slice(checkEvidence.length);
    if (
      stableJson(existing.evidence.slice(0, checkEvidence.length)) !==
      stableJson(checkEvidence) ||
      finalEvidence.length !== 2 ||
      finalEvidence[0].type !==
        "qualification-executor-attestation-set" ||
      finalEvidence[1].type !== "qualification-git-state" ||
      existing.status !== aggregateStatus(required) ||
      stableJson(existing.warnings) !==
        stableJson(sortedUnique(
          required.flatMap(({ warnings }) => warnings),
        ))
    ) {
      throw new Error(
        `Selenium qualification result ${capability.id} does not match its checks, warnings, status, and evidence`,
      );
    }
    const expectedAttestationSet = executorAttestationSetEvidence(
      artifact.executor.attestations,
      plan,
      request,
      finalEvidence[0].started_at,
      finalEvidence[0].completed_at,
    );
    if (
      stableJson(finalEvidence[0]) !==
        stableJson(expectedAttestationSet) ||
      finalEvidence[1].locator !== "git-checkout:exact-clean" ||
      finalEvidence[1].revision !== plan.repository.revision
    ) {
      throw new Error(
        `Selenium qualification result ${capability.id} does not bind its signed execution set and source guard`,
      );
    }
    existing.evidence.forEach((evidence, index) =>
      validateArtifactEvidence(
        evidence,
        request,
        `Selenium qualification result ${capability.id} evidence[${index}]`,
      ));
    return existing;
  });
  if (
    stableJson(expectedResults) !==
      stableJson(artifact.validation.results) ||
    stableJson(artifact.validation.disposition) !==
      stableJson(disposition(expectedResults, artifact.executor.failures))
  ) {
    throw new Error(
      "Selenium qualification artifact validation status is not derived from its checks and failures",
    );
  }
  validateDocument(artifact.validation, {
    capabilityIds: new Set(
      plan.selected_capabilities.map(({ id }) => id),
    ),
    capabilityCatalogDigest: observation.capability_catalog.digest,
  });
  if (
    artifact.validation.provider_id !== SELENIUM_PROVIDER_ID ||
    artifact.validation.candidate_digest !== plan.candidate_digest ||
    stableJson(artifact.validation.repository) !==
      stableJson(observation.repository) ||
    stableJson(artifact.validation.capability_catalog) !==
      stableJson(observation.capability_catalog)
  ) {
    throw new Error(
      "Selenium qualification artifact validation does not bind its observation and plan",
    );
  }
  validateArtifactEnvelope(artifact);
  return structuredClone(artifact);
}

export async function qualifySeleniumCandidate(
  {
    observation,
    repositoryRoot,
  },
  {
    catalog,
    consumeExecutionRequest,
    createWorkspace = defaultCreateWorkspace,
    environmentOverrides = {},
    executionRequestFreshness,
    executor,
    generatedAt = new Date().toISOString(),
    materializeWorkspace = copyRepository,
    now = () => new Date(),
    trustedExecutorAuthority,
  } = {},
) {
  const isolatedExecutor = validateExecutor(
    executor,
    trustedExecutorAuthority,
  );
  if (typeof consumeExecutionRequest !== "function") {
    throw new Error(
      "Selenium qualification requires a caller-owned one-time request consumer",
    );
  }
  const root = resolve(repositoryRoot);
  const catalogDocument =
    catalog ??
    parseJson(
      await readFile(resolve(root, CATALOG_PATH), "utf8"),
      CATALOG_PATH,
    );
  const checkoutBefore = await checkoutState(root);
  if (checkoutBefore.head !== observation.repository.revision) {
    throw new Error(
      "Source checkout HEAD must exactly match observation repository.revision",
    );
  }
  if (checkoutBefore.status !== "") {
    throw new Error(
      "Source checkout must be clean across tracked, untracked, and ignored files",
    );
  }
  await validateContainedSymlinks(root, "Source repository");
  const [
    sourceMaterializationManifest,
    mutableSeedManifest,
    trustedInputManifest,
  ] = await Promise.all([
    createSeleniumSourceMaterializationManifest(
      root,
      observation.repository.revision,
    ),
    createSeleniumMutableSeedManifest(
      root,
      observation.repository.revision,
    ),
    createSeleniumTrustedInputManifest(
      root,
      observation.repository.revision,
    ),
  ]);
  const sourceBefore = hash(sourceMaterializationManifest);
  await verifySourcePackageBinding(observation, root);
  const temporaryRoot = resolve(await createWorkspace());
  if (isWithin(root, temporaryRoot) || isWithin(temporaryRoot, root)) {
    throw new Error("Ephemeral workspace must be outside the repository");
  }
  const workspaceRoot = resolve(temporaryRoot, "repository");
  let execution;
  let workError;
  try {
    await materializeWorkspace(root, workspaceRoot);
    await validateContainedSymlinks(workspaceRoot, "Ephemeral workspace");
    const [
      materializedSourceManifest,
      materializedSeedManifest,
      materializedTrustedManifest,
    ] = await Promise.all([
      createSeleniumSourceMaterializationManifest(
        workspaceRoot,
        observation.repository.revision,
      ),
      createSeleniumMutableSeedManifest(
        workspaceRoot,
        observation.repository.revision,
      ),
      createSeleniumTrustedInputManifest(
        workspaceRoot,
        observation.repository.revision,
      ),
    ]);
    if (
      stableJson(materializedSourceManifest) !==
        stableJson(sourceMaterializationManifest) ||
      stableJson(materializedSeedManifest) !==
        stableJson(mutableSeedManifest) ||
      stableJson(materializedTrustedManifest) !==
        stableJson(trustedInputManifest)
    ) {
      throw new Error(
        "Ephemeral workspace does not exactly match the source, seed, and trusted-input manifests",
      );
    }
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog: catalogDocument,
      executorTools: isolatedExecutor.tools,
      mutableSeedManifest,
      sourceMaterializationManifest,
      trustedInputManifest,
    });
    const immutableBefore = await immutableWorkspaceDigest(
      workspaceRoot,
      plan.workspace.mutable_paths,
    );
    const baseEnvironment = sanitizedEnvironment(
      workspaceRoot,
      temporaryRoot,
      isolatedExecutor.path,
      environmentOverrides,
    );
    await Promise.all([
      mkdir(baseEnvironment.HOME, { recursive: true }),
      mkdir(baseEnvironment.TMPDIR, { recursive: true }),
    ]);
    await verifyExecutorToolIdentities(
      isolatedExecutor.tools,
      baseEnvironment,
    );
    const policy = executorPolicy({
      executorAuthority: isolatedExecutor.authority,
      executorId: isolatedExecutor.id,
      executorTools: isolatedExecutor.tools,
      immutableInputsDigest: immutableBefore,
      mutablePaths: plan.workspace.mutable_paths,
      plan,
      baseEnvironment,
      temporaryRoot,
      workspaceRoot,
    });
    const request = executionRequest(
      policy,
      executionRequestFreshness,
      now(),
    );
    if (
      await consumeExecutionRequest(structuredClone(request)) !== true
    ) {
      throw new Error(
        "Selenium executor request challenge or run binding was already consumed",
      );
    }
    const attestations = [];
    const executions = [];
    const checks = [];
    const failures = [];
    let generatedLockClosure = null;
    for (const id of [
      "verify-executor-node",
      "verify-executor-npm",
      "cache-selenium-axe-webdriver-tarball",
      "cache-selenium-axe-core-tarball",
      "cache-selenium-webdriver-tarball",
      "apply-selenium-tarballs",
    ]) {
      if (failures.length > 0) {
        break;
      }
      const step = plan.steps.find((entry) => entry.id === id);
      const result = await executeControlledStep(step, plan, {
        attestations,
        baseEnvironment,
        executor: isolatedExecutor,
        executions,
        now,
        policy,
        request,
        workspaceRoot,
      });
      checks.push(result);
      if (result.status !== "pass") {
        failures.push("APPLICATION_FAILED");
      }
    }

    if (failures.length === 0) {
      const startedAt = timestamp(now());
      let lockResult;
      try {
        await verifyAppliedLock(plan, workspaceRoot);
        const applyAttestation = attestations.find(
          ({ step_id: stepId }) => stepId === "apply-selenium-tarballs",
        );
        if (applyAttestation === undefined) {
          throw new Error(
            "Generated package-lock lacks its executor attestation",
          );
        }
        generatedLockClosure = await captureGeneratedLockClosure(
          plan,
          workspaceRoot,
          {
            applyAttestation,
            executor: isolatedExecutor,
            now,
            policy,
            request,
          },
        );
        const completedAt = timestamp(now());
        lockResult = internalCheckEvidence(
          "verify-selenium-lock",
          plan,
          true,
          "verified",
          startedAt,
          completedAt,
          [
            generatedLockClosureEvidence(
              generatedLockClosure,
              plan,
              startedAt,
              completedAt,
            ),
          ],
        );
      } catch (error) {
        generatedLockClosure = null;
        const completedAt = timestamp(now());
        lockResult = internalCheckEvidence(
          "verify-selenium-lock",
          plan,
          false,
          error.message,
          startedAt,
          completedAt,
        );
      }
      checks.push(lockResult);
      if (lockResult.status !== "pass") {
        failures.push("LOCK_VERIFICATION_FAILED");
      }
    }

    if (failures.length === 0) {
      const installStep = plan.steps.find(
        ({ id }) => id === "install-selenium-candidate",
      );
      const installResult = await executeControlledStep(installStep, plan, {
        attestations,
        baseEnvironment,
        executor: isolatedExecutor,
        executions,
        now,
        policy,
        request,
        workspaceRoot,
      });
      checks.push(installResult);
      if (installResult.status !== "pass") {
        failures.push("INSTALLATION_FAILED");
      }
    }

    if (failures.length === 0) {
      const installedResult = await runInternalCheck(
        "verify-installed-selenium-packages",
        plan,
        now,
        () => verifyInstalledPackages(
          generatedLockClosure,
          workspaceRoot,
        ),
      );
      checks.push(installedResult);
      if (installedResult.status !== "pass") {
        failures.push("INSTALLED_PACKAGE_MISMATCH");
      }
    }

    if (failures.length === 0) {
      for (const id of [
        "verify-runner-browser",
        "verify-runner-driver",
      ]) {
        const step = plan.steps.find((entry) => entry.id === id);
        const result = await executeControlledStep(step, plan, {
          attestations,
          baseEnvironment,
          executor: isolatedExecutor,
          executions,
          now,
          policy,
          request,
          workspaceRoot,
        });
        checks.push(result);
        if (result.status !== "pass") {
          failures.push("RUNNER_EXECUTABLE_IDENTITY_MISMATCH");
        }
      }
    }

    if (failures.length === 0) {
      const packageStep = plan.steps.find(
        ({ id }) => id === "test-selenium-package",
      );
      const packageResult = await executeControlledStep(packageStep, plan, {
        attestations,
        baseEnvironment,
        executor: isolatedExecutor,
        executions,
        now,
        policy,
        request,
        workspaceRoot,
      });
      checks.push(packageResult);
      if (packageResult.status !== "pass") {
        failures.push("PACKAGE_TESTS_FAILED");
      }
    }

    if (failures.length === 0) {
      for (const id of [
        "verify-runner-browser-after-package-tests",
        "verify-runner-driver-after-package-tests",
      ]) {
        const step = plan.steps.find((entry) => entry.id === id);
        const result = await executeControlledStep(step, plan, {
          attestations,
          baseEnvironment,
          executor: isolatedExecutor,
          executions,
          now,
          policy,
          request,
          workspaceRoot,
        });
        checks.push(result);
        if (result.status !== "pass") {
          failures.push("RUNNER_EXECUTABLE_IDENTITY_MISMATCH");
        }
      }
    }

    const capabilityChecks = new Map(
      plan.selected_capabilities.map(({ id }) => [id, []]),
    );
    if (failures.length === 0) {
      for (const capability of plan.selected_capabilities) {
        const selected = plan.steps.filter(
          (step) => step.capability_id === capability.id,
        );
        for (const step of selected) {
          const result = await executeControlledStep(step, plan, {
            attestations,
            baseEnvironment,
            executor: isolatedExecutor,
            executions,
            now,
            policy,
            request,
            workspaceRoot,
          });
          checks.push(result);
          capabilityChecks.get(capability.id).push(result);
          if (result.status !== "pass") {
            failures.push("CAPABILITY_EXECUTION_FAILED");
            break;
          }
        }
        if (
          capabilityChecks.get(capability.id)
            .every(({ status }) => status === "pass")
        ) {
          const startedAt = timestamp(now());
          try {
            const files = await inspectCapabilityArtifacts(
              capability,
              workspaceRoot,
              plan,
            );
            const completedAt = timestamp(now());
            capabilityChecks.get(capability.id).push({
              id: `${capability.id}-artifact-inspection`,
              phase: "evidence",
              capability_id: capability.id,
              scenario: null,
              status: "pass",
              warnings: [],
              evidence: [
                artifactEvidence(
                  capability,
                  plan,
                  files,
                  startedAt,
                  completedAt,
                ),
              ],
            });
            checks.push(
              capabilityChecks.get(capability.id).at(-1),
            );
          } catch (error) {
            const completedAt = timestamp(now());
            failures.push("ARTIFACT_VALIDATION_FAILED");
            capabilityChecks.get(capability.id).push({
              id: `${capability.id}-artifact-inspection`,
              phase: "evidence",
              capability_id: capability.id,
              scenario: null,
              status: "fail",
              warnings: [],
              evidence: [
                artifactEvidence(
                  capability,
                  plan,
                  [{ error: error.message }],
                  startedAt,
                  completedAt,
                ),
              ],
            });
            checks.push(
              capabilityChecks.get(capability.id).at(-1),
            );
          }
        }
      }
    }

    const immutableAfter = await immutableWorkspaceDigest(
      workspaceRoot,
      plan.workspace.mutable_paths,
    );
    if (immutableAfter !== immutableBefore) {
      throw new Error(
        "Selenium qualification modified immutable trusted inputs",
      );
    }
    const globalChecks = checks.filter(
      ({ capability_id: capabilityId }) => capabilityId === null,
    );
    const results = plan.selected_capabilities.map((capability) => {
      const required = [
        ...globalChecks,
        ...capabilityChecks.get(capability.id),
      ];
      return {
        capability_id: capability.id,
        status: aggregateStatus(required),
        warnings: sortedUnique(
          required.flatMap(({ warnings }) => warnings),
        ),
        evidence: required.flatMap(({ evidence }) =>
          structuredClone(evidence)),
      };
    });
    if (results.some(({ warnings }) => warnings.length > 0)) {
      failures.push("QUALIFICATION_WARNINGS");
    }
    const expectedAttestationIds = plan.steps
      .map(({ id }) => id)
      .sort(compareText);
    const observedAttestationIds = attestations
      .map(({ step_id: id }) => id)
      .sort(compareText);
    if (
      results.every(
        ({ status, warnings }) =>
          status === "pass" && warnings.length === 0,
      ) &&
      stableJson(observedAttestationIds) !==
        stableJson(expectedAttestationIds)
    ) {
      failures.push("EXECUTOR_ATTESTATION_INCOMPLETE");
    }
    const attestationSetStartedAt = timestamp(now());
    const attestationSetCompletedAt = timestamp(now());
    const attestationSet = executorAttestationSetEvidence(
      attestations,
      plan,
      request,
      attestationSetStartedAt,
      attestationSetCompletedAt,
    );
    for (const result of results) {
      result.evidence.push(structuredClone(attestationSet));
    }
    execution = {
      attestations,
      checks,
      executions,
      failures,
      generatedLockClosure,
      immutableInputsDigest: immutableBefore,
      plan,
      policy,
      request,
      results,
      mutableSeedManifest,
      sourceMaterializationManifest,
      trustedInputManifest,
    };
  } catch (error) {
    workError = error;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  const [sourceAfter, checkoutAfter] = await Promise.all([
    createSeleniumSourceMaterializationManifest(
      root,
      observation.repository.revision,
    ).then(hash),
    checkoutState(root),
  ]);
  if (
    stableJson(sourceBefore) !== stableJson(sourceAfter) ||
    checkoutAfter.head !== observation.repository.revision ||
    checkoutAfter.status !== ""
  ) {
    throw new Error("Selenium qualification changed source Git state");
  }
  if (workError !== undefined) {
    throw workError;
  }

  const guardStartedAt = timestamp(now());
  const guardCompletedAt = timestamp(now());
  const guardEvidence = {
    type: "qualification-git-state",
    locator: "git-checkout:exact-clean",
    revision: observation.repository.revision,
    digest: hash({
      candidate_digest: execution.plan.candidate_digest,
      checkout_before: checkoutBefore,
      checkout_after: checkoutAfter,
      source_before: sourceBefore,
      source_after: sourceAfter,
      plan_digest: hash(execution.plan),
      policy_digest: hash(execution.policy),
      request_digest: execution.request.request_digest,
      ...workspaceBindingDigests(execution.plan),
    }),
    started_at: guardStartedAt,
    completed_at: guardCompletedAt,
  };
  for (const result of execution.results) {
    result.evidence.push(structuredClone(guardEvidence));
  }
  const validation = {
    schema_version: 1,
    kind: "validation",
    generated_at: timestamp(generatedAt),
    repository: structuredClone(observation.repository),
    capability_catalog: structuredClone(observation.capability_catalog),
    provider_id: SELENIUM_PROVIDER_ID,
    candidate_digest: execution.plan.candidate_digest,
    disposition: disposition(execution.results, execution.failures),
    results: execution.results,
  };
  const capabilityIds = new Set(
    execution.plan.selected_capabilities.map(({ id }) => id),
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
  const unsignedEnvelope = qualificationEnvelope({
    authority: isolatedExecutor.authority,
    checks: execution.checks,
    executions: execution.executions,
    failures: execution.failures,
    lockClosure: execution.generatedLockClosure,
    plan: execution.plan,
    policy: execution.policy,
    request: execution.request,
    validation,
  });
  const envelope = await isolatedExecutor.seal(
    structuredClone(unsignedEnvelope),
  );
  assertExactObjectKeys(
    envelope,
    new Set([...Object.keys(unsignedEnvelope), "signature"]),
    "Selenium qualification signed envelope",
  );
  const { signature, ...receivedUnsignedEnvelope } = envelope;
  if (
    stableJson(receivedUnsignedEnvelope) !== stableJson(unsignedEnvelope) ||
    !verifyEd25519Signature(
      unsignedEnvelope,
      signature,
      isolatedExecutor.authority.public_key,
    )
  ) {
    throw new Error(
      "Selenium qualification result envelope is not exactly signed by the trusted executor authority",
    );
  }
  const artifact = {
    schema_version: 1,
    kind: "selenium-qualification-artifact",
    authority: structuredClone(isolatedExecutor.authority),
    observation_digest: subjectDigest(observation),
    validation,
    checks: execution.checks,
    executor: {
      attestations: execution.attestations,
      executions: execution.executions,
      failures: execution.failures,
      generated_lock_closure: execution.generatedLockClosure,
      plan: execution.plan,
      policy: execution.policy,
      request: execution.request,
      source_materialization: execution.sourceMaterializationManifest,
      mutable_seed: execution.mutableSeedManifest,
      trusted_inputs: execution.trustedInputManifest,
    },
    envelope,
  };
  validateSeleniumQualificationArtifact(artifact, {
    catalog: catalogDocument,
    observation,
    trustedExecutorAuthority,
  });
  return artifact;
}
