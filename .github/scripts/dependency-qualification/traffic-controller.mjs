import {
  canonicalDocument,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
  validateProviderSet,
} from "./contract.mjs";

export const DEFAULT_TRAFFIC_LIMITS = Object.freeze({
  maxAssignments: 32,
  maxCombinations: 32,
});

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function sameRepository(left, right) {
  return (
    left.name === right.name &&
    left.revision === right.revision
  );
}

function sameCatalog(left, right) {
  return (
    left.schema_version === right.schema_version &&
    left.digest === right.digest
  );
}

function candidateCapabilities(observation) {
  return sortedUnique(
    observation.components
      .filter((component) => component.candidate !== null)
      .flatMap((component) => component.affected_capabilities),
  );
}

function resultBlockers(validation) {
  const blockers = validation.results
    .filter(
      (result) =>
        result.status !== "pass" || result.warnings.length > 0,
    )
    .map((result) => result.capability_id);
  return blockers.length > 0 ? sortedUnique(blockers) : [validation.provider_id];
}

function normalizeInput(providerSetOrInput, options) {
  if (providerSetOrInput?.kind === "provider-set") {
    return {
      ...options,
      providerSet: providerSetOrInput,
    };
  }
  if (
    providerSetOrInput === null ||
    typeof providerSetOrInput !== "object" ||
    Array.isArray(providerSetOrInput)
  ) {
    throw new Error("traffic-controller input must be an object");
  }
  return {
    ...providerSetOrInput,
    ...options,
  };
}

function normalizeLimits(limits = {}) {
  if (
    limits === null ||
    typeof limits !== "object" ||
    Array.isArray(limits)
  ) {
    throw new Error("limits must be an object");
  }
  const normalized = {
    maxAssignments:
      limits.maxAssignments ?? DEFAULT_TRAFFIC_LIMITS.maxAssignments,
    maxCombinations:
      limits.maxCombinations ?? DEFAULT_TRAFFIC_LIMITS.maxCombinations,
  };
  assertPositiveLimit(normalized.maxAssignments, "maxAssignments");
  assertPositiveLimit(normalized.maxCombinations, "maxCombinations");
  return normalized;
}

function deterministicTimestamp(providers, validations) {
  return [...providers, ...validations]
    .map((document) => document.generated_at)
    .sort(compareStrings)
    .at(-1);
}

function validationState(observation, validation, contractOptions) {
  if (validation !== undefined) {
    if (validation.provider_id !== observation.provider_id) {
      throw new Error(
        `validation provider ${validation.provider_id} does not match ${observation.provider_id}`,
      );
    }
    if (!sameRepository(validation.repository, observation.repository)) {
      throw new Error(
        `validation ${validation.provider_id} does not match its observation repository`,
      );
    }
    if (
      !sameCatalog(
        validation.capability_catalog,
        observation.capability_catalog,
      )
    ) {
      throw new Error(
        `validation ${validation.provider_id} does not match its observation capability catalog`,
      );
    }
    const digest = subjectDigest(observation);
    if (validation.candidate_digest !== digest) {
      throw new Error(
        `validation ${validation.provider_id} candidate digest must equal ${digest}`,
      );
    }
  }
  if (observation.disposition.state === "unknown") {
    return {
      blockers: [observation.provider_id],
      eligibility: "unknown",
    };
  }
  if (observation.disposition.state === "unavailable") {
    return {
      blockers: [observation.provider_id],
      eligibility: "unavailable",
    };
  }
  if (validation === undefined) {
    return {
      blockers: [observation.provider_id],
      eligibility: "unknown",
    };
  }

  switch (validation.disposition.state) {
    case "independently-qualified":
      validateIndependentQualification(
        observation,
        validation,
        contractOptions,
      );
      return {
        blockers: [],
        eligibility: "eligible",
      };
    case "blocked":
      return {
        blockers: resultBlockers(validation),
        eligibility: "blocked",
      };
    case "incompatible":
      return {
        blockers: resultBlockers(validation),
        eligibility: "incompatible",
      };
    case "unavailable":
      return {
        blockers: resultBlockers(validation),
        eligibility: "unavailable",
      };
    case "independent-testing":
    case "unknown":
      return {
        blockers: resultBlockers(validation),
        eligibility: "unknown",
      };
    default:
      throw new Error(
        `unsupported validation disposition ${validation.disposition.state}`,
      );
  }
}

const NODE_MAJOR_RELATION =
  "node-runtime major must equal node-release-channel";
