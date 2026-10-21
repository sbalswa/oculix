import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalDocument,
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateProviderSet,
} from "./contract.mjs";
import {
  canonicalTrafficPlan,
  solveTrafficControl,
  versionSatisfies,
} from "./traffic-controller.mjs";

const CAPABILITY_PATH = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);
const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/traffic-controller/",
  import.meta.url,
);
const GENERATED_AT = "2026-10-21T17:00:00Z";
const REPOSITORY = {
  name: "sbalswa/oculix",
  revision: "d460a7e8ce751eb772d1b3120e5508bbecaa7bff",
};
const EVIDENCE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const capabilityCatalog = await readCapabilityCatalog(CAPABILITY_PATH);
const contractOptions = {
  capabilityCatalogDigest: capabilityCatalog.digest,
  capabilityIds: capabilityCatalog.ids,
};

function evidence(providerId, state) {
  return [
    {
      type: "repository-file",
      locator: `tests/dependency-qualification/${providerId}-${state}.json`,
      revision: REPOSITORY.revision,
      digest: EVIDENCE_DIGEST,
      observed_at: GENERATED_AT,
    },
  ];
}

function observation({
  capabilities,
  candidateVersion,
  currentVersion,
  disposition,
  id,
  managedPath = `tests/dependency-qualification/${id}.json`,
  relations = [],
}) {
  return {
    schema_version: 1,
    kind: "observation",
    generated_at: GENERATED_AT,
    repository: structuredClone(REPOSITORY),
    capability_catalog: {
      schema_version: capabilityCatalog.schemaVersion,
      digest: capabilityCatalog.digest,
    },
    provider_id: id,
    disposition:
      disposition ??
      {
        state: candidateVersion === null ? "current" : "candidate",
        reason_codes: [],
      },
    components: [
      {
        id: `${id}-component`,
        lane: id,
        ecosystem: "npm",
        current: {
          version: currentVersion,
          evidence: evidence(id, "current"),
        },
        candidate:
          candidateVersion === null
            ? null
            : {
                version: candidateVersion,
                evidence: evidence(id, "candidate"),
              },
        eventual_managed_paths: [managedPath],
        affected_capabilities: capabilities,
      },
    ],
    relations,
  };
}

function relation({
  constraint,
  from,
  hard = true,
  id,
  to,
  type = "requires",
}) {
  return {
    id,
    type,
    from: `${from}-component`,
    to: `${to}-component`,
    hard,
    constraint,
  };
}

function validation(
  source,
  {
    disposition = "independently-qualified",
    reasonCodes = [],
    statuses = {},
    warnings = {},
  } = {},
) {
  return {
    schema_version: 1,
    kind: "validation",
    generated_at: GENERATED_AT,
    repository: structuredClone(REPOSITORY),
    capability_catalog: {
      schema_version: capabilityCatalog.schemaVersion,
      digest: capabilityCatalog.digest,
    },
    provider_id: source.provider_id,
    candidate_digest: subjectDigest(source),
    disposition: {
      state: disposition,
      reason_codes: reasonCodes,
    },
    results: source.components[0].affected_capabilities.map(
      (capabilityId) => ({
        capability_id: capabilityId,
        status: statuses[capabilityId] ?? "pass",
        warnings: warnings[capabilityId] ?? [],
        evidence: [
          {
            type: "github-actions-run",
            locator:
              `https://github.com/sbalswa/oculix/actions/runs/${source.provider_id}`,
            revision: REPOSITORY.revision,
            digest: EVIDENCE_DIGEST,
            started_at: GENERATED_AT,
            completed_at: GENERATED_AT,
          },
        ],
      }),
    ),
  };
}

function solverInput(observations, validations, extra = {}) {
  return {
    providerSet: validateProviderSet(observations, contractOptions),
    validations,
    generatedAt: GENERATED_AT,
    ...contractOptions,
    ...extra,
  };
}

function solve(observations, validations, extra) {
  const plan = solveTrafficControl(
    solverInput(observations, validations, extra),
  );
  assert.doesNotThrow(() =>
    validateDocument(plan, contractOptions),
  );
  return plan;
}

