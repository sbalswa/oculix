import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalDocument,
  contentDigest,
  documentDigest,
  evidenceDigest,
  readCapabilityCatalog,
  readCapabilityIds,
  readProviderSet,
  subjectDigest,
  validateCohortQualification,
  validateDocument,
  validateIndependentQualification,
  validateProviderSet,
} from "./contract.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/",
  import.meta.url,
);
const CAPABILITY_PATH = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

const capabilityCatalog = await readCapabilityCatalog(CAPABILITY_PATH);
const capabilityIds = await readCapabilityIds(CAPABILITY_PATH);
const contractOptions = {
  capabilityCatalogDigest: capabilityCatalog.digest,
  capabilityIds,
};

test("committed fixtures satisfy every producer contract", async () => {
  for (const name of [
    "observation.valid.json",
    "validation.valid.json",
    "plan.valid.json",
    "cohort.valid.json",
  ]) {
    const document = await fixture(name);
    assert.doesNotThrow(() =>
      validateDocument(document, contractOptions),
    );
  }
});

test("canonical output is byte-identical for equivalent unordered data", async () => {
  const observation = await fixture("observation.valid.json");
  const reordered = structuredClone(observation);
  reordered.components.reverse();
  reordered.components[0].affected_capabilities.reverse();
  reordered.relations.reverse();
  reordered.disposition.reason_codes.reverse();

  assert.equal(
    canonicalDocument(observation),
    canonicalDocument(reordered),
  );
  assert.match(canonicalDocument(observation), /[^\n]\n$/u);
  assert.doesNotMatch(canonicalDocument(observation), /\n\n$/u);
});

test("digests ignore volatile execution timestamps but bind candidate evidence", async () => {
  const observation = await fixture("observation.valid.json");
  const changedTimes = structuredClone(observation);
  changedTimes.generated_at = "2026-10-21T23:59:59Z";
  changedTimes.components[0].candidate.evidence[0].observed_at =
    "2026-10-21T23:59:58Z";

  assert.equal(documentDigest(observation), documentDigest(changedTimes));

  const changedCandidate = structuredClone(observation);
  changedCandidate.components[0].candidate.version = "26.0.1";
  assert.notEqual(
    documentDigest(observation),
    documentDigest(changedCandidate),
  );

  const changedEvidence = structuredClone(observation);
  changedEvidence.components[0].candidate.evidence[0].digest =
    `sha256:${"f".repeat(64)}`;
  assert.notEqual(
    subjectDigest(observation),
    subjectDigest(changedEvidence),
  );
  assert.notEqual(
    documentDigest(observation),
    documentDigest(changedEvidence),
  );

  const changedSource = structuredClone(observation);
  changedSource.components[0].candidate.evidence[0].locator =
    "https://nodejs.org/dist/v26.0.0/replaced/";
  assert.notEqual(
    subjectDigest(observation),
    subjectDigest(changedSource),
  );
  assert.notEqual(
    evidenceDigest(observation),
    evidenceDigest(changedSource),
  );
});

test("subject, evidence, and content digests have separate stability boundaries", async () => {
  const validation = await fixture("validation.valid.json");
  const rerun = structuredClone(validation);
  rerun.generated_at = "2026-10-21T23:59:59Z";
  rerun.results[0].evidence[0].locator =
    "https://github.com/sbalswa/oculix/actions/runs/999";
  rerun.results[0].evidence[0].started_at = "2026-10-21T23:55:00Z";
  rerun.results[0].evidence[0].completed_at = "2026-10-21T23:58:00Z";

  assert.equal(subjectDigest(validation), subjectDigest(rerun));
  assert.equal(evidenceDigest(validation), evidenceDigest(rerun));
  assert.notEqual(contentDigest(validation), contentDigest(rerun));

  const failed = structuredClone(validation);
  failed.disposition = {
    state: "blocked",
    reason_codes: ["VALIDATION_FAILED"],
  };
  failed.results[0].status = "fail";
  assert.equal(subjectDigest(validation), subjectDigest(failed));
  assert.notEqual(evidenceDigest(validation), evidenceDigest(failed));
});

test("capability references must exist in the committed catalog", async () => {
  const observation = await fixture("observation.valid.json");
  observation.components[0].affected_capabilities.push(
    "selenium-plan9-netscape",
  );

  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /unknown capability selenium-plan9-netscape/,
  );
});