const PLAYWRIGHT_PACKAGE_NAMES = [
  "@axe-core/playwright",
  "@playwright/test",
  "playwright",
  "playwright-core",
];
const PLAYWRIGHT_LOCKSTEP_NAMES = [
  "@playwright/test",
  "playwright",
  "playwright-core",
];
const PLAYWRIGHT_PACKAGE_IDENTITY_KEYS = [
  "axePeerRange",
  "integrities",
  "nodeRanges",
  "packages",
  "tarballs",
];
const VERSION_PART = "(?:0|[1-9][0-9]*)";
const FULL_VERSION_PATTERN = new RegExp(
  `^(${VERSION_PART})\\.(${VERSION_PART})\\.(${VERSION_PART})$`,
  "u",
);
const PARTIAL_VERSION_PATTERN = new RegExp(
  `^(${VERSION_PART})(?:\\.(${VERSION_PART}))?(?:\\.(${VERSION_PART}))?$`,
  "u",
);

function parseVersion(value, { allowPartial = false } = {}) {
  if (typeof value !== "string") {
    throw new Error("semantic version must be a string");
  }
  const pattern = allowPartial
    ? PARTIAL_VERSION_PATTERN
    : FULL_VERSION_PATTERN;
  const match = pattern.exec(value);
  if (match === null) {
    throw new Error(`unsupported semantic version ${value}`);
  }
  const parts = match.slice(1).map((part) =>
    part === undefined ? 0 : Number(part),
  );
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`unsupported semantic version ${value}`);
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function tildeUpperBound(version) {
  return {
    ...version,
    minor: version.minor + 1,
    patch: 0,
  };
}

function caretUpperBound(version) {
  if (version.major > 0) {
    return {
      ...version,
      major: version.major + 1,
      minor: 0,
      patch: 0,
    };
  }
  if (version.minor > 0) {
    return {
      ...version,
      minor: version.minor + 1,
      patch: 0,
    };
  }
  return {
    ...version,
    patch: version.patch + 1,
  };
}

function comparatorMatches(version, operator, expected) {
  const comparison = compareVersions(version, expected);
  switch (operator) {
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "=":
      return comparison === 0;
    default:
      throw new Error(`unsupported version comparator ${operator}`);
  }
}

function tokenMatches(version, token) {
  if (token.startsWith("^")) {
    const expected = parseVersion(token.slice(1));
    return (
      compareVersions(version, expected) >= 0 &&
      compareVersions(version, caretUpperBound(expected)) < 0
    );
  }
  if (token.startsWith("~")) {
    const expected = parseVersion(token.slice(1));
    return (
      compareVersions(version, expected) >= 0 &&
      compareVersions(version, tildeUpperBound(expected)) < 0
    );
  }
  const comparator = /^(>=|<=|>|<)(.+)$/u.exec(token);
  if (comparator !== null) {
    return comparatorMatches(
      version,
      comparator[1],
      parseVersion(comparator[2], { allowPartial: true }),
    );
  }
  const exact = token.startsWith("=") ? token.slice(1) : token;
  return comparatorMatches(version, "=", parseVersion(exact));
}

function rangeClauseMatches(version, clause) {
  if (
    clause.length === 0 ||
    clause.includes(",") ||
    /[*xX]/u.test(clause)
  ) {
    throw new Error(`unsupported semantic version range ${clause}`);
  }
  const normalized = clause.replace(
    /(>=|<=|>|<|=)\s+(?=[0-9])/gu,
    "$1",
  );
  const tokens = normalized.split(/\s+/u);
  return tokens
    .map((token) => tokenMatches(version, token))
    .every(Boolean);
}

export function versionSatisfies(versionValue, constraint) {
  if (typeof constraint !== "string" || constraint.trim().length === 0) {
    throw new Error("version constraint must be a nonempty string");
  }
  const version = parseVersion(versionValue);
  const clauses = constraint.split("||").map((clause) => clause.trim());
  if (clauses.some((clause) => clause.length === 0)) {
    throw new Error(`unsupported semantic version range ${constraint}`);
  }
  return clauses
    .map((clause) => rangeClauseMatches(version, clause))
    .some(Boolean);
}

function supported(satisfied) {
  return {
    satisfied,
    supported: true,
  };
}

function unsupported() {
  return {
    satisfied: false,
    supported: false,
  };
}

function evaluateVersionRange(version, constraint) {
  try {
    return supported(versionSatisfies(version, constraint));
  } catch {
    return unsupported();
  }
}

function parseJsonObject(value) {
  if (!value.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseKeyValueConstraint(value) {
  const entries = new Map();
  const parts = value.split(";");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      return null;
    }
    const key = part.slice(0, separator);
    const entryValue = part.slice(separator + 1);
    if (
      !/^[a-z][a-z0-9-]*$/u.test(key) ||
      entryValue.length === 0 ||
      entries.has(key)
    ) {
      return null;
    }
    entries.set(key, entryValue);
  }
  return entries;
}

function parseVersionObject(value) {
  const parsed = parseJsonObject(value);
  return parsed === undefined ? null : parsed;
}

