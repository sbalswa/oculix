import { execFile, spawn } from "node:child_process";
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
  environment = {},
  id,
  kind,
  phase,
  scenario = null,
}) {
  return {
    id,
    kind,
    phase,
    capability_id: capabilityId,
    scenario,
    command,
    arguments: arguments_,
    cwd: ".",
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

function capabilitySteps(capability, candidate) {
  const environment = capabilityEnvironment(capability, candidate);
  const common = [
    "--prefix",
    SELENIUM_PACKAGE_DIRECTORY,
    "run",
  ];
  const steps = [
    relativeStep({
      id: `${capability.id}-setup`,
      kind: "command",
      phase: "capability",
      capabilityId: capability.id,
      command: "npm",
      arguments: [
        ...common,
        "setup",
        "--",
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
        relativeStep({
          id: `${capability.id}-smoke`,
          kind: "command",
          phase: "capability",
          capabilityId: capability.id,
          command: "npm",
          arguments: [
            ...common,
            "smoke",
            "--",
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
        relativeStep({
          id: `${capability.id}-web-calculator`,
          kind: "command",
          phase: "capability",
          capabilityId: capability.id,
          command: process.execPath,
          arguments: [
            "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
            "npm",
            "--prefix",
            SELENIUM_PACKAGE_DIRECTORY,
            "run",
            "web-calculator",
            "--",
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
    relativeStep({
      id: `${capability.id}-artifact-contracts`,
      kind: "command",
      phase: "evidence",
      capabilityId: capability.id,
      command: process.execPath,
      arguments: [".github/scripts/validate-e2e-reports.mjs"],
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

export function createSeleniumQualificationPlan({
  observation,
  catalog,
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
    ...PACKAGE_NAMES.map((name) =>
      relativeStep({
        id: {
          [AXE_PACKAGE]: "cache-selenium-axe-webdriver-tarball",
          [AXE_CORE_PACKAGE]: "cache-selenium-axe-core-tarball",
          [SELENIUM_PACKAGE]: "cache-selenium-webdriver-tarball",
        }[name],
        kind: "command",
        phase: "prepare",
        command: "npm",
        arguments: [
          "cache",
          "add",
          candidate.packages[name].dist.tarball,
          "--cache",
          ".npm-cache",
        ],
      })),
    relativeStep({
      id: "apply-selenium-tarballs",
      kind: "command",
      phase: "prepare",
      command: "npm",
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
    relativeStep({
      id: "install-selenium-candidate",
      kind: "command",
      phase: "prepare",
      command: "npm",
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
    relativeStep({
      id: "test-selenium-package",
      kind: "command",
      phase: "package-test",
      command: "npm",
      arguments: [
        "--prefix",
        SELENIUM_PACKAGE_DIRECTORY,
        "test",
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
      capabilitySteps(capability, candidate)),
  ];
  return {
    schema_version: 1,
    kind: "selenium-qualification-plan",
    provider_id: SELENIUM_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    repository: structuredClone(observation.repository),
    workspace: {
      kind: "ephemeral-copy",
      mutation_boundary: SELENIUM_PACKAGE_DIRECTORY,
      managed_paths: [...SELENIUM_MANAGED_PATHS],
    },
    packages: PACKAGE_NAMES.map((name) =>
      structuredClone(candidate.packages[name])),
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

async function runRawCommand(step, { environment, workspaceRoot }) {
  return new Promise((resolvePromise) => {
    const child = spawn(step.command, step.arguments, {
      cwd:
        step.id.startsWith("cache-selenium-") ||
        step.id === "apply-selenium-tarballs" ||
        step.id === "install-selenium-candidate"
          ? resolve(workspaceRoot, SELENIUM_PACKAGE_DIRECTORY)
          : resolve(workspaceRoot, step.cwd),
      env: {
        ...environment,
        ...step.environment,
        GITHUB_WORKSPACE: workspaceRoot,
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
    child.on("error", (error) => {
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: `${stderr}${error.message}`,
        signal: null,
      });
    });
    child.on("close", (exitCode, signal) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        signal,
      });
    });
  });
}

function warningLines(output) {
  const warningPattern =
    /(?:\bwarn(?:ing)?s?\b|\b[A-Za-z][A-Za-z0-9_-]*warnings?\b)/iu;
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => warningPattern.test(line) && line.length > 0);
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
      step,
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

async function verifyExecutableIdentity(identity) {
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
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`${identity.kind} executable must be an executable file`);
  }
  if (hash(await readFile(identity.realpath)) !== identity.executable_digest) {
    throw new Error(
      `${identity.kind} executable digest does not match runner evidence`,
    );
  }
}

function exactExecutableVersion(kind, output, identity) {
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

async function executeControlledStep(
  step,
  plan,
  {
    environment,
    now,
    runCommand,
    workspaceRoot,
  },
) {
  const startedAt = timestamp(now());
  let raw;
  let commandOutput = "";
  const identity =
    step.kind === "browser-identity"
      ? plan.runner.browser
      : step.kind === "driver-identity"
        ? plan.runner.driver
        : null;
  try {
    if (identity !== null) {
      if (step.command !== identity.realpath) {
        throw new Error(
          `${identity.kind} command does not match observed executable realpath`,
        );
      }
      await verifyExecutableIdentity(identity);
    }
    const controlledEnvironment = {
      ...environment,
      ...step.environment,
      GITHUB_WORKSPACE: workspaceRoot,
    };
    raw = assertRawCommandResult(
      await runCommand(structuredClone(step), {
        environment: controlledEnvironment,
        packageRoot: resolve(workspaceRoot, SELENIUM_PACKAGE_DIRECTORY),
        workspaceRoot,
      }),
      step.id,
    );
    commandOutput = `${raw.stdout}${raw.stderr}`;
  } catch (error) {
    raw = {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: error.message,
    };
  }
  if (identity !== null && raw.exitCode === 0) {
    try {
      await verifyExecutableIdentity(identity);
    } catch (error) {
      raw = {
        ...raw,
        exitCode: 1,
        stderr: `${raw.stderr}${error.message}`,
      };
    }
  }
  const completedAt = timestamp(now());
  const output = `${raw.stdout}${raw.stderr}`;
  let identityMatches = true;
  if (identity !== null && raw.exitCode === 0) {
    try {
      identityMatches = exactExecutableVersion(
        identity.kind,
        raw.stdout,
        identity,
      );
    } catch {
      identityMatches = false;
    }
  }
  return {
    id: step.id,
    phase: step.phase,
    capability_id: step.capability_id,
    scenario: step.scenario,
    status:
      raw.exitCode === 0 && identityMatches ? "pass" : "fail",
    warnings: sortedUnique(warningLines(commandOutput)),
    evidence: [
      commandEvidence(step, plan, raw, startedAt, completedAt),
    ],
  };
}

function lockPackage(lock, name) {
  return lock.packages?.[`node_modules/${name}`];
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

async function verifyInstalledPackages(plan, workspaceRoot) {
  for (const expected of plan.packages) {
    const installed = parseJson(
      await readFile(
        resolve(
          workspaceRoot,
          SELENIUM_PACKAGE_DIRECTORY,
          "node_modules",
          ...expected.name.split("/"),
          "package.json",
        ),
        "utf8",
      ),
      `installed ${expected.name}`,
    );
    if (
      installed.name !== expected.name ||
      installed.version !== expected.version
    ) {
      throw new Error(
        `Installed ${expected.name} does not match immutable npm evidence`,
      );
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
          runner: plan.runner,
        }),
        started_at: startedAt,
        completed_at: completedAt,
      },
    ],
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

async function outsideBoundaryDigest(workspaceRoot, boundary) {
  const prefix = `${boundary}/`;
  const entries = (await treeEntries(workspaceRoot))
    .filter(
      ([path]) => path !== boundary && !path.startsWith(prefix),
    )
    .sort(([left], [right]) => compareText(left, right));
  return hash(entries);
}

async function sourceState(repositoryRoot) {
  return hash(
    (await treeEntries(repositoryRoot, repositoryRoot, {
      excludeRootNames: new Set([".git"]),
    })).sort(([left], [right]) => compareText(left, right)),
  );
}

function aggregateStatus(checks) {
  return checks.some(({ status }) => status !== "pass") ? "fail" : "pass";
}

function disposition(results, failures) {
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
    }),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

export async function qualifySeleniumCandidate(
  {
    observation,
    repositoryRoot,
  },
  {
    catalog,
    createWorkspace = defaultCreateWorkspace,
    environment = process.env,
    generatedAt = new Date().toISOString(),
    materializeWorkspace = copyRepository,
    now = () => new Date(),
    runCommand = runRawCommand,
  } = {},
) {
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
  const sourceBefore = await sourceState(root);
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
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog: catalogDocument,
    });
    const outsideBefore = await outsideBoundaryDigest(
      workspaceRoot,
      plan.workspace.mutation_boundary,
    );
    const checks = [];
    const failures = [];
    for (const id of [
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
        environment,
        now,
        runCommand,
        workspaceRoot,
      });
      checks.push(result);
      if (result.status !== "pass") {
        failures.push("APPLICATION_FAILED");
      }
    }

    if (failures.length === 0) {
      const lockResult = await runInternalCheck(
        "verify-selenium-lock",
        plan,
        now,
        () => verifyAppliedLock(plan, workspaceRoot),
      );
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
        environment,
        now,
        runCommand,
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
        () => verifyInstalledPackages(plan, workspaceRoot),
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
          environment,
          now,
          runCommand,
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
        environment,
        now,
        runCommand,
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
          environment,
          now,
          runCommand,
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
            environment,
            now,
            runCommand,
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

    const outsideAfter = await outsideBoundaryDigest(
      workspaceRoot,
      plan.workspace.mutation_boundary,
    );
    if (outsideAfter !== outsideBefore) {
      throw new Error(
        "Selenium qualification modified files outside its package boundary",
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
    execution = { plan, checks, results, failures };
  } catch (error) {
    workError = error;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  const [sourceAfter, checkoutAfter] = await Promise.all([
    sourceState(root),
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
  return {
    validation,
    checks: execution.checks,
  };
}