function coupledScenario() {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
    relations: [
      relation({
        constraint: "candidate",
        from: "selenium",
        id: "selenium-requires-node-candidate",
        to: "node",
      }),
    ],
  });
  return {
    observations: [node, selenium],
    validations: [validation(node), validation(selenium)],
  };
}

function mutuallyExclusiveScenario() {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
    relations: [
      relation({
        constraint: "candidate",
        from: "selenium",
        id: "selenium-requires-node-candidate",
        to: "node",
      }),
    ],
  });
  const cypress = observation({
    capabilities: ["cypress-ubuntu-chrome"],
    candidateVersion: "17.0.0",
    currentVersion: "16.0.0",
    id: "cypress",
    relations: [
      relation({
        constraint: "current",
        from: "cypress",
        id: "cypress-requires-node-current",
        to: "node",
      }),
    ],
  });
  return {
    observations: [node, selenium, cypress],
    validations: [
      validation(node),
      validation(selenium),
      validation(cypress),
    ],
  };
}

function gridlockedScenario() {
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
    relations: [
      relation({
        constraint: "candidate",
        from: "selenium",
        id: "selenium-requires-cypress-candidate",
        to: "cypress",
      }),
      relation({
        constraint: "999",
        from: "selenium",
        id: "selenium-cypress-version-collision",
        to: "cypress",
        type: "must-match",
      }),
    ],
  });
  const cypress = observation({
    capabilities: ["cypress-ubuntu-chrome"],
    candidateVersion: "17.0.0",
    currentVersion: "16.0.0",
    id: "cypress",
    relations: [
      relation({
        constraint: "candidate",
        from: "cypress",
        id: "cypress-requires-selenium-candidate",
        to: "selenium",
      }),
    ],
  });
  return {
    observations: [selenium, cypress],
    validations: [validation(selenium), validation(cypress)],
  };
}

test("independently compatible candidates produce one maximal cohort", () => {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
  });

  const plan = solve(
    [selenium, node],
    [validation(selenium), validation(node)],
  );

  assert.deepEqual(plan.disposition, {
    state: "cohort-planned",
    reason_codes: ["INDEPENDENTLY_COMPATIBLE"],
  });
  assert.equal(plan.assignments.length, 1);
  assert.equal(
    plan.compatible_frontier,
    "node-candidate-selenium-candidate",
  );
  assert.deepEqual(plan.minimal_blockers, []);
});

test("a candidate requiring the Node candidate is explicitly coupled", async () => {
  const scenario = coupledScenario();
  const plan = solve(scenario.observations, scenario.validations);

  assert.deepEqual(plan.disposition, {
    state: "cohort-planned",
    reason_codes: ["COUPLED_COMPATIBLE"],
  });
  assert.equal(
    plan.compatible_frontier,
    "node-candidate-selenium-candidate",
  );
  assert.equal(plan.assignments.length, 1);
  assert.equal(
    canonicalDocument(plan),
    await readFile(new URL("coupled.plan.json", FIXTURE_ROOT), "utf8"),
  );
});

test("a Node candidate breaking exactly one framework names that capability", () => {
  const node = observation({
    capabilities: [
      "cypress-ubuntu-chrome",
      "selenium-ubuntu-chromium",
    ],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
  });
  const nodeValidation = validation(node, {
    disposition: "blocked",
    reasonCodes: ["VALIDATION_FAILED"],
    statuses: {
      "selenium-ubuntu-chromium": "fail",
    },
  });

  const plan = solve([node], [nodeValidation]);

  assert.equal(plan.disposition.state, "blocked");
  assert.deepEqual(plan.minimal_blockers, [
    "selenium-ubuntu-chromium",
  ]);
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.compatible_frontier, null);
});

test("a Node runtime collision names the one unsatisfied framework relation", () => {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: null,
    currentVersion: "4.0.0",
    id: "selenium",
    relations: [
      relation({
        constraint: "<26",
        from: "selenium",
        id: "selenium-node-range",
        to: "node",
        type: "shares-runtime",
      }),
    ],
  });
  const cypress = observation({
    capabilities: ["cypress-ubuntu-chrome"],
    candidateVersion: null,
    currentVersion: "16.0.0",
    id: "cypress",
    relations: [
      relation({
        constraint: ">=24",
        from: "cypress",
        id: "cypress-node-range",
        to: "node",
        type: "shares-runtime",
      }),
    ],
  });

  const plan = solve(
    [selenium, node, cypress],
    [validation(node)],
  );

  assert.deepEqual(plan.disposition, {
    state: "incompatible",
    reason_codes: ["HARD_RELATION_INCOMPATIBLE"],
  });
  assert.deepEqual(plan.minimal_blockers, ["selenium-node-range"]);
});

