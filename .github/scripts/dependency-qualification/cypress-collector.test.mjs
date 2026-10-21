import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectCypressCohort,
  createCypressQualificationPlan,
  qualifyCypressCandidate,
} from "./cypress-collector.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "../../..");
const FIXTURE_PATH = resolve(
  REPOSITORY_ROOT,
  "tests/dependency-qualification/fixtures/cypress/evidence.valid.json",
);
const PACKAGE_PATH = "tests/e2e/cypress/package.json";
const LOCK_PATH = "tests/e2e/cypress/package-lock.json";
const REVISION = "a".repeat(40);
const GENERATED_AT = "2026-10-21T17:00:00Z";

async function fixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
}

function evidenceProviders(evidence, overrides = {}) {
  return {
    npmEvidence:
      overrides.npmEvidence ??
      (async ({ name }) => structuredClone(evidence.npm[name])),
    binaryEvidence:
      overrides.binaryEvidence ??
      (async ({ phase }) => structuredClone(evidence.binary[phase])),
    externalBrowserEvidence:
      overrides.externalBrowserEvidence ??
      (async ({ capabilityId }) =>
        structuredClone(evidence.browser[capabilityId])),
  };
}

async function collect(overrides = {}) {
  const evidence = overrides.evidence ?? (await fixture());
  return collectCypressCohort({
    generatedAt: GENERATED_AT,
    repository: {
      name: "sbalswa/oculix",
      revision: REVISION,
    },
    repositoryRoot: overrides.repositoryRoot ?? REPOSITORY_ROOT,
    ...evidenceProviders(evidence, overrides),
  });
}

function relationById(observation, id) {
  return observation.relations.find((relation) => relation.id === id);
}

function componentById(observation, id) {
  return observation.components.find((component) => component.id === id);
}

test("collects one deterministic Cypress cohort with explicit evidence", async () => {
  const first = await collect();
  const second = await collect();

  assert.deepEqual(first, second);
  assert.equal(first.observation.disposition.state, "candidate");
  assert.equal(first.warnings.length, 0);
  assert.equal(
    componentById(first.observation, "cypress-package").candidate.version,
    "16.3.0",
  );
  assert.equal(
    componentById(first.observation, "cypress-axe-core").candidate.version,
    "4.15.0",
  );
  assert.equal(
    componentById(
      first.observation,
      "cypress-package-binary",
    ).candidate.version,
    "16.3.0",
  );
  assert.match(
    componentById(
      first.observation,
      "cypress-external-browser",
    ).current.version,
    /^chrome@141\./u,
  );

  const node = relationById(
    first.observation,
    "cypress-package-requires-node-runtime",
  );
  assert.equal(node.hard, true);
  assert.equal(node.type, "requires");
  assert.match(node.constraint, /\^22\.0\.0 \|\| \^24\.0\.0/u);

  const binary = relationById(
    first.observation,
    "cypress-package-matches-binary",
  );
  assert.equal(binary.hard, true);
  assert.equal(binary.type, "must-match");

  const browser = relationById(
    first.observation,
    "cypress-package-uses-catalog-browser",
  );
  assert.equal(browser.hard, true);
  assert.equal(browser.type, "uses-external");
  assert.match(browser.constraint, /chrome on ubuntu-latest/u);
  assert.doesNotMatch(browser.constraint, /electron/iu);

  const axe = relationById(
    first.observation,
    "cypress-package-aligns-axe-core",
  );
  assert.equal(axe.hard, false);
  assert.equal(axe.type, "policy-align");

  assert.deepEqual(
    first.observation.components.flatMap(
      ({ eventual_managed_paths }) => eventual_managed_paths,
    ),
    [
      "tests/e2e/cypress/package.json",
      "tests/e2e/cypress/package-lock.json",
      "tests/e2e/cypress/cypress.config.mjs",
      "tests/e2e/capabilities.json",
    ],
  );
});