test("documents bind the exact committed capability catalog", async () => {
  const observation = await fixture("observation.valid.json");
  observation.capability_catalog.digest =
    `sha256:${"1".repeat(64)}`;

  assert.throws(
    () => validateDocument(observation, contractOptions),
    /does not match the committed capability catalog/,
  );
});

test("unknown and unavailable dispositions require reason codes", async () => {
  const observation = await fixture("observation.valid.json");
  observation.disposition = {
    reason_codes: [],
    state: "unknown",
  };

  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /unknown requires at least one reason code/,
  );
});

test("current and candidate observations match their component contents", async () => {
  const observation = await fixture("observation.valid.json");
  observation.components[0].candidate = null;
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /candidate requires at least one candidate component/,
  );

  observation.disposition = {
    state: "current",
    reason_codes: [],
  };
  assert.doesNotThrow(() =>
    validateDocument(observation, { capabilityIds }),
  );

  observation.components[0].candidate =
    (await fixture("observation.valid.json")).components[0].candidate;
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /current cannot contain a candidate component/,
  );
});

test("unknown keys, document kinds, and schema versions fail closed", async () => {
  const observation = await fixture("observation.valid.json");
  observation.unexpected = true;
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /contains unknown keys: unexpected/,
  );

  delete observation.unexpected;
  observation.schema_version = 2;
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /schema_version must equal 1/,
  );

  observation.schema_version = 1;
  observation.kind = "wishful-thinking";
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /document.kind must be observation, validation, plan, or cohort/,
  );
});

test("independent qualification requires warning-free passing results", async () => {
  const validation = await fixture("validation.valid.json");
  validation.results[0].warnings.push("runner emitted a warning");

  assert.throws(
    () => validateDocument(validation, { capabilityIds }),
    /independently-qualified requires warning-free pass results/,
  );

  validation.results[0].warnings = [];
  validation.results[0].status = "fail";
  assert.throws(
    () => validateDocument(validation, { capabilityIds }),
    /independently-qualified requires warning-free pass results/,
  );
});

test("ready-before-release requires warning-free passing cohort results", async () => {
  const cohort = await fixture("cohort.valid.json");
  cohort.results[0].status = "not-validated";

  assert.throws(
    () => validateDocument(cohort, { capabilityIds }),
    /ready-before-release requires warning-free pass results/,
  );
});

test("cohort-planned requires a warning-free passing frontier", async () => {
  const plan = await fixture("plan.valid.json");
  plan.assignments[0].results[0].status = "not-validated";

  assert.throws(
    () => validateDocument(plan, { capabilityIds }),
    /cohort-planned requires a warning-free passing frontier/,
  );
});

test("planning supports incompatible and mutually-exclusive dispositions", async () => {
  for (const state of ["incompatible", "mutually-exclusive"]) {
    const plan = await fixture("plan.valid.json");
    plan.disposition = {
      state,
      reason_codes: ["NODE_RANGE_INTERSECTION_EMPTY"],
    };
    plan.assignments = [];
    plan.compatible_frontier = null;
    plan.minimal_blockers = ["node-runtime"];
    assert.doesNotThrow(() =>
      validateDocument(plan, { capabilityIds }),
    );
  }
});

test("validation and cohort evidence bind the exact tested commit", async () => {
  const validation = await fixture("validation.valid.json");
  validation.results[0].evidence[0].revision = "1".repeat(40);
  assert.throws(
    () => validateDocument(validation, { capabilityIds }),
    /must bind tested revision/,
  );

  const cohort = await fixture("cohort.valid.json");
  cohort.results[0].evidence[0].revision = "1".repeat(40);
  assert.throws(
    () => validateDocument(cohort, { capabilityIds }),
    /must bind tested revision/,
  );
});

test("timestamp validation rejects calendar rollover", async () => {
  const observation = await fixture("observation.valid.json");
  observation.generated_at = "2026-02-31T16:00:00Z";
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /must be a real RFC 3339 UTC timestamp/,
  );
});