test("inverse Selenium and Cypress success yields every maximal assignment", async () => {
  const scenario = mutuallyExclusiveScenario();
  const plan = solve(scenario.observations, scenario.validations);

  assert.deepEqual(plan.disposition, {
    state: "mutually-exclusive",
    reason_codes: ["CANDIDATES_MUTUALLY_EXCLUSIVE"],
  });
  assert.deepEqual(
    plan.assignments.map((assignment) => assignment.id),
    [
      "cypress-candidate-node-current-selenium-current",
      "cypress-current-node-candidate-selenium-candidate",
    ],
  );
  assert.ok(plan.assignments.every((assignment) => assignment.maximal));
  assert.equal(
    plan.compatible_frontier,
    "cypress-current-node-candidate-selenium-candidate",
  );
  assert.deepEqual(plan.minimal_blockers, [
    "cypress-requires-node-current",
  ]);
  assert.equal(
    canonicalDocument(plan),
    await readFile(
      new URL("mutually-exclusive.plan.json", FIXTURE_ROOT),
      "utf8",
    ),
  );
});

test("no compatible candidate assignment is gridlocked with minimal blockers", async () => {
  const scenario = gridlockedScenario();
  const plan = solve(scenario.observations, scenario.validations);

  assert.deepEqual(plan.disposition, {
    state: "gridlocked",
    reason_codes: ["NO_COMPATIBLE_ASSIGNMENT"],
  });
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.compatible_frontier, null);
  assert.deepEqual(plan.minimal_blockers, [
    "selenium-cypress-version-collision",
  ]);
  assert.equal(
    canonicalDocument(plan),
    await readFile(new URL("gridlocked.plan.json", FIXTURE_ROOT), "utf8"),
  );
});

test("unknown evidence prevents readiness without erasing unrelated results", async () => {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    disposition: {
      state: "unknown",
      reason_codes: ["DISCOVERY_UNKNOWN"],
    },
    id: "node",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
  });

  const plan = solve([node, selenium], [validation(selenium)]);

  assert.deepEqual(plan.disposition, {
    state: "unknown",
    reason_codes: ["EVIDENCE_UNKNOWN"],
  });
  assert.equal(plan.assignments.length, 1);
  assert.equal(
    plan.compatible_frontier,
    "node-current-selenium-candidate",
  );
  assert.deepEqual(plan.minimal_blockers, ["node"]);
  assert.equal(
    canonicalDocument(plan),
    await readFile(new URL("unknown.plan.json", FIXTURE_ROOT), "utf8"),
  );
});

test("advisory relations are reported but never become blockers", () => {
  const cypress = observation({
    capabilities: ["cypress-ubuntu-chrome"],
    candidateVersion: null,
    currentVersion: "16.0.0",
    id: "cypress",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
    relations: [
      relation({
        constraint: ">=17",
        from: "selenium",
        hard: false,
        id: "axe-version-alignment",
        to: "cypress",
        type: "policy-align",
      }),
    ],
  });

  const plan = solve(
    [selenium, cypress],
    [validation(selenium)],
  );

  assert.deepEqual(plan.disposition, {
    state: "cohort-planned",
    reason_codes: [
      "ADVISORY_AXE_VERSION_ALIGNMENT",
      "INDEPENDENTLY_COMPATIBLE",
    ],
  });
  assert.deepEqual(plan.minimal_blockers, []);
});

