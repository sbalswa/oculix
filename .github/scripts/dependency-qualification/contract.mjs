import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { validateCatalog } from "../plan-e2e.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REASON_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANDIDATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const VOLATILE_KEYS = new Set([
  "completed_at",
  "generated_at",
  "observed_at",
  "started_at",
]);

const OBSERVATION_STATES = new Set([
  "current",
  "candidate",
  "unknown",
  "unavailable",
]);
const VALIDATION_STATES = new Set([
  "independent-testing",
  "independently-qualified",
  "blocked",
  "incompatible",
  "unknown",
  "unavailable",
]);
const PLAN_STATES = new Set([
  "cohort-planned",
  "blocked",
  "incompatible",
  "mutually-exclusive",
  "gridlocked",
  "unknown",
  "unavailable",
]);
const COHORT_STATES = new Set([
  "cohort-testing",
  "ready-before-release",
  "blocked",
  "incompatible",
  "unknown",
  "unavailable",
]);
const RESULT_STATES = new Set([
  "pass",
  "fail",
  "blocked",
  "unknown",
  "not-selected",
  "not-validated",
]);
const RELATION_TYPES = new Set([
  "requires",
  "bundles",
  "must-match",
  "uses-external",
  "shares-runtime",
  "policy-align",
]);
const HARD_FAILURE_STATES = new Set([
  "blocked",
  "gridlocked",
  "incompatible",
  "mutually-exclusive",
  "unknown",
  "unavailable",
]);

function fail(path, message) {
  throw new Error(`${path} ${message}`);
}

function assertObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(path, "must be an object");
  }
}

function assertExactKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(path, `contains unknown keys: ${unknown.sort().join(", ")}`);
  }
}

function assertNonemptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a nonempty string");
  }
}

function assertId(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(path, "must be a kebab-case identifier");
  }
}

function assertTimestamp(value, path) {
  assertNonemptyString(value, path);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u
      .exec(value);
  if (match === null) {
    fail(path, "must be an RFC 3339 UTC timestamp");
  }
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    fail(path, "must be a real RFC 3339 UTC timestamp");
  }
}

function assertStringArray(
  value,
  path,
  { allowEmpty = true, pattern = null } = {},
) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail(path, "must be an array of nonempty strings");
  }
  if (new Set(value).size !== value.length) {
    fail(path, "must not contain duplicates");
  }
  if (pattern !== null) {
    for (const entry of value) {
      if (!pattern.test(entry)) {
        fail(path, `contains invalid value ${entry}`);
      }
    }
  }
}

function assertRepositoryPath(value, path) {
  assertNonemptyString(value, path);
  if (value.includes("\\") || /[*?[\]{}]/u.test(value)) {
    fail(path, "must not contain backslashes or glob syntax");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    normalized.startsWith("//") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(path, "must be a normalized repository-relative path");
  }
}

function assertDigest(value, path, { prefixed = false } = {}) {
  const pattern = prefixed ? DIGEST_PATTERN : CANDIDATE_DIGEST_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(
      path,
      prefixed
        ? "must be a lowercase sha256:<hex> digest"
        : "must be a lowercase SHA-256 hex digest",
    );
  }
}

function assertCapability(value, path, capabilityIds) {
  assertId(value, path);
  if (!capabilityIds.has(value)) {
    fail(path, `references unknown capability ${value}`);
  }
}

function validateRepository(repository, path) {
  assertObject(repository, path);
  assertExactKeys(repository, new Set(["name", "revision"]), path);
  if (
    typeof repository.name !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.name)
  ) {
    fail(`${path}.name`, "must be an owner/repository name");
  }
  if (
    typeof repository.revision !== "string" ||
    !REVISION_PATTERN.test(repository.revision)
  ) {
    fail(`${path}.revision`, "must be a lowercase 40-character commit SHA");
  }
}

function validateCapabilityCatalog(binding, path, expectedDigest) {
  assertObject(binding, path);
  assertExactKeys(binding, new Set(["schema_version", "digest"]), path);
  if (binding.schema_version !== 1) {
    fail(`${path}.schema_version`, "must equal 1");
  }
  assertDigest(binding.digest, `${path}.digest`, { prefixed: true });
  if (expectedDigest !== undefined && binding.digest !== expectedDigest) {
    fail(
      `${path}.digest`,
      `does not match the committed capability catalog ${expectedDigest}`,
    );
  }
}