test("plans package tests before every catalog-selected Cypress check", async () => {
  const { qualification_plan: plan } = await collect();
  assert.ok(plan);
  assert.equal(plan.workspace.kind, "ephemeral-copy");
  assert.equal(
    plan.workspace.mutation_boundary,
    "tests/e2e/cypress",
  );
  assert.deepEqual(plan.workspace.managed_paths, [
    "tests/e2e/cypress/package.json",
    "tests/e2e/cypress/package-lock.json",
  ]);
  assert.deepEqual(
    plan.selected_capabilities.map(({ id }) => id),
    ["cypress-ubuntu-chrome"],
  );
  assert.equal(plan.cypress_binary.version, "16.3.0");
  assert.equal(
    plan.cypress_binary.evidence.type,
    "cypress-binary",
  );
  const binaryCheck = plan.checks.find(
    ({ id }) => id === "cypress-installed-binary",
  );
  assert.equal(binaryCheck.expected_package_version, "16.3.0");
  assert.equal(binaryCheck.expected_binary_version, "16.3.0");
  const clonedPlan = createCypressQualificationPlan(
    await collect(),
  );
  clonedPlan.packages[0].version = "0.0.0";
  assert.notEqual(plan.packages[0].version, "0.0.0");

  const packageTestIndex = plan.checks.findIndex(
    ({ id }) => id === "cypress-package-tests",
  );
  const smokeIndex = plan.checks.findIndex(
    ({ id }) => id === "cypress-ubuntu-chrome-smoke",
  );
  const scenarioIndex = plan.checks.findIndex(
    ({ id }) => id === "cypress-ubuntu-chrome-web-calculator",
  );
  const artifactIndex = plan.checks.findIndex(
    ({ id }) =>
      id === "cypress-ubuntu-chrome-artifact-contracts",
  );
  assert.ok(packageTestIndex >= 0);
  assert.ok(packageTestIndex < smokeIndex);
  assert.ok(smokeIndex < scenarioIndex);
  assert.ok(scenarioIndex < artifactIndex);
  assert.deepEqual(plan.checks[artifactIndex].covers, [
    "reports",
    "accessibility",
    "evidence",
  ]);
  for (const check of plan.checks.filter(
    ({ scope }) => scope === "cypress-ubuntu-chrome",
  )) {
    if (check.covers.includes("reports")) {
      assert.equal(
        check.environment.E2E_BROWSER,
        undefined,
      );
      continue;
    }
    assert.deepEqual(check.arguments.slice(-2), ["--browser", "chrome"]);
    assert.equal(check.environment.E2E_BROWSER, "chrome");
    assert.ok(!check.arguments.includes("electron"));
  }
});

test("missing binary or browser evidence prevents qualification", async () => {
  const evidence = await fixture();
  const missingBinary = await collect({
    evidence,
    binaryEvidence: async ({ phase }) =>
      phase === "candidate"
        ? null
        : structuredClone(evidence.binary.current),
  });
  assert.equal(missingBinary.observation.disposition.state, "unavailable");
  assert.deepEqual(
    missingBinary.observation.disposition.reason_codes,
    ["CANDIDATE_CYPRESS_BINARY_EVIDENCE_UNAVAILABLE"],
  );
  assert.equal(missingBinary.qualification_plan, null);

  const missingBrowser = await collect({
    evidence,
    externalBrowserEvidence: async () => null,
  });
  assert.equal(missingBrowser.observation.disposition.state, "unavailable");
  assert.ok(
    missingBrowser.observation.disposition.reason_codes.includes(
      "CYPRESS_BROWSER_EVIDENCE_UNAVAILABLE",
    ),
  );
  assert.equal(missingBrowser.qualification_plan, null);
});

test("warnings and mismatched hard evidence fail closed", async () => {
  const warningEvidence = await fixture();
  warningEvidence.npm.cypress.warnings.push("registry mirror warning");
  const warned = await collect({ evidence: warningEvidence });
  assert.equal(warned.observation.disposition.state, "unknown");
  assert.deepEqual(warned.observation.disposition.reason_codes, [
    "EVIDENCE_WARNINGS",
  ]);
  assert.equal(warned.qualification_plan, null);

  const mismatchEvidence = await fixture();
  mismatchEvidence.binary.candidate.version = "16.4.0";
  const mismatched = await collect({ evidence: mismatchEvidence });
  assert.equal(mismatched.observation.disposition.state, "unavailable");
  assert.ok(
    mismatched.observation.disposition.reason_codes.includes(
      "CANDIDATE_CYPRESS_BINARY_VERSION_MISMATCH",
    ),
  );
  assert.equal(mismatched.qualification_plan, null);
});