function hasExactObjectKeys(value, expected) {
  return (
    value !== null &&
    value !== undefined &&
    JSON.stringify(Object.keys(value).sort(compareStrings)) ===
      JSON.stringify([...expected].sort(compareStrings))
  );
}

function hasExactMapKeys(value, expected) {
  return (
    JSON.stringify([...value.keys()].sort(compareStrings)) ===
    JSON.stringify([...expected].sort(compareStrings))
  );
}

function isNonemptyTrimmedString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value
  );
}

function hasStrictVersionValues(value) {
  try {
    for (const version of Object.values(value)) {
      parseVersion(version);
    }
    return true;
  } catch {
    return false;
  }
}

function hasSupportedRangeValues(value) {
  return Object.values(value).every(
    (range) =>
      isNonemptyTrimmedString(range) &&
      evaluateVersionRange("0.0.0", range).supported,
  );
}

function parsePlaywrightPackageIdentity(value) {
  const identity = parseVersionObject(value);
  if (
    identity === null ||
    !hasExactObjectKeys(identity, PLAYWRIGHT_PACKAGE_IDENTITY_KEYS) ||
    !isNonemptyTrimmedString(identity.axePeerRange) ||
    !evaluateVersionRange("0.0.0", identity.axePeerRange).supported
  ) {
    return null;
  }
  for (const key of ["integrities", "nodeRanges", "packages", "tarballs"]) {
    if (
      identity[key] === null ||
      typeof identity[key] !== "object" ||
      Array.isArray(identity[key]) ||
      !hasExactObjectKeys(identity[key], PLAYWRIGHT_PACKAGE_NAMES)
    ) {
      return null;
    }
  }
  if (
    !Object.values(identity.integrities).every(isNonemptyTrimmedString) ||
    !Object.values(identity.tarballs).every(isNonemptyTrimmedString) ||
    !hasSupportedRangeValues(identity.nodeRanges) ||
    !Object.values(identity.packages).every(isNonemptyTrimmedString) ||
    !hasStrictVersionValues(identity.packages)
  ) {
    return null;
  }
  return identity;
}

function parsePlaywrightBrowserIdentity(value) {
  const identity = parseVersionObject(value);
  if (
    identity === null ||
    !hasExactObjectKeys(identity, ["name", "revision"]) ||
    !isNonemptyTrimmedString(identity.name) ||
    !isNonemptyTrimmedString(identity.revision) ||
    identity.name === "unknown" ||
    identity.revision === "unknown"
  ) {
    return null;
  }
  return identity;
}

function parsePlaywrightLockstepConstraint(value) {
  if (
    value === undefined ||
    !hasExactObjectKeys(value, PLAYWRIGHT_LOCKSTEP_NAMES) ||
    !Object.values(value).every(isNonemptyTrimmedString) ||
    !hasStrictVersionValues(value) ||
    new Set(Object.values(value)).size !== 1
  ) {
    return null;
  }
  return value;
}

function evaluateRanges(version, ranges) {
  for (const range of ranges) {
    const result = evaluateVersionRange(version, range);
    if (!result.supported) {
      return result;
    }
    if (!result.satisfied) {
      return result;
    }
  }
  return supported(true);
}

function componentSelection(component, providerState) {
  if (providerState === "candidate" && component.candidate !== null) {
    return {
      state: "candidate",
      version: component.candidate.version,
    };
  }
  return {
    state: "current",
    version: component.current.version,
  };
}

function relationIsActive(relation, from, to, providerStates) {
  const fromProviderState = providerStates.get(from.providerId);
  const toProviderState = providerStates.get(to.providerId);
  switch (relation.type) {
    case "shares-runtime":
    case "policy-align":
      return (
        fromProviderState === "candidate" ||
        toProviderState === "candidate"
      );
    case "requires":
      return (
        fromProviderState === "candidate" ||
        toProviderState === "candidate"
      );
    case "bundles":
    case "must-match":
    case "uses-external":
      return from.selection.state === "candidate";
    default:
      throw new Error(`unsupported relation type ${relation.type}`);
  }
}

function stateConstraintEvaluation(constraint, from, to) {
  switch (constraint) {
    case "candidate":
      return supported(to.selection.state === "candidate");
    case "current":
      return supported(to.selection.state === "current");
    case "same-state":
    case "lockstep":
      return supported(from.selection.state === to.selection.state);
    default:
      return null;
  }
}

function evaluateNodeMajorRelation(from, to) {
  try {
    const runtime = parseVersion(from.selection.version);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(to.selection.version)) {
      return unsupported();
    }
    const channel = Number(to.selection.version);
    if (!Number.isSafeInteger(channel)) {
      return unsupported();
    }
    return supported(runtime.major === channel);
  } catch {
    return unsupported();
  }
}