function validateDisposition(disposition, allowedStates, path) {
  assertObject(disposition, path);
  assertExactKeys(
    disposition,
    new Set(["state", "reason_codes"]),
    path,
  );
  if (!allowedStates.has(disposition.state)) {
    fail(
      `${path}.state`,
      `must be one of ${[...allowedStates].sort().join(", ")}`,
    );
  }
  assertStringArray(disposition.reason_codes, `${path}.reason_codes`, {
    pattern: REASON_PATTERN,
  });
  if (
    HARD_FAILURE_STATES.has(disposition.state) &&
    disposition.reason_codes.length === 0
  ) {
    fail(
      path,
      `${disposition.state} requires at least one reason code`,
    );
  }
}

function validateEvidence(evidence, path) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail(path, "must be a nonempty evidence array");
  }
  for (const [index, item] of evidence.entries()) {
    const itemPath = `${path}[${index}]`;
    assertObject(item, itemPath);
    assertExactKeys(
      item,
      new Set([
        "type",
        "locator",
        "revision",
        "digest",
        "observed_at",
        "started_at",
        "completed_at",
      ]),
      itemPath,
    );
    assertId(item.type, `${itemPath}.type`);
    assertNonemptyString(item.locator, `${itemPath}.locator`);
    assertNonemptyString(item.revision, `${itemPath}.revision`);
    assertDigest(item.digest, `${itemPath}.digest`, { prefixed: true });
    for (const key of ["observed_at", "started_at", "completed_at"]) {
      if (item[key] !== undefined) {
        assertTimestamp(item[key], `${itemPath}.${key}`);
      }
    }
  }
}

function validateVersionRecord(record, path) {
  assertObject(record, path);
  assertExactKeys(record, new Set(["version", "evidence"]), path);
  assertNonemptyString(record.version, `${path}.version`);
  validateEvidence(record.evidence, `${path}.evidence`);
}

function validateComponent(component, path, capabilityIds) {
  assertObject(component, path);
  assertExactKeys(
    component,
    new Set([
      "id",
      "lane",
      "ecosystem",
      "current",
      "candidate",
      "eventual_managed_paths",
      "affected_capabilities",
    ]),
    path,
  );
  assertId(component.id, `${path}.id`);
  assertId(component.lane, `${path}.lane`);
  assertId(component.ecosystem, `${path}.ecosystem`);
  validateVersionRecord(component.current, `${path}.current`);
  if (component.candidate !== null) {
    validateVersionRecord(component.candidate, `${path}.candidate`);
  }
  assertStringArray(
    component.eventual_managed_paths,
    `${path}.eventual_managed_paths`,
    { allowEmpty: false },
  );
  for (const [index, managedPath] of
    component.eventual_managed_paths.entries()) {
    assertRepositoryPath(
      managedPath,
      `${path}.eventual_managed_paths[${index}]`,
    );
  }
  assertStringArray(
    component.affected_capabilities,
    `${path}.affected_capabilities`,
    { allowEmpty: false },
  );
  for (const [index, capability] of
    component.affected_capabilities.entries()) {
    assertCapability(
      capability,
      `${path}.affected_capabilities[${index}]`,
      capabilityIds,
    );
  }
}

function validateRelation(relation, path) {
  assertObject(relation, path);
  assertExactKeys(
    relation,
    new Set(["id", "type", "from", "to", "hard", "constraint"]),
    path,
  );
  assertId(relation.id, `${path}.id`);
  if (!RELATION_TYPES.has(relation.type)) {
    fail(
      `${path}.type`,
      `must be one of ${[...RELATION_TYPES].sort().join(", ")}`,
    );
  }
  assertId(relation.from, `${path}.from`);
  assertId(relation.to, `${path}.to`);
  if (relation.from === relation.to) {
    fail(path, "must connect two different components");
  }
  if (typeof relation.hard !== "boolean") {
    fail(`${path}.hard`, "must be a boolean");
  }
  if (relation.constraint !== null) {
    assertNonemptyString(relation.constraint, `${path}.constraint`);
  }
}