test("managed-path collisions fail before assignment solving", () => {
  const node = observation({
    capabilities: ["playwright-ubuntu-chromium"],
    candidateVersion: "26.0.0",
    currentVersion: "24.0.0",
    id: "node",
    managedPath: "tests/e2e/shared/package.json",
  });
  const selenium = observation({
    capabilities: ["selenium-ubuntu-chromium"],
    candidateVersion: "5.0.0",
    currentVersion: "4.0.0",
    id: "selenium",
    managedPath: "tests/e2e/shared",
  });

  assert.throws(
    () =>
      solveTrafficControl({
        providerSet: {
          schema_version: 1,
          kind: "provider-set",
          repository: structuredClone(REPOSITORY),
          capability_catalog: {
            schema_version: capabilityCatalog.schemaVersion,
            digest: capabilityCatalog.digest,
          },
          providers: [node, selenium],
        },
        validations: [validation(node), validation(selenium)],
        generatedAt: GENERATED_AT,
        ...contractOptions,
      }),
    /managed paths overlap/,
  );
});

test("combination and maximal-assignment limits fail rather than truncate", () => {
  const providers = ["node", "selenium", "cypress"].map((id, index) =>
    observation({
      capabilities: [
        [
          "playwright-ubuntu-chromium",
          "selenium-ubuntu-chromium",
          "cypress-ubuntu-chrome",
        ][index],
      ],
      candidateVersion: `${index + 2}.0.0`,
      currentVersion: `${index + 1}.0.0`,
      id,
    }),
  );
  assert.throws(
    () =>
      solveTrafficControl(
        solverInput(
          providers,
          providers.map((provider) => validation(provider)),
          {
            limits: {
              maxAssignments: 32,
              maxCombinations: 4,
            },
          },
        ),
      ),
    /Combination limit exceeded: 8 assignments require evaluation, limit is 4/,
  );

  const isolated = ["node", "selenium", "cypress", "playwright"]
    .map((id, index, ids) =>
      observation({
        capabilities: [
          [
            "playwright-ubuntu-chromium",
            "selenium-ubuntu-chromium",
            "cypress-ubuntu-chrome",
            "oculix-ubuntu-chromium",
          ][index],
        ],
        candidateVersion: `${index + 2}.0.0`,
        currentVersion: `${index + 1}.0.0`,
        id,
        relations: ids
          .slice(index + 1)
          .map((other) =>
            relation({
              constraint: "current",
              from: id,
              id: `${id}-excludes-${other}`,
              to: other,
            }),
          ),
      }),
    );
  assert.throws(
    () =>
      solveTrafficControl(
        solverInput(
          isolated,
          isolated.map((provider) => validation(provider)),
          {
            limits: {
              maxAssignments: 3,
              maxCombinations: 16,
            },
          },
        ),
      ),
    /Assignment limit exceeded: 4 maximal assignments, limit is 3/,
  );
});

test("equivalent unordered inputs produce byte-identical plans", () => {
  const scenario = mutuallyExclusiveScenario();
  const reversedObservations = structuredClone(
    scenario.observations,
  ).reverse();
  for (const provider of reversedObservations) {
    provider.components.reverse();
    provider.relations.reverse();
    provider.components[0].affected_capabilities.reverse();
  }
  const reversedValidations = structuredClone(
    scenario.validations,
  ).reverse();
  for (const result of reversedValidations) {
    result.results.reverse();
  }

  const forward = canonicalTrafficPlan(
    solverInput(scenario.observations, scenario.validations),
  );
  const reverse = canonicalTrafficPlan(
    solverInput(reversedObservations, reversedValidations),
  );

  assert.equal(forward, reverse);
  assert.match(forward, /[^\n]\n$/u);
  assert.doesNotMatch(forward, /\n\n$/u);
});

test("supported version ranges are deterministic and fail closed", () => {
  assert.equal(versionSatisfies("24.3.1", ">=24 <26"), true);
  assert.equal(versionSatisfies("26.0.0", ">=24 <26"), false);
  assert.equal(versionSatisfies("24.3.1", "24"), true);
  assert.equal(versionSatisfies("25.0.0", "24"), false);
  assert.equal(versionSatisfies("24.3.1", "^24.1.0"), true);
  assert.equal(versionSatisfies("25.0.0", "^24.1.0"), false);
  assert.equal(versionSatisfies("4.14.1", "4.14.x"), true);
  assert.equal(versionSatisfies("5.0.0", "4.14.x || >=5"), true);
  assert.throws(
    () => versionSatisfies("24.0.0", "latest"),
    /unsupported version latest/,
  );
});