function evaluateRequires(constraint, from, to) {
  if (constraint === null) {
    return supported(to.selection.state === "candidate");
  }
  if (constraint === NODE_MAJOR_RELATION) {
    return evaluateNodeMajorRelation(from, to);
  }

  const json = parseJsonObject(constraint);
  if (json !== null) {
    const source = parsePlaywrightPackageIdentity(from.selection.version);
    if (
      json === undefined ||
      source === null ||
      !hasExactObjectKeys(json, PLAYWRIGHT_PACKAGE_NAMES) ||
      !Object.values(json).every(isNonemptyTrimmedString) ||
      !hasSupportedRangeValues(json)
    ) {
      return unsupported();
    }
    if (
      from.selection.state === "candidate" &&
      PLAYWRIGHT_PACKAGE_NAMES.some(
        (name) => source.nodeRanges[name] !== json[name],
      )
    ) {
      return supported(false);
    }
    return evaluateRanges(
      to.selection.version,
      Object.values(source.nodeRanges),
    );
  }

  const entries = parseKeyValueConstraint(constraint);
  if (
    entries !== null &&
    [...entries.keys()].every((key) =>
      ["candidate", "current", "root"].includes(key),
    ) &&
    entries.has("candidate") &&
    entries.has("current")
  ) {
    const selectedRange = entries.get(from.selection.state);
    if (selectedRange === "none") {
      return unsupported();
    }
    const ranges = [
      ...(entries.has("root") ? [entries.get("root")] : []),
      selectedRange,
    ];
    return evaluateRanges(to.selection.version, ranges);
  }

  const cypress =
    /^(.+); repository Node ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) \(configured ((?:0|[1-9][0-9]*))\)$/u
      .exec(constraint);
  if (cypress !== null) {
    let repositoryVersion;
    try {
      repositoryVersion = parseVersion(cypress[2]);
    } catch {
      return unsupported();
    }
    if (repositoryVersion.major !== Number(cypress[3])) {
      return supported(false);
    }
    return evaluateVersionRange(to.selection.version, cypress[1]);
  }

  return evaluateVersionRange(to.selection.version, constraint);
}

function evaluateMustMatch(constraint, from, to) {
  if (constraint === null) {
    return supported(from.selection.version === to.selection.version);
  }
  const json = parseJsonObject(constraint);
  if (json !== null) {
    const source = parsePlaywrightPackageIdentity(from.selection.version);
    const target = parsePlaywrightBrowserIdentity(to.selection.version);
    const lockstep = parsePlaywrightLockstepConstraint(json);
    if (
      source === null ||
      target === null ||
      lockstep === null
    ) {
      return unsupported();
    }
    return supported(
      PLAYWRIGHT_LOCKSTEP_NAMES.every(
        (name) => source.packages[name] === lockstep[name],
      ),
    );
  }

  const entries = parseKeyValueConstraint(constraint);
  if (
    entries !== null &&
    hasExactMapKeys(entries, [
      "browser",
      "browser-key",
      "driver",
      "driver-key",
      "runner",
    ])
  ) {
    return supported(
      entries.get("browser-key") !== "missing" &&
      entries.get("browser-key") === entries.get("driver-key"),
    );
  }

  const cypress =
    /^Cypress package ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) must match the downloaded Cypress binary$/u
      .exec(constraint);
  if (cypress !== null) {
    return supported(
      from.selection.version === cypress[1] &&
      to.selection.version === cypress[1],
    );
  }

  const source = evaluateVersionRange(from.selection.version, constraint);
  const target = evaluateVersionRange(to.selection.version, constraint);
  if (!source.supported || !target.supported) {
    return unsupported();
  }
  return supported(
    source.satisfied &&
    target.satisfied &&
    from.selection.version === to.selection.version,
  );
}

function splitPackageReference(value) {
  const separator = value.lastIndexOf("@");
  if (separator < 1 || separator === value.length - 1) {
    return null;
  }
  return {
    name: value.slice(0, separator),
    version: value.slice(separator + 1),
  };
}

function evaluateBundles(constraint, from, to) {
  if (to.selection.state !== "candidate") {
    return supported(false);
  }
  if (constraint === null) {
    return supported(true);
  }
  const json = parseJsonObject(constraint);
  if (json !== null) {
    const source = parsePlaywrightPackageIdentity(from.selection.version);
    const target = parsePlaywrightBrowserIdentity(to.selection.version);
    const packageReference =
      typeof json?.package === "string"
        ? splitPackageReference(json.package)
        : null;
    if (
      json === undefined ||
      source === null ||
      target === null ||
      !hasExactObjectKeys(json, [
        "browser",
        "package",
        "revision",
      ]) ||
      packageReference === null ||
      packageReference.name !== "playwright-core" ||
      !isNonemptyTrimmedString(json.browser) ||
      !isNonemptyTrimmedString(json.package) ||
      !isNonemptyTrimmedString(json.revision) ||
      json.browser === "unknown" ||
      json.revision === "unknown" ||
      !hasStrictVersionValues({
        package: packageReference.version,
      })
    ) {
      return unsupported();
    }
    return supported(
      source.packages[packageReference.name] ===
        packageReference.version &&
      target.name === json.browser &&
      target.revision === json.revision,
    );
  }
  return evaluateVersionRange(to.selection.version, constraint);
}