function validateResult(
  result,
  path,
  capabilityIds,
  { evidence = false, expectedRevision = null } = {},
) {
  assertObject(result, path);
  const allowed = new Set(["capability_id", "status", "warnings"]);
  if (evidence) {
    allowed.add("evidence");
  }
  assertExactKeys(result, allowed, path);
  assertCapability(
    result.capability_id,
    `${path}.capability_id`,
    capabilityIds,
  );
  if (!RESULT_STATES.has(result.status)) {
    fail(
      `${path}.status`,
      `must be one of ${[...RESULT_STATES].sort().join(", ")}`,
    );
  }
  assertStringArray(result.warnings, `${path}.warnings`);
  if (evidence) {
    validateEvidence(result.evidence, `${path}.evidence`);
    if (
      expectedRevision !== null &&
      result.evidence.some((item) => item.revision !== expectedRevision)
    ) {
      fail(
        `${path}.evidence`,
        `must bind tested revision ${expectedRevision}`,
      );
    }
  }
}

function assertUniqueObjects(values, key, path) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    const identifier = value[key];
    if (seen.has(identifier)) {
      fail(`${path}[${index}].${key}`, `duplicates ${identifier}`);
    }
    seen.add(identifier);
  }
}

function validateCommon(document, allowedKeys, capabilityCatalogDigest) {
  assertObject(document, "document");
  assertExactKeys(document, allowedKeys, "document");
  if (document.schema_version !== 1) {
    fail("document.schema_version", "must equal 1");
  }
  assertTimestamp(document.generated_at, "document.generated_at");
  validateRepository(document.repository, "document.repository");
  validateCapabilityCatalog(
    document.capability_catalog,
    "document.capability_catalog",
    capabilityCatalogDigest,
  );
}

function validateObservation(
  document,
  capabilityIds,
  capabilityCatalogDigest,
) {
  validateCommon(
    document,
    new Set([
      "schema_version",
      "kind",
      "generated_at",
      "repository",
      "capability_catalog",
      "provider_id",
      "disposition",
      "components",
      "relations",
    ]),
    capabilityCatalogDigest,
  );
  assertId(document.provider_id, "document.provider_id");
  validateDisposition(
    document.disposition,
    OBSERVATION_STATES,
    "document.disposition",
  );
  if (!Array.isArray(document.components) || document.components.length === 0) {
    fail("document.components", "must be a nonempty array");
  }
  document.components.forEach((component, index) =>
    validateComponent(
      component,
      `document.components[${index}]`,
      capabilityIds,
    ),
  );
  assertUniqueObjects(document.components, "id", "document.components");
  if (!Array.isArray(document.relations)) {
    fail("document.relations", "must be an array");
  }
  document.relations.forEach((relation, index) =>
    validateRelation(relation, `document.relations[${index}]`),
  );
  assertUniqueObjects(document.relations, "id", "document.relations");
  const candidateCount = document.components.filter(
    (component) => component.candidate !== null,
  ).length;
  if (
    document.disposition.state === "candidate" &&
    candidateCount === 0
  ) {
    fail(
      "document.disposition",
      "candidate requires at least one candidate component",
    );
  }
  if (
    document.disposition.state === "current" &&
    candidateCount !== 0
  ) {
    fail(
      "document.disposition",
      "current cannot contain a candidate component",
    );
  }
}

function validateValidation(
  document,
  capabilityIds,
  capabilityCatalogDigest,
) {
  validateCommon(
    document,
    new Set([
      "schema_version",
      "kind",
      "generated_at",
      "repository",
      "capability_catalog",
      "provider_id",
      "candidate_digest",
      "disposition",
      "results",
    ]),
    capabilityCatalogDigest,
  );
  assertId(document.provider_id, "document.provider_id");
  assertDigest(document.candidate_digest, "document.candidate_digest");
  validateDisposition(
    document.disposition,
    VALIDATION_STATES,
    "document.disposition",
  );
  if (!Array.isArray(document.results) || document.results.length === 0) {
    fail("document.results", "must be a nonempty array");
  }
  document.results.forEach((result, index) =>
    validateResult(
      result,
      `document.results[${index}]`,
      capabilityIds,
      {
        evidence: true,
        expectedRevision: document.repository.revision,
      },
    ),
  );
  assertUniqueObjects(document.results, "capability_id", "document.results");
  if (
    document.disposition.state === "independently-qualified" &&
    document.results.some(
      (result) => result.status !== "pass" || result.warnings.length > 0,
    )
  ) {
    fail(
      "document.disposition",
      "independently-qualified requires warning-free pass results",
    );
  }
}