test("current metadata is a no-op and registry regressions are unavailable", async () => {
  const currentEvidence = await fixture();
  currentEvidence.npm.cypress.version = "16.2.0";
  currentEvidence.npm.cypress.dist = {
    tarball: "https://registry.npmjs.org/cypress/-/cypress-16.2.0.tgz",
    integrity: "sha512-current-cypress-integrity",
  };
  currentEvidence.npm["axe-core"].version = "4.14.0";
  currentEvidence.npm["axe-core"].dist = {
    tarball: "https://registry.npmjs.org/axe-core/-/axe-core-4.14.0.tgz",
    integrity: "sha512-current-axe-integrity",
  };
  const current = await collect({ evidence: currentEvidence });
  assert.deepEqual(current.observation.disposition, {
    state: "current",
    reason_codes: [],
  });
  assert.equal(current.qualification_plan, null);

  const regressionEvidence = await fixture();
  regressionEvidence.npm.cypress.version = "15.9.0";
  regressionEvidence.npm.cypress.dist.tarball =
    "https://registry.npmjs.org/cypress/-/cypress-15.9.0.tgz";
  const regression = await collect({ evidence: regressionEvidence });
  assert.equal(regression.observation.disposition.state, "unavailable");
  assert.ok(
    regression.observation.disposition.reason_codes.includes(
      "CYPRESS_NPM_METADATA_REGRESSION",
    ),
  );
  assert.equal(regression.qualification_plan, null);
});

async function copyCollectorInputs(source, destination) {
  const paths = [
    PACKAGE_PATH,
    LOCK_PATH,
    "tests/e2e/capabilities.json",
    "mise/config.web-e2e.toml",
    "mise/mise.web-e2e.lock",
  ];
  for (const path of paths) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, path), target);
  }
}