function evaluateExternalBrowser(constraint, to) {
  const targetEntries = to.selection.version.split(", ");
  const requirements = constraint.split("; ");
  if (requirements.length === 0) {
    return unsupported();
  }
  for (const requirement of requirements) {
    const match =
      /^([a-z0-9]+(?:-[a-z0-9]+)*) requires ([a-z0-9-]+) on ([a-z0-9-]+) \(([^()]+)\)$/u
        .exec(requirement);
    if (match === null) {
      return unsupported();
    }
    const [, , browser, runner, version] = match;
    if (
      !targetEntries.some(
        (entry) =>
          entry.startsWith(`${browser}@${version} on `) &&
          entry.endsWith(`/${runner}`),
      )
    ) {
      return supported(false);
    }
  }
  return supported(true);
}

function evaluateUsesExternal(constraint, to) {
  if (constraint === null) {
    return supported(true);
  }
  if (constraint.includes(" requires ") && constraint.includes(" on ")) {
    return evaluateExternalBrowser(constraint, to);
  }
  return evaluateVersionRange(to.selection.version, constraint);
}

function evaluatePolicyAlign(constraint, from, to) {
  if (constraint === null) {
    return supported(from.selection.version === to.selection.version);
  }
  const json = parseJsonObject(constraint);
  if (json !== null) {
    const source = parsePlaywrightPackageIdentity(from.selection.version);
    const target = parsePlaywrightBrowserIdentity(to.selection.version);
    const packageReference =
      typeof json?.package === "string"
        ? splitPackageReference(json.package)
        : null;
    const peerReference =
      typeof json?.peer === "string"
        ? splitPackageReference(json.peer)
        : null;
    if (
      json === undefined ||
      source === null ||
      target === null ||
      !hasExactObjectKeys(json, ["package", "peer"]) ||
      packageReference === null ||
      peerReference === null ||
      packageReference.name !== "@axe-core/playwright" ||
      peerReference.name !== "playwright-core" ||
      !isNonemptyTrimmedString(json.package) ||
      !isNonemptyTrimmedString(json.peer) ||
      !hasStrictVersionValues({
        package: packageReference.version,
      })
    ) {
      return unsupported();
    }
    if (
      source.packages[packageReference.name] !==
        packageReference.version
    ) {
      return supported(false);
    }
    return evaluateVersionRange(
      source.packages[peerReference.name],
      peerReference.version,
    );
  }

  const entries = parseKeyValueConstraint(constraint);
  if (entries !== null) {
    const peerRange = entries.get(
      `${from.selection.state}-selenium-peer`,
    );
    if (peerRange === undefined || peerRange === "none") {
      return unsupported();
    }
    return evaluateVersionRange(to.selection.version, peerRange);
  }

  const cypress =
    /^axe-core ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)) remains an independently tested accessibility advisory$/u
      .exec(constraint);
  if (cypress !== null) {
    return supported(to.selection.version === cypress[1]);
  }
  return evaluateVersionRange(to.selection.version, constraint);
}

function relationEvaluation(relation, from, to) {
  const stateEvaluation =
    relation.constraint === null
      ? null
      : stateConstraintEvaluation(relation.constraint, from, to);
  if (stateEvaluation !== null) {
    return stateEvaluation;
  }

  switch (relation.type) {
    case "requires":
      return evaluateRequires(relation.constraint, from, to);
    case "bundles":
      return evaluateBundles(relation.constraint, from, to);
    case "must-match":
      return evaluateMustMatch(relation.constraint, from, to);
    case "shares-runtime":
      if (relation.constraint === null) {
        return supported(
          from.selection.version === to.selection.version,
        );
      }
      return evaluateVersionRange(
        to.selection.version,
        relation.constraint,
      );
    case "uses-external":
      return evaluateUsesExternal(relation.constraint, to);
    case "policy-align":
      return evaluatePolicyAlign(relation.constraint, from, to);
    default:
      throw new Error(`unsupported relation type ${relation.type}`);
  }
}

function assignmentId(providers, selectedProviders) {
  return providers
    .map(
      (provider) =>
        `${provider.provider_id}-${
          selectedProviders.has(provider.provider_id)
            ? "candidate"
            : "current"
        }`,
    )
    .join("-");
}