function validateSelection(selection, path) {
  assertObject(selection, path);
  assertExactKeys(
    selection,
    new Set(["provider_id", "state", "candidate_digest"]),
    path,
  );
  assertId(selection.provider_id, `${path}.provider_id`);
  if (!["current", "candidate"].includes(selection.state)) {
    fail(`${path}.state`, 'must be "current" or "candidate"');
  }
  if (selection.state === "current" && selection.candidate_digest !== null) {
    fail(`${path}.candidate_digest`, "must be null for current selections");
  }
  if (selection.state === "candidate") {
    assertDigest(selection.candidate_digest, `${path}.candidate_digest`);
  }
}

function validateAssignment(assignment, path, capabilityIds) {
  assertObject(assignment, path);
  assertExactKeys(
    assignment,
    new Set(["id", "selections", "results", "maximal"]),
    path,
  );
  assertId(assignment.id, `${path}.id`);
  if (!Array.isArray(assignment.selections) || assignment.selections.length === 0) {
    fail(`${path}.selections`, "must be a nonempty array");
  }
  assignment.selections.forEach((selection, index) =>
    validateSelection(selection, `${path}.selections[${index}]`),
  );
  assertUniqueObjects(assignment.selections, "provider_id", `${path}.selections`);
  if (!Array.isArray(assignment.results) || assignment.results.length === 0) {
    fail(`${path}.results`, "must be a nonempty array");
  }
  assignment.results.forEach((result, index) =>
    validateResult(result, `${path}.results[${index}]`, capabilityIds),
  );
  assertUniqueObjects(assignment.results, "capability_id", `${path}.results`);
  if (typeof assignment.maximal !== "boolean") {
    fail(`${path}.maximal`, "must be a boolean");
  }
}

function validatePlan(document, capabilityIds, capabilityCatalogDigest) {
  validateCommon(
    document,
    new Set([
      "schema_version",
      "kind",
      "generated_at",
      "repository",
      "capability_catalog",
      "disposition",
      "assignments",
      "compatible_frontier",
      "minimal_blockers",
    ]),
    capabilityCatalogDigest,
  );
  validateDisposition(
    document.disposition,
    PLAN_STATES,
    "document.disposition",
  );
  if (!Array.isArray(document.assignments)) {
    fail("document.assignments", "must be an array");
  }
  document.assignments.forEach((assignment, index) =>
    validateAssignment(
      assignment,
      `document.assignments[${index}]`,
      capabilityIds,
    ),
  );
  assertUniqueObjects(document.assignments, "id", "document.assignments");
  if (document.compatible_frontier !== null) {
    assertId(
      document.compatible_frontier,
      "document.compatible_frontier",
    );
    if (
      !document.assignments.some(
        (assignment) => assignment.id === document.compatible_frontier,
      )
    ) {
      fail(
        "document.compatible_frontier",
        `references missing assignment ${document.compatible_frontier}`,
      );
    }
  }
  assertStringArray(document.minimal_blockers, "document.minimal_blockers");
  if (
    document.disposition.state === "cohort-planned" &&
    (document.assignments.length === 0 ||
      document.compatible_frontier === null)
  ) {
    fail(
      "document.disposition",
      "cohort-planned requires assignments and a compatible frontier",
    );
  }
  if (document.disposition.state === "cohort-planned") {
    const frontier = document.assignments.find(
      (assignment) => assignment.id === document.compatible_frontier,
    );
    if (
      frontier.results.some(
        (result) => result.status !== "pass" || result.warnings.length > 0,
      )
    ) {
      fail(
        "document.compatible_frontier",
        "cohort-planned requires a warning-free passing frontier",
      );
    }
  }
  if (
    document.disposition.state === "gridlocked" &&
    document.minimal_blockers.length === 0
  ) {
    fail(
      "document.minimal_blockers",
      "must identify at least one blocker for gridlock",
    );
  }
}