function qualifiedDocuments() {
  return Promise.all([
    fixture("observation.valid.json"),
    fixture("validation.valid.json"),
    fixture("plan.valid.json"),
    fixture("cohort.valid.json"),
  ]).then(([observation, validation, plan, cohort]) => {
    validation.provider_id = observation.provider_id;
    validation.candidate_digest = subjectDigest(observation);
    const evidence = validation.results[0].evidence[0];
    validation.results = observation.components[0].affected_capabilities.map(
      (capabilityId) => ({
        capability_id: capabilityId,
        status: "pass",
        warnings: [],
        evidence: [structuredClone(evidence)],
      }),
    );

    plan.assignments[0].selections = [
      {
        provider_id: observation.provider_id,
        state: "candidate",
        candidate_digest: validation.candidate_digest,
      },
    ];
    plan.assignments[0].results = validation.results.map(
      ({ capability_id, status, warnings }) => ({
        capability_id,
        status,
        warnings,
      }),
    );

    cohort.candidate_digests = [validation.candidate_digest];
    cohort.cohort_digest = subjectDigest(plan);
    cohort.results = plan.assignments[0].results.map((result) => ({
      ...structuredClone(result),
      evidence: [
        {
          ...structuredClone(evidence),
          revision: cohort.repository.revision,
        },
      ],
    }));
    return { observation, validation, plan, cohort };
  });
}