function selectedResults(selectedProviders, candidatesByProvider) {
  const results = new Map();
  for (const providerId of [...selectedProviders].sort(compareStrings)) {
    const validation = candidatesByProvider.get(providerId).validation;
    for (const result of validation.results) {
      const current = results.get(result.capability_id);
      const normalized = {
        capability_id: result.capability_id,
        status: result.status,
        warnings: [...result.warnings].sort(compareStrings),
      };
      if (current === undefined) {
        results.set(result.capability_id, normalized);
        continue;
      }
      if (
        current.status !== normalized.status ||
        JSON.stringify(current.warnings) !==
          JSON.stringify(normalized.warnings)
      ) {
        throw new Error(
          `selected candidates disagree on capability ${result.capability_id}`,
        );
      }
    }
  }
  return [...results.values()].sort((left, right) =>
    compareStrings(left.capability_id, right.capability_id),
  );
}

function evaluateAssignment({
  candidatesByProvider,
  componentsById,
  providers,
  relations,
  selectedProviders,
}) {
  const providerStates = new Map(
    providers.map((provider) => [
      provider.provider_id,
      selectedProviders.has(provider.provider_id)
        ? "candidate"
        : "current",
    ]),
  );
  const selectedComponents = new Map(
    [...componentsById].map(([componentId, component]) => [
      componentId,
      {
        ...component,
        selection: componentSelection(
          component.component,
          providerStates.get(component.providerId),
        ),
      },
    ]),
  );
  const hardViolations = [];
  const advisoryViolations = [];
  for (const relation of relations) {
    const from = selectedComponents.get(relation.from);
    const to = selectedComponents.get(relation.to);
    if (!relationIsActive(relation, from, to, providerStates)) {
      continue;
    }
    const evaluation = relationEvaluation(relation, from, to);
    if (!evaluation.supported || !evaluation.satisfied) {
      (relation.hard ? hardViolations : advisoryViolations)
        .push(relation.id);
    }
  }
  const results = selectedResults(
    selectedProviders,
    candidatesByProvider,
  );
  if (
    results.some(
      (result) =>
        result.status !== "pass" || result.warnings.length > 0,
    )
  ) {
    hardViolations.push(
      ...results
        .filter(
          (result) =>
            result.status !== "pass" || result.warnings.length > 0,
        )
        .map((result) => result.capability_id),
    );
  }
  const selections = providers.map((provider) => {
    const candidate = candidatesByProvider.get(provider.provider_id);
    const selected = selectedProviders.has(provider.provider_id);
    return {
      provider_id: provider.provider_id,
      state: selected ? "candidate" : "current",
      candidate_digest: selected ? candidate.digest : null,
    };
  });
  return {
    advisoryViolations: sortedUnique(advisoryViolations),
    assignment: {
      id: assignmentId(providers, selectedProviders),
      selections,
      results,
      maximal: true,
    },
    compatible: hardViolations.length === 0,
    hardViolations: sortedUnique(hardViolations),
    selectedCount: selectedProviders.size,
    selectedProviders,
  };
}

function isStrictSubset(left, right) {
  return (
    left.size < right.size &&
    [...left].every((value) => right.has(value))
  );
}

function maximalAssignments(compatible) {
  return compatible.filter(
    (candidate) =>
      !compatible.some((other) =>
        isStrictSubset(
          candidate.selectedProviders,
          other.selectedProviders,
        ),
      ),
  );
}

function frontierOrder(left, right) {
  return (
    right.selectedCount - left.selectedCount ||
    left.advisoryViolations.length - right.advisoryViolations.length ||
    compareStrings(left.assignment.id, right.assignment.id)
  );
}

function closestFailure(evaluations) {
  return [...evaluations]
    .filter((evaluation) => evaluation.selectedCount > 0)
    .sort(
      (left, right) =>
        left.hardViolations.length - right.hardViolations.length ||
        right.selectedCount - left.selectedCount ||
        compareStrings(left.assignment.id, right.assignment.id),
    )[0];
}

function candidateFailureBlockers(candidate, evaluations) {
  const closest = [...evaluations]
    .filter(
      (evaluation) =>
        evaluation.selectedProviders.has(candidate.providerId) &&
        !evaluation.compatible,
    )
    .sort(
      (left, right) =>
        left.hardViolations.length - right.hardViolations.length ||
        right.selectedCount - left.selectedCount ||
        compareStrings(left.assignment.id, right.assignment.id),
    )[0];
  return closest?.hardViolations ?? [candidate.providerId];
}

function reasonCodeForAdvisory(relationId) {
  return `ADVISORY_${relationId.toUpperCase().replaceAll("-", "_")}`;
}