function validateCohort(document, capabilityIds, capabilityCatalogDigest) {
  validateCommon(
    document,
    new Set([
      "schema_version",
      "kind",
      "generated_at",
      "repository",
      "capability_catalog",
      "base_revision",
      "cohort_digest",
      "candidate_digests",
      "disposition",
      "results",
    ]),
    capabilityCatalogDigest,
  );
  if (
    typeof document.base_revision !== "string" ||
    !REVISION_PATTERN.test(document.base_revision)
  ) {
    fail(
      "document.base_revision",
      "must be a lowercase 40-character commit SHA",
    );
  }
  assertDigest(document.cohort_digest, "document.cohort_digest");
  assertStringArray(
    document.candidate_digests,
    "document.candidate_digests",
    { allowEmpty: false, pattern: CANDIDATE_DIGEST_PATTERN },
  );
  validateDisposition(
    document.disposition,
    COHORT_STATES,
    "document.disposition",
  );
  if (!Array.isArray(document.results) || document.results.length === 0) {
    fail("document.results", "must be a nonempty array");
  }
  document.results.forEach((result, index) =>
    validateResult(
      result,
      `document.results[${index}]`,
      capabilityIds,
      {
        evidence: true,
        expectedRevision: document.repository.revision,
      },
    ),
  );
  assertUniqueObjects(document.results, "capability_id", "document.results");
  if (
    document.disposition.state === "ready-before-release" &&
    document.results.some(
      (result) => result.status !== "pass" || result.warnings.length > 0,
    )
  ) {
    fail(
      "document.disposition",
      "ready-before-release requires warning-free pass results",
    );
  }
}

function canonicalize(value, { stripVolatile = false } = {}) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry, { stripVolatile }))
      .sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        if (leftJson < rightJson) {
          return -1;
        }
        if (leftJson > rightJson) {
          return 1;
        }
        return 0;
      });
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (stripVolatile && VOLATILE_KEYS.has(key)) {
      continue;
    }
    result[key] = canonicalize(value[key], { stripVolatile });
  }
  return result;
}

export async function readCapabilityIds(path) {
  return (await readCapabilityCatalog(path)).ids;
}

export async function readCapabilityCatalog(path) {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  validateCatalog(catalog);
  const ids = catalog.capabilities.map((capability) => capability.id);
  return {
    digest: `sha256:${hashProjection(catalog)}`,
    ids: new Set(ids),
    schemaVersion: catalog.schema_version,
  };
}

export function validateDocument(
  document,
  { capabilityIds, capabilityCatalogDigest },
) {
  if (!(capabilityIds instanceof Set)) {
    throw new Error("capabilityIds must be a Set");
  }
  switch (document?.kind) {
    case "observation":
      validateObservation(
        document,
        capabilityIds,
        capabilityCatalogDigest,
      );
      break;
    case "validation":
      validateValidation(
        document,
        capabilityIds,
        capabilityCatalogDigest,
      );
      break;
    case "plan":
      validatePlan(document, capabilityIds, capabilityCatalogDigest);
      break;
    case "cohort":
      validateCohort(document, capabilityIds, capabilityCatalogDigest);
      break;
    default:
      fail(
        "document.kind",
        "must be observation, validation, plan, or cohort",
      );
  }
  return document;
}

