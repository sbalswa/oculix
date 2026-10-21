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

function parseVersion(value) {
  const match =
    /^[v=]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
      .exec(value.trim());
  if (match === null) {
    throw new Error(`unsupported version ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    precision:
      match[3] === undefined ? (match[2] === undefined ? 1 : 2) : 3,
    prerelease:
      match[4] === undefined ? [] : match[4].split("."),
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
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) {
        return Math.sign(difference);
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    const difference = compareStrings(left[index], right[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function incrementForPrecision(version, precision) {
  if (precision === 1) {
    return {
      ...version,
      major: version.major + 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    };
  }
  return {
    ...version,
    minor: version.minor + 1,
    patch: 0,
    prerelease: [],
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
      if (expected.precision === 1) {
        return version.major === expected.major;
      }
      if (expected.precision === 2) {
        return (
          version.major === expected.major &&
          version.minor === expected.minor
        );
      }
      return comparison === 0;
    default:
      throw new Error(`unsupported version comparator ${operator}`);
  }
}

function wildcardMatches(version, token) {
  const parts = token.replace(/^v/u, "").split(".");
  const values = [version.major, version.minor, version.patch];
  for (const [index, part] of parts.entries()) {
    if (part === "*" || part.toLowerCase() === "x") {
      return true;
    }
    if (!/^\d+$/u.test(part) || values[index] !== Number(part)) {
      return false;
    }
  }
  return true;
}

function caretUpperBound(version) {
  if (version.major > 0) {
    return {
      ...version,
      major: version.major + 1,
      minor: 0,
      patch: 0,
      prerelease: [],
    };
  }
  if (version.minor > 0) {
    return {
      ...version,
      minor: version.minor + 1,
      patch: 0,
      prerelease: [],
    };
  }
  return {
    ...version,
    patch: version.patch + 1,
    prerelease: [],
  };
}

function tokenMatches(version, token) {
  if (/[*xX]/u.test(token)) {
    return wildcardMatches(version, token);
  }
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
      compareVersions(
        version,
        incrementForPrecision(expected, expected.precision),
      ) < 0
    );
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(token);
  const operator = match[1] ?? "=";
  return comparatorMatches(version, operator, parseVersion(match[2]));
}

function rangeClauseMatches(version, clause) {
  const hyphen =
    /^(\S+)\s+-\s+(\S+)$/u.exec(clause);
  if (hyphen !== null) {
    const lower = parseVersion(hyphen[1]);
    const upper = parseVersion(hyphen[2]);
    return (
      compareVersions(version, lower) >= 0 &&
      compareVersions(version, upper) <= 0
    );
  }
  const tokens = clause
    .replaceAll(",", " ")
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("version constraint must not be empty");
  }
  return tokens.every((token) => tokenMatches(version, token));
}

export function versionSatisfies(versionValue, constraint) {
  if (typeof constraint !== "string" || constraint.trim().length === 0) {
    throw new Error("version constraint must be a nonempty string");
  }
  const version = parseVersion(versionValue);
  return constraint
    .split("||")
    .map((clause) => clause.trim())
    .some((clause) => rangeClauseMatches(version, clause));
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
    case "bundles":
    case "must-match":
    case "requires":
    case "uses-external":
      return from.selection.state === "candidate";
    default:
      throw new Error(`unsupported relation type ${relation.type}`);
  }
}

function stateConstraintMatches(constraint, from, to) {
  switch (constraint) {
    case "candidate":
      return to.selection.state === "candidate";
    case "current":
      return to.selection.state === "current";
    case "same-state":
    case "lockstep":
      return from.selection.state === to.selection.state;
    default:
      return null;
  }
}

function relationMatches(relation, from, to) {
  const stateMatch =
    relation.constraint === null
      ? null
      : stateConstraintMatches(relation.constraint, from, to);
  if (stateMatch !== null) {
    return stateMatch;
  }

  switch (relation.type) {
    case "requires":
      if (relation.constraint === null) {
        return to.selection.state === "candidate";
      }
      return versionSatisfies(
        to.selection.version,
        relation.constraint,
      );
    case "bundles":
      if (to.selection.state !== "candidate") {
        return false;
      }
      return (
        relation.constraint === null ||
        versionSatisfies(to.selection.version, relation.constraint)
      );
    case "must-match":
      if (relation.constraint === null) {
        return from.selection.version === to.selection.version;
      }
      return versionSatisfies(
        to.selection.version,
        relation.constraint,
      );
    case "shares-runtime":
    case "policy-align":
      if (relation.constraint === null) {
        return from.selection.version === to.selection.version;
      }
      return versionSatisfies(
        to.selection.version,
        relation.constraint,
      );
    case "uses-external":
      return (
        relation.constraint === null ||
        versionSatisfies(to.selection.version, relation.constraint)
      );
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
    if (!relationMatches(relation, from, to)) {
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
    if (capabilities.length === 0) {
      if (validationsByProvider.has(observation.provider_id)) {
        throw new Error(
          `validation ${observation.provider_id} has no candidate observation`,
        );
      }
      continue;
    }
    const validation = validationsByProvider.get(
      observation.provider_id,
    );
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