function dispositionFor({
  candidateRecords,
  evaluations,
  fullEvaluation,
  maximal,
}) {
  const byEligibility = (eligibility) =>
    candidateRecords.filter(
      (candidate) => candidate.eligibility === eligibility,
    );
  for (const [eligibility, state, reason] of [
    ["unavailable", "unavailable", "EVIDENCE_UNAVAILABLE"],
    ["unknown", "unknown", "EVIDENCE_UNKNOWN"],
    ["blocked", "blocked", "VALIDATION_BLOCKED"],
    ["incompatible", "incompatible", "VALIDATION_INCOMPATIBLE"],
  ]) {
    const matching = byEligibility(eligibility);
    if (matching.length > 0) {
      return {
        blockers: sortedUnique(
          matching.flatMap((candidate) => candidate.blockers),
        ),
        reasonCodes: [reason],
        state,
      };
    }
  }

  if (candidateRecords.length === 0) {
    return {
      blockers: [],
      reasonCodes: ["NO_CANDIDATES"],
      state: "unavailable",
    };
  }

  if (fullEvaluation.compatible) {
    const coupled = candidateRecords.some((candidate) => {
      const singleton = evaluations.find(
        (evaluation) =>
          evaluation.selectedCount === 1 &&
          evaluation.selectedProviders.has(candidate.providerId),
      );
      return singleton !== undefined && !singleton.compatible;
    });
    return {
      blockers: [],
      reasonCodes: [
        coupled
          ? "COUPLED_COMPATIBLE"
          : "INDEPENDENTLY_COMPATIBLE",
      ],
      state: "cohort-planned",
    };
  }

  if (maximal.length > 0) {
    const viableProviders = new Set(
      maximal.flatMap((evaluation) =>
        [...evaluation.selectedProviders],
      ),
    );
    const intrinsic = candidateRecords.filter(
      (candidate) =>
        candidate.eligibility === "eligible" &&
        !viableProviders.has(candidate.providerId),
    );
    if (intrinsic.length > 0) {
      return {
        blockers: sortedUnique(
          intrinsic.flatMap((candidate) =>
            candidateFailureBlockers(candidate, evaluations),
          ),
        ),
        reasonCodes: ["INTRINSIC_CANDIDATE_INCOMPATIBLE"],
        state: "incompatible",
      };
    }
    return {
      blockers: fullEvaluation.hardViolations,
      reasonCodes: ["CANDIDATES_MUTUALLY_EXCLUSIVE"],
      state: "mutually-exclusive",
    };
  }

  const closest = closestFailure(evaluations);
  return {
    blockers: closest?.hardViolations ?? [],
    reasonCodes: [
      candidateRecords.length > 1
        ? "NO_COMPATIBLE_ASSIGNMENT"
        : "HARD_RELATION_INCOMPATIBLE",
    ],
    state:
      candidateRecords.length > 1 ? "gridlocked" : "incompatible",
  };
}