function pathsOverlap(left, right) {
  const leftPath = left
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
  const rightPath = right
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}/`) ||
    rightPath.startsWith(`${leftPath}/`)
  );
}

export function validateProviderSet(
  documents,
  { capabilityIds, capabilityCatalogDigest },
) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("Provider set must be a nonempty array");
  }

  const providers = new Set();
  const components = new Set();
  const relations = new Set();
  const managedPaths = [];
  let repository = null;
  let capabilityCatalog = null;

  for (const document of documents) {
    validateDocument(document, {
      capabilityIds,
      capabilityCatalogDigest,
    });
    if (document.kind !== "observation") {
      throw new Error("Provider set accepts observation documents only");
    }
    if (repository === null) {
      repository = document.repository;
      capabilityCatalog = document.capability_catalog;
    } else {
      if (
        document.repository.name !== repository.name ||
        document.repository.revision !== repository.revision
      ) {
        throw new Error(
          `provider ${document.provider_id} does not match provider-set repository`,
        );
      }
      if (
        document.capability_catalog.schema_version !==
          capabilityCatalog.schema_version ||
        document.capability_catalog.digest !== capabilityCatalog.digest
      ) {
        throw new Error(
          `provider ${document.provider_id} does not match provider-set capability catalog`,
        );
      }
    }
    if (providers.has(document.provider_id)) {
      throw new Error(`duplicate provider id ${document.provider_id}`);
    }
    providers.add(document.provider_id);

    for (const component of document.components) {
      if (components.has(component.id)) {
        throw new Error(`duplicate component id ${component.id}`);
      }
      components.add(component.id);
      for (const managedPath of component.eventual_managed_paths) {
        for (const existing of managedPaths) {
          if (pathsOverlap(existing.path, managedPath)) {
            throw new Error(
              `managed paths overlap: ${existing.path} and ${managedPath}`,
            );
          }
        }
        managedPaths.push({
          component: component.id,
          path: managedPath,
        });
      }
    }
    for (const relation of document.relations) {
      if (relations.has(relation.id)) {
        throw new Error(`duplicate relation id ${relation.id}`);
      }
      relations.add(relation.id);
    }
  }

  for (const document of documents) {
    for (const relation of document.relations) {
      for (const endpoint of [relation.from, relation.to]) {
        if (!components.has(endpoint)) {
          throw new Error(
            `relation ${relation.id} references ${endpoint}`,
          );
        }
      }
    }
  }

  return {
    schema_version: 1,
    kind: "provider-set",
    repository,
    capability_catalog: capabilityCatalog,
    providers: documents,
  };
}

export async function readProviderSet(
  directory,
  { capabilityIds, capabilityCatalogDigest },
) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(
      `Provider directory contains no JSON documents: ${directory}`,
    );
  }

  const documents = [];
  for (const name of entries) {
    const path = join(directory, name);
    let document;
    try {
      document = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read provider document ${path}: ${error.message}`,
      );
    }
    documents.push(document);
  }
  return validateProviderSet(documents, {
    capabilityIds,
    capabilityCatalogDigest,
  });
}

function sortedStrings(values) {
  return [...values].sort();
}

function assertSameStrings(actual, expected, path) {
  const actualValues = sortedStrings(actual);
  const expectedValues = sortedStrings(expected);
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    fail(
      path,
      `must equal [${expectedValues.join(", ")}], found [${actualValues.join(", ")}]`,
    );
  }
}

function assertSameRepository(left, right, path) {
  if (
    left.name !== right.name ||
    left.revision !== right.revision
  ) {
    fail(path, "must bind the same repository revision");
  }
}

function assertSameCatalog(left, right, path) {
  if (
    left.schema_version !== right.schema_version ||
    left.digest !== right.digest
  ) {
    fail(path, "must bind the same capability catalog");
  }
}

export function validateIndependentQualification(
  observation,
  validation,
  options,
) {
  validateDocument(observation, options);
  validateDocument(validation, options);
  if (observation.kind !== "observation") {
    fail("observation.kind", "must be observation");
  }
  if (validation.kind !== "validation") {
    fail("validation.kind", "must be validation");
  }
  if (observation.disposition.state !== "candidate") {
    fail("observation.disposition", "must identify a candidate");
  }
  if (validation.disposition.state !== "independently-qualified") {
    fail(
      "validation.disposition",
      "must be independently-qualified",
    );
  }
  if (observation.provider_id !== validation.provider_id) {
    fail(
      "validation.provider_id",
      `must equal observation provider ${observation.provider_id}`,
    );
  }
  assertSameRepository(
    observation.repository,
    validation.repository,
    "validation.repository",
  );
  assertSameCatalog(
    observation.capability_catalog,
    validation.capability_catalog,
    "validation.capability_catalog",
  );
  const expectedDigest = subjectDigest(observation);
  if (validation.candidate_digest !== expectedDigest) {
    fail(
      "validation.candidate_digest",
      `must equal observation subject digest ${expectedDigest}`,
    );
  }
  const expectedCapabilities = new Set(
    observation.components
      .filter((component) => component.candidate !== null)
      .flatMap((component) => component.affected_capabilities),
  );
  assertSameStrings(
    validation.results.map((result) => result.capability_id),
    expectedCapabilities,
    "validation.results",
  );
  return validation;
}