test("independent qualification binds the exact observation and capability set", async () => {
  const { observation, validation } = await qualifiedDocuments();
  assert.doesNotThrow(() =>
    validateIndependentQualification(
      observation,
      validation,
      contractOptions,
    ),
  );

  validation.candidate_digest = "1".repeat(64);
  assert.throws(
    () =>
      validateIndependentQualification(
        observation,
        validation,
        contractOptions,
      ),
    /must equal observation subject digest/,
  );

  validation.candidate_digest = subjectDigest(observation);
  validation.results.pop();
  assert.throws(
    () =>
      validateIndependentQualification(
        observation,
        validation,
        contractOptions,
      ),
    /must equal \[/,
  );
});

test("ready cohort binds the admitted plan and every independent validation", async () => {
  const { cohort, observation, plan, validation } =
    await qualifiedDocuments();
  assert.doesNotThrow(() =>
    validateCohortQualification(
      {
        cohort,
        observations: [observation],
        plan,
        validations: [validation],
      },
      contractOptions,
    ),
  );

  cohort.candidate_digests = ["1".repeat(64)];
  assert.throws(
    () =>
      validateCohortQualification(
        {
          cohort,
          observations: [observation],
          plan,
          validations: [validation],
        },
        contractOptions,
      ),
    /cohort.candidate_digests must equal/,
  );

  cohort.candidate_digests = [validation.candidate_digest];
  assert.throws(
    () =>
      validateCohortQualification(
        {
          cohort,
          observations: [observation],
          plan,
          validations: [],
        },
        contractOptions,
      ),
    /validations must equal/,
  );
});

test("final qualification rechecks complete independent capability coverage", async () => {
  const { cohort, observation, plan, validation } =
    await qualifiedDocuments();
  validation.results.pop();

  assert.throws(
    () =>
      validateCohortQualification(
        {
          cohort,
          observations: [observation],
          plan,
          validations: [validation],
        },
        contractOptions,
      ),
    /validation.results must equal/,
  );
});

test("combined qualification covers the full admitted capability union", async () => {
  const { cohort, observation, plan, validation } =
    await qualifiedDocuments();
  plan.assignments[0].results = [plan.assignments[0].results[0]];
  cohort.cohort_digest = subjectDigest(plan);
  cohort.results = [cohort.results[0]];

  assert.throws(
    () =>
      validateCohortQualification(
        {
          cohort,
          observations: [observation],
          plan,
          validations: [validation],
        },
        contractOptions,
      ),
    /plan compatible frontier results must equal/,
  );
});

test("the plan subject digest binds the selected compatible frontier", async () => {
  const plan = await fixture("plan.valid.json");
  const alternative = structuredClone(plan.assignments[0]);
  alternative.id = "alternative-frontier";
  plan.assignments.push(alternative);

  const firstDigest = subjectDigest(plan);
  plan.compatible_frontier = "alternative-frontier";
  assert.notEqual(firstDigest, subjectDigest(plan));
});

test("provider aggregation rejects duplicate IDs and overlapping paths", async () => {
  const observation = await fixture("observation.valid.json");
  const duplicate = structuredClone(observation);
  duplicate.provider_id = "other-provider";

  assert.throws(
    () =>
      validateProviderSet([observation, duplicate], { capabilityIds }),
    /duplicate component id node-runtime/,
  );

  const overlap = structuredClone(observation);
  overlap.provider_id = "selenium";
  overlap.components[0].id = "selenium-framework";
  overlap.components[0].eventual_managed_paths = [
    "mise/config.web-e2e.toml/node",
  ];
  overlap.relations = [];

  assert.throws(
    () =>
      validateProviderSet([observation, overlap], { capabilityIds }),
    /managed paths overlap/,
  );

  overlap.components[0].eventual_managed_paths = [
    "MISE/CONFIG.WEB-E2E.TOML",
  ];
  assert.throws(
    () =>
      validateProviderSet([observation, overlap], { capabilityIds }),
    /managed paths overlap/,
  );
});

test("managed paths reject escaping, platform-specific, and glob syntax", async () => {
  const invalidPaths = [
    "../mise/config.toml",
    "/etc/passwd",
    "C:/repository/file",
    "tests\\e2e\\package.json",
    "tests/e2e/*.json",
  ];
  for (const invalidPath of invalidPaths) {
    const observation = await fixture("observation.valid.json");
    observation.components[0].eventual_managed_paths = [invalidPath];
    assert.throws(
      () => validateDocument(observation, { capabilityIds }),
      /repository-relative path|backslashes or glob syntax/,
      invalidPath,
    );
  }
});

test("provider aggregation rejects dangling relation endpoints", async () => {
  const observation = await fixture("observation.valid.json");
  observation.relations = [
    {
      constraint: ">=24",
      from: "node-runtime",
      hard: true,
      id: "node-requires-missing",
      to: "missing-component",
      type: "requires",
    },
  ];

  assert.throws(
    () => validateProviderSet([observation], { capabilityIds }),
    /relation node-requires-missing references missing-component/,
  );
});

test("relations cannot claim that a component depends on itself", async () => {
  const observation = await fixture("observation.valid.json");
  observation.relations = [
    {
      constraint: "24",
      from: "node-runtime",
      hard: true,
      id: "node-shares-itself",
      to: "node-runtime",
      type: "shares-runtime",
    },
  ];
  assert.throws(
    () => validateDocument(observation, { capabilityIds }),
    /must connect two different components/,
  );
});

test("provider aggregation rejects stale repository and catalog bindings", async () => {
  const node = await fixture("observation.valid.json");
  const stale = structuredClone(node);
  stale.provider_id = "stale-provider";
  stale.components[0].id = "stale-component";
  stale.components[0].eventual_managed_paths = [
    "tests/dependency-qualification/stale.json",
  ];
  stale.relations = [];
  stale.repository.revision = "1".repeat(40);

  assert.throws(
    () => validateProviderSet([node, stale], { capabilityIds }),
    /does not match provider-set repository/,
  );

  stale.repository.revision = node.repository.revision;
  stale.capability_catalog.digest = `sha256:${"2".repeat(64)}`;
  assert.throws(
    () => validateProviderSet([node, stale], { capabilityIds }),
    /does not match provider-set capability catalog/,
  );
});

test("provider discovery validates JSON files before aggregation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qualification-providers-"));
  try {
    const node = await fixture("observation.valid.json");
    const selenium = structuredClone(node);
    selenium.provider_id = "selenium";
    selenium.components[0].id = "selenium-framework";
    selenium.components[0].eventual_managed_paths = [
      "tests/e2e/selenium/package.json",
      "tests/e2e/selenium/package-lock.json",
    ];
    selenium.relations = [
      {
        constraint: ">=24",
        from: "selenium-framework",
        hard: true,
        id: "selenium-requires-node",
        to: "node-runtime",
        type: "requires",
      },
    ];
    await writeFile(
      join(directory, "20-selenium.json"),
      JSON.stringify(selenium),
    );
    await writeFile(join(directory, "10-node.json"), JSON.stringify(node));
    await writeFile(join(directory, "README.md"), "ignored");

    const providerSet = await readProviderSet(directory, contractOptions);
    assert.equal(providerSet.providers.length, 2);
    assert.equal(
      providerSet.repository.revision,
      node.repository.revision,
    );
    assert.equal(
      providerSet.capability_catalog.digest,
      capabilityCatalog.digest,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("equivalent provider input order produces one canonical aggregate", async () => {
  const node = await fixture("observation.valid.json");
  const selenium = structuredClone(node);
  selenium.provider_id = "selenium";
  selenium.components[0].id = "selenium-framework";
  selenium.components[0].eventual_managed_paths = [
    "tests/e2e/selenium/package.json",
    "tests/e2e/selenium/package-lock.json",
  ];
  selenium.relations = [
    {
      constraint: ">=24",
      from: "selenium-framework",
      hard: true,
      id: "selenium-requires-node",
      to: "node-runtime",
      type: "requires",
    },
  ];

  const forward = validateProviderSet(
    [node, selenium],
    { capabilityIds },
  );
  const reverse = validateProviderSet(
    [selenium, node],
    { capabilityIds },
  );
  assert.equal(canonicalDocument(forward), canonicalDocument(reverse));
});