export function solveTrafficControl(providerSetOrInput, options = {}) {
  const input = normalizeInput(providerSetOrInput, options);
  const {
    capabilityIds,
    providerSet,
  } = input;
  if (!(capabilityIds instanceof Set)) {
    throw new Error("capabilityIds must be a Set");
  }
  if (providerSet?.kind !== "provider-set") {
    throw new Error("providerSet must be a provider-set");
  }
  const capabilityCatalogDigest =
    input.capabilityCatalogDigest ??
    providerSet.capability_catalog?.digest;
  const contractOptions = {
    capabilityCatalogDigest,
    capabilityIds,
  };
  const normalizedProviderSet = validateProviderSet(
    providerSet.providers,
    contractOptions,
  );
  if (
    !sameRepository(
      providerSet.repository,
      normalizedProviderSet.repository,
    ) ||
    !sameCatalog(
      providerSet.capability_catalog,
      normalizedProviderSet.capability_catalog,
    )
  ) {
    throw new Error("providerSet aggregate does not match its providers");
  }

  const validations = input.validations ?? [];
  if (!Array.isArray(validations)) {
    throw new Error("validations must be an array");
  }
  const validationsByProvider = new Map();
  for (const validation of validations) {
    validateDocument(validation, contractOptions);
    if (validation.kind !== "validation") {
      throw new Error("validations must contain validation documents");
    }
    if (validationsByProvider.has(validation.provider_id)) {
      throw new Error(
        `duplicate validation provider ${validation.provider_id}`,
      );
    }
    validationsByProvider.set(validation.provider_id, validation);
  }

  const providers = [...normalizedProviderSet.providers].sort(
    (left, right) =>
      compareStrings(left.provider_id, right.provider_id),
  );
  const candidateRecords = [];
  for (const observation of providers) {
    const capabilities = candidateCapabilities(observation);
    const validation = validationsByProvider.get(
      observation.provider_id,
    );
    if (
      observation.disposition.state === "unknown" ||
      observation.disposition.state === "unavailable"
    ) {
      if (capabilities.length === 0 && validation !== undefined) {
        throw new Error(
          `validation ${observation.provider_id} has no candidate observation`,
        );
      }
      const status = validationState(
        observation,
        validation,
        contractOptions,
      );
      candidateRecords.push({
        ...status,
        capabilities,
        digest:
          capabilities.length === 0
            ? null
            : subjectDigest(observation),
        observation,
        providerId: observation.provider_id,
        validation,
      });
      continue;
    }
    if (capabilities.length === 0) {
      if (validation !== undefined) {
        throw new Error(
          `validation ${observation.provider_id} has no candidate observation`,
        );
      }
      continue;
    }
    const status = validationState(
      observation,
      validation,
      contractOptions,
    );
    candidateRecords.push({
      ...status,
      capabilities,
      digest: subjectDigest(observation),
      observation,
      providerId: observation.provider_id,
      validation,
    });
  }
  for (const providerId of validationsByProvider.keys()) {
    if (
      !candidateRecords.some(
        (candidate) => candidate.providerId === providerId,
      )
    ) {
      throw new Error(
        `validation ${providerId} does not match a candidate provider`,
      );
    }
  }

  const eligible = candidateRecords
    .filter((candidate) => candidate.eligibility === "eligible")
    .sort((left, right) =>
      compareStrings(left.providerId, right.providerId),
    );
  const limits = normalizeLimits(input.limits);
  const combinationCount = 1n << BigInt(eligible.length);
  if (combinationCount > BigInt(limits.maxCombinations)) {
    throw new Error(
      `Combination limit exceeded: ${combinationCount} assignments require evaluation, limit is ${limits.maxCombinations}`,
    );
  }

  const candidatesByProvider = new Map(
    eligible.map((candidate) => [candidate.providerId, candidate]),
  );
  const componentsById = new Map();
  const relations = [];
  for (const provider of providers) {
    for (const component of provider.components) {
      componentsById.set(component.id, {
        component,
        providerId: provider.provider_id,
      });
    }
    relations.push(...provider.relations);
  }
  relations.sort((left, right) => compareStrings(left.id, right.id));

  const evaluations = [];
  for (let mask = 0n; mask < combinationCount; mask += 1n) {
    const selectedProviders = new Set();
    for (const [index, candidate] of eligible.entries()) {
      if ((mask & (1n << BigInt(index))) !== 0n) {
        selectedProviders.add(candidate.providerId);
      }
    }
    evaluations.push(
      evaluateAssignment({
        candidatesByProvider,
        componentsById,
        providers,
        relations,
        selectedProviders,
      }),
    );
  }

  const compatible = evaluations.filter(
    (evaluation) =>
      evaluation.selectedCount > 0 && evaluation.compatible,
  );
  const maximal = maximalAssignments(compatible).sort(frontierOrder);
  if (maximal.length > limits.maxAssignments) {
    throw new Error(
      `Assignment limit exceeded: ${maximal.length} maximal assignments, limit is ${limits.maxAssignments}`,
    );
  }
  const allEligibleProviders = new Set(
    eligible.map((candidate) => candidate.providerId),
  );
  const fullEvaluation = evaluations.find(
    (evaluation) =>
      evaluation.selectedProviders.size === allEligibleProviders.size &&
      [...allEligibleProviders].every((providerId) =>
        evaluation.selectedProviders.has(providerId),
      ),
  );
  const disposition = dispositionFor({
    candidateRecords,
    evaluations,
    fullEvaluation,
    maximal,
  });
  const frontier = maximal[0] ?? null;
  const reasonCodes = [...disposition.reasonCodes];
  if (disposition.state === "cohort-planned" && frontier !== null) {
    reasonCodes.push(
      ...frontier.advisoryViolations.map(reasonCodeForAdvisory),
    );
  }
  const generatedAt =
    input.generatedAt ?? deterministicTimestamp(providers, validations);
  const plan = {
    schema_version: 1,
    kind: "plan",
    generated_at: generatedAt,
    repository: structuredClone(normalizedProviderSet.repository),
    capability_catalog: structuredClone(
      normalizedProviderSet.capability_catalog,
    ),
    disposition: {
      state: disposition.state,
      reason_codes: sortedUnique(reasonCodes),
    },
    assignments: maximal
      .map((evaluation) => evaluation.assignment)
      .sort((left, right) => compareStrings(left.id, right.id)),
    compatible_frontier: frontier?.assignment.id ?? null,
    minimal_blockers: sortedUnique(disposition.blockers),
  };
  validateDocument(plan, contractOptions);
  return plan;
}

export function canonicalTrafficPlan(providerSetOrInput, options = {}) {
  return canonicalDocument(
    solveTrafficControl(providerSetOrInput, options),
  );
}

export const createTrafficPlan = solveTrafficControl;
export const planTraffic = solveTrafficControl;