export function validateCohortQualification(
  { cohort, observations, plan, validations },
  options,
) {
  validateDocument(plan, options);
  validateDocument(cohort, options);
  if (plan.kind !== "plan" || plan.disposition.state !== "cohort-planned") {
    fail("plan.disposition", "must be cohort-planned");
  }
  if (
    cohort.kind !== "cohort" ||
    cohort.disposition.state !== "ready-before-release"
  ) {
    fail("cohort.disposition", "must be ready-before-release");
  }
  if (cohort.repository.name !== plan.repository.name) {
    fail("cohort.repository", "must bind the plan repository");
  }
  if (cohort.base_revision !== plan.repository.revision) {
    fail("cohort.base_revision", "must equal the plan repository revision");
  }
  assertSameCatalog(
    cohort.capability_catalog,
    plan.capability_catalog,
    "cohort.capability_catalog",
  );
  const expectedCohortDigest = subjectDigest(plan);
  if (cohort.cohort_digest !== expectedCohortDigest) {
    fail(
      "cohort.cohort_digest",
      `must equal plan subject digest ${expectedCohortDigest}`,
    );
  }
  const frontier = plan.assignments.find(
    (assignment) => assignment.id === plan.compatible_frontier,
  );
  const expectedDigests = frontier.selections
    .filter((selection) => selection.state === "candidate")
    .map((selection) => selection.candidate_digest);
  const expectedProviders = new Map(
    frontier.selections
      .filter((selection) => selection.state === "candidate")
      .map((selection) => [
        selection.provider_id,
        selection.candidate_digest,
      ]),
  );
  assertSameStrings(
    cohort.candidate_digests,
    expectedDigests,
    "cohort.candidate_digests",
  );
  assertSameStrings(
    cohort.results.map((result) => result.capability_id),
    frontier.results.map((result) => result.capability_id),
    "cohort.results",
  );
  if (!Array.isArray(validations)) {
    fail("validations", "must be an array");
  }
  if (!Array.isArray(observations)) {
    fail("observations", "must be an array");
  }
  const observationsByProvider = new Map();
  for (const observation of observations) {
    validateDocument(observation, options);
    if (observation.kind !== "observation") {
      fail("observations", "must contain observation documents");
    }
    if (observationsByProvider.has(observation.provider_id)) {
      fail("observations", `duplicates provider ${observation.provider_id}`);
    }
    observationsByProvider.set(observation.provider_id, observation);
  }
  assertSameStrings(
    observationsByProvider.keys(),
    expectedProviders.keys(),
    "observations",
  );
  const expectedCombinedCapabilities = new Set(
    observations.flatMap((observation) =>
      observation.components
        .filter((component) => component.candidate !== null)
        .flatMap((component) => component.affected_capabilities),
    ),
  );
  assertSameStrings(
    frontier.results.map((result) => result.capability_id),
    expectedCombinedCapabilities,
    "plan compatible frontier results",
  );
  const validationDigests = [];
  const validationProviders = new Set();
  for (const validation of validations) {
    validateDocument(validation, options);
    if (
      validation.kind !== "validation" ||
      validation.disposition.state !== "independently-qualified"
    ) {
      fail(
        "validations",
        "must contain independently-qualified validation documents",
      );
    }
    const observation = observationsByProvider.get(validation.provider_id);
    validateIndependentQualification(
      observation,
      validation,
      options,
    );
    assertSameRepository(
      validation.repository,
      plan.repository,
      `validation ${validation.provider_id}`,
    );
    assertSameCatalog(
      validation.capability_catalog,
      plan.capability_catalog,
      `validation ${validation.provider_id}`,
    );
    if (validationProviders.has(validation.provider_id)) {
      fail("validations", `duplicates provider ${validation.provider_id}`);
    }
    if (
      expectedProviders.get(validation.provider_id) !==
      validation.candidate_digest
    ) {
      fail(
        "validations",
        `does not match planned candidate for provider ${validation.provider_id}`,
      );
    }
    validationProviders.add(validation.provider_id);
    validationDigests.push(validation.candidate_digest);
  }
  assertSameStrings(
    validationDigests,
    expectedDigests,
    "validations",
  );
  return cohort;
}