test("never selects deprecated Electron even when catalogued", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cypress-electron-"));
  try {
    await copyCollectorInputs(REPOSITORY_ROOT, directory);
    const catalogPath = join(directory, "tests/e2e/capabilities.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const capability = catalog.capabilities.find(
      ({ tool }) => tool === "cypress",
    );
    capability.browser = "electron";
    capability.id = "cypress-ubuntu-electron";
    capability.selector = "ci:e2e:cypress:ubuntu:electron";
    await writeFile(
      catalogPath,
      `${JSON.stringify(catalog, null, 2)}\n`,
      "utf8",
    );

    const evidence = await fixture();
    evidence.browser["cypress-ubuntu-electron"] = {
      ...evidence.browser["cypress-ubuntu-chrome"],
      browser: "electron",
    };
    const result = await collect({
      evidence,
      repositoryRoot: directory,
    });
    assert.equal(result.observation.disposition.state, "unavailable");
    assert.ok(
      result.observation.disposition.reason_codes.includes(
        "DEPRECATED_ELECTRON_SELECTED",
      ),
    );
    assert.equal(result.qualification_plan, null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function materializeQualificationInputs(source, destination) {
  await copyCollectorInputs(source, destination);
  await writeFile(join(destination, "README.md"), "unchanged\n", "utf8");
}

async function updateEphemeralLock(plan, workspaceRoot) {
  const path = join(workspaceRoot, LOCK_PATH);
  const lock = JSON.parse(await readFile(path, "utf8"));
  for (const expected of plan.packages) {
    lock.packages[""].dependencies[expected.name] = expected.version;
    Object.assign(
      lock.packages[`node_modules/${expected.name}`],
      expected,
    );
  }
  lock.packages["node_modules/cypress"].engines.node = plan.node_range;
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function checkEvidence(check, sequence = 0) {
  return {
    type: "mocked-check",
    locator: `mock://${check.id}`,
    revision: REVISION,
    digest: `sha256:${String(sequence + 1).padStart(64, "0")}`,
    started_at: "2026-10-21T17:01:00Z",
    completed_at: "2026-10-21T17:01:01Z",
  };
}

function passingExecutor(plan, observed, overrides = {}) {
  let sequence = 0;
  return async (check, context) => {
    observed.push({
      check,
      packageRoot: context.packageRoot,
      workspaceRoot: context.workspaceRoot,
    });
    if (check.id === "cypress-candidate-lock") {
      await updateEphemeralLock(plan, context.workspaceRoot);
    }
    const currentSequence = sequence;
    sequence += 1;
    return {
      status: overrides.status?.(check) ?? "pass",
      warnings: overrides.warnings?.(check) ?? [],
      evidence:
        overrides.evidence?.(check) ??
        [checkEvidence(check, currentSequence)],
    };
  };
}

test("qualifies every check in an ephemeral workspace without mutation", async () => {
  const collection = await collect();
  const beforePackage = await readFile(
    join(REPOSITORY_ROOT, PACKAGE_PATH),
    "utf8",
  );
  const beforeLock = await readFile(
    join(REPOSITORY_ROOT, LOCK_PATH),
    "utf8",
  );
  const observed = [];
  const result = await qualifyCypressCandidate(collection, {
    executeCheck: passingExecutor(
      collection.qualification_plan,
      observed,
    ),
    generatedAt: "2026-10-21T17:02:00Z",
    materializeWorkspace: materializeQualificationInputs,
    repositoryRoot: REPOSITORY_ROOT,
  });

  assert.equal(
    result.validation.disposition.state,
    "independently-qualified",
  );
  assert.deepEqual(
    result.validation.results.map(({ capability_id, status, warnings }) => ({
      capability_id,
      status,
      warnings,
    })),
    [
      {
        capability_id: "cypress-ubuntu-chrome",
        status: "pass",
        warnings: [],
      },
    ],
  );
  assert.equal(result.checks.length, collection.qualification_plan.checks.length);
  assert.ok(observed.length > 0);
  const workspaceRoot = observed[0].workspaceRoot;
  assert.ok(!workspaceRoot.startsWith(`${REPOSITORY_ROOT}/`));
  assert.ok(
    observed.every(
      ({ packageRoot }) =>
        packageRoot === join(workspaceRoot, "tests/e2e/cypress"),
    ),
  );
  await assert.rejects(access(workspaceRoot));
  assert.equal(
    await readFile(join(REPOSITORY_ROOT, PACKAGE_PATH), "utf8"),
    beforePackage,
  );
  assert.equal(
    await readFile(join(REPOSITORY_ROOT, LOCK_PATH), "utf8"),
    beforeLock,
  );
});

test("qualification warnings and missing evidence cannot become success", async () => {
  const warnedCollection = await collect();
  const warned = await qualifyCypressCandidate(warnedCollection, {
    executeCheck: passingExecutor(
      warnedCollection.qualification_plan,
      [],
      {
        warnings: (check) =>
          check.id === "cypress-package-tests"
            ? ["package warning"]
            : [],
      },
    ),
    generatedAt: "2026-10-21T17:03:00Z",
    materializeWorkspace: materializeQualificationInputs,
    repositoryRoot: REPOSITORY_ROOT,
  });
  assert.equal(warned.validation.disposition.state, "blocked");
  assert.deepEqual(warned.validation.disposition.reason_codes, [
    "QUALIFICATION_WARNINGS",
  ]);

  const missingCollection = await collect();
  const missing = await qualifyCypressCandidate(missingCollection, {
    executeCheck: passingExecutor(
      missingCollection.qualification_plan,
      [],
      {
        evidence: (check) =>
          check.id === "cypress-package-tests"
            ? []
            : [checkEvidence(check)],
      },
    ),
    generatedAt: "2026-10-21T17:04:00Z",
    materializeWorkspace: materializeQualificationInputs,
    repositoryRoot: REPOSITORY_ROOT,
  });
  assert.equal(missing.validation.disposition.state, "unknown");
  assert.deepEqual(missing.validation.disposition.reason_codes, [
    "QUALIFICATION_EVIDENCE_MISSING",
  ]);
});

test("stale plans, in-repository workspaces, and boundary writes are rejected", async () => {
  const stale = await collect();
  stale.qualification_plan.candidate_digest = "f".repeat(64);
  await assert.rejects(
    qualifyCypressCandidate(stale, {
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    }),
    /qualification plan is stale/u,
  );

  const nested = await collect();
  await assert.rejects(
    qualifyCypressCandidate(nested, {
      createWorkspace: async () => join(REPOSITORY_ROOT, ".qualification"),
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    }),
    /must be outside the repository/u,
  );

  const escaped = await collect();
  const executor = passingExecutor(
    escaped.qualification_plan,
    [],
    {
      status: () => "pass",
    },
  );
  let wroteOutside = false;
  await assert.rejects(
    qualifyCypressCandidate(escaped, {
      executeCheck: async (check, context) => {
        const result = await executor(check, context);
        if (!wroteOutside && check.id === "cypress-package-tests") {
          wroteOutside = true;
          await writeFile(
            join(context.workspaceRoot, "README.md"),
            "mutated\n",
            "utf8",
          );
        }
        return result;
      },
      generatedAt: "2026-10-21T17:05:00Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    }),
    /outside its package boundary/u,
  );
});