export function canonicalDocument(document) {
  return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}

function semanticEvidence(evidence) {
  return evidence.map(({ type, locator, revision, digest }) => ({
    type,
    revision,
    digest,
    ...(type === "github-actions-run" ? {} : { locator }),
  }));
}

function subjectProjection(document) {
  const common = {
    capability_catalog: document.capability_catalog,
    kind: document.kind,
    repository: document.repository,
    schema_version: document.schema_version,
  };
  switch (document.kind) {
    case "observation":
      return {
        ...common,
        provider_id: document.provider_id,
        components: document.components.map((component) => ({
          id: component.id,
          lane: component.lane,
          ecosystem: component.ecosystem,
          current_version: component.current.version,
          candidate_version: component.candidate?.version ?? null,
          current_evidence: semanticEvidence(component.current.evidence),
          candidate_evidence:
            component.candidate === null
              ? null
              : semanticEvidence(component.candidate.evidence),
          eventual_managed_paths: component.eventual_managed_paths,
          affected_capabilities: component.affected_capabilities,
        })),
        relations: document.relations,
      };
    case "validation":
      return {
        ...common,
        provider_id: document.provider_id,
        candidate_digest: document.candidate_digest,
        capabilities: document.results.map((result) => result.capability_id),
      };
    case "plan":
      return {
        ...common,
        compatible_frontier: document.compatible_frontier,
        minimal_blockers: document.minimal_blockers,
        assignments: document.assignments.map((assignment) => ({
          id: assignment.id,
          selections: assignment.selections,
          capabilities: assignment.results.map(
            (result) => result.capability_id,
          ),
        })),
      };
    case "cohort":
      return {
        ...common,
        base_revision: document.base_revision,
        cohort_digest: document.cohort_digest,
        candidate_digests: document.candidate_digests,
        capabilities: document.results.map((result) => result.capability_id),
      };
    default:
      return common;
  }
}

function evidenceProjection(document) {
  if (document.kind === "observation") {
    return {
      capability_catalog: document.capability_catalog,
      kind: document.kind,
      repository: document.repository,
      provider_id: document.provider_id,
      disposition: document.disposition,
      components: document.components.map((component) => ({
        id: component.id,
        current: {
          version: component.current.version,
          evidence: semanticEvidence(component.current.evidence),
        },
        candidate:
          component.candidate === null
            ? null
            : {
                version: component.candidate.version,
                evidence: semanticEvidence(component.candidate.evidence),
              },
      })),
    };
  }
  if (document.kind === "validation" || document.kind === "cohort") {
    return {
      capability_catalog: document.capability_catalog,
      kind: document.kind,
      repository: document.repository,
      provider_id: document.provider_id,
      candidate_digest: document.candidate_digest,
      cohort_digest: document.cohort_digest,
      base_revision: document.base_revision,
      candidate_digests: document.candidate_digests,
      disposition: document.disposition,
      results: document.results.map((result) => ({
        capability_id: result.capability_id,
        status: result.status,
        warnings: result.warnings,
        evidence: semanticEvidence(result.evidence),
      })),
    };
  }
  return canonicalize(document, { stripVolatile: true });
}

function hashProjection(value) {
  const payload = JSON.stringify(
    canonicalize(value, { stripVolatile: true }),
  );
  return createHash("sha256").update(payload).digest("hex");
}

export function subjectDigest(document) {
  return hashProjection(subjectProjection(document));
}

export function evidenceDigest(document) {
  return hashProjection(evidenceProjection(document));
}

export function contentDigest(document) {
  return hashProjection(document);
}

export const documentDigest = contentDigest;
