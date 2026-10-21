import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectSeleniumObservation,
  createSeleniumQualificationPlan,
  createSeleniumValidation,
  SELENIUM_MANAGED_PATHS,
} from "./selenium-collector.mjs";
import {
  readCapabilityCatalog,
  subjectDigest,
  validateIndependentQualification,
} from "./contract.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/selenium/",
  import.meta.url,
);
const GENERATED_AT = "2026-10-21T18:00:00Z";
const REVISION = "a".repeat(40);
const REPOSITORY = {
  name: "sbalswa/oculix",
  revision: REVISION,
};

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), "selenium-collector-"));
  const seleniumDirectory = join(directory, "tests", "e2e", "selenium");
  await mkdir(seleniumDirectory, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await cp(new URL(name, FIXTURE_ROOT), join(seleniumDirectory, name));
  }
  await cp(
    new URL("capabilities.json", FIXTURE_ROOT),
    join(directory, "tests", "e2e", "capabilities.json"),
  );
  return directory;
}

async function withRepository(callback) {
  const repositoryRoot = await createRepository();
  try {
    return await callback(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}

async function candidateInputs(repositoryRoot, overrides = {}) {
  const npmCandidates = await fixture("npm-candidates.json");
  return {
    repositoryRoot,
    repository: REPOSITORY,
    generatedAt: GENERATED_AT,
    npm: async (packageName) =>
      structuredClone(npmCandidates[packageName]),
    runnerEvidence: await fixture("runner-evidence.json"),
    ...overrides,
  };
}

async function collectCandidate(repositoryRoot, overrides = {}) {
  return collectSeleniumObservation(
    await candidateInputs(repositoryRoot, overrides),
  );
}

function component(observation, id) {
  return observation.components.find((entry) => entry.id === id);
}

function relation(observation, id) {
  return observation.relations.find((entry) => entry.id === id);
}

function result(capabilityId, {
  status = "pass",
  warnings = [],
  digest = "e".repeat(64),
} = {}) {
  return {
    capability_id: capabilityId,
    status,
    warnings,
    evidence: [
      {
        type: "github-actions-run",
        locator: `https://github.com/sbalswa/oculix/actions/runs/${capabilityId}`,
        revision: REVISION,
        digest: `sha256:${digest}`,
        started_at: "2026-10-21T18:05:00Z",
        completed_at: "2026-10-21T18:10:00Z",
      },
    ],
  };
}

test("collects one deterministic Selenium candidate cohort", async () => {
  await withRepository(async (repositoryRoot) => {
    const first = await collectCandidate(repositoryRoot);
    const npmCandidates = await fixture("npm-candidates.json");
    const second = await collectCandidate(repositoryRoot, {
      selectedCapabilityIds: [
        "selenium-ubuntu-chromium",
        "selenium-linux-chromium",
      ],
      npm: async (packageName) => {
        const metadata = npmCandidates[packageName];
        return Object.fromEntries(Object.entries(metadata).toReversed());
      },
    });

    assert.deepEqual(first, second);
    assert.equal(
      first.capability_catalog.digest,
      (
        await readCapabilityCatalog(
          join(repositoryRoot, "tests", "e2e", "capabilities.json"),
        )
      ).digest,
    );
    assert.equal(first.provider_id, "selenium");
    assert.deepEqual(first.disposition, {
      state: "candidate",
      reason_codes: ["CANDIDATE_AVAILABLE"],
    });
    assert.equal(
      component(first, "selenium-webdriver").current.version,
      "4.51.0",
    );
    assert.equal(
      component(first, "selenium-webdriver").candidate.version,
      "4.52.0",
    );
    assert.equal(
      component(first, "selenium-axe-webdriverjs").current.version,
      "4.14.0",
    );
    assert.equal(
      component(first, "selenium-axe-webdriverjs").candidate.version,
      "4.15.0",
    );
  });
});

test("records Node, browser-driver, axe, paths, and all selected capabilities", async () => {
  await withRepository(async (repositoryRoot) => {
    const observation = await collectCandidate(repositoryRoot);
    const selenium = component(observation, "selenium-webdriver");
    const axe = component(observation, "selenium-axe-webdriverjs");

    assert.deepEqual(
      selenium.affected_capabilities,
      ["selenium-linux-chromium", "selenium-ubuntu-chromium"],
    );
    assert.deepEqual(axe.affected_capabilities, selenium.affected_capabilities);
    assert.deepEqual(
      observation.components.flatMap(
        (entry) => entry.eventual_managed_paths,
      ).sort(),
      [...SELENIUM_MANAGED_PATHS].sort(),
    );
    assert.match(
      relation(observation, "selenium-webdriver-node").constraint,
      /root=>=24;current=>=22\.0\.0;candidate=>=24\.0\.0/u,
    );
    assert.match(
      relation(observation, "selenium-axe-node").constraint,
      /current=>=22\.12\.0;candidate=>=24\.0\.0/u,
    );
    assert.deepEqual(
      {
        type: relation(
          observation,
          "selenium-runner-browser-driver",
        ).type,
        hard: relation(
          observation,
          "selenium-runner-browser-driver",
        ).hard,
      },
      { type: "must-match", hard: true },
    );
    assert.match(
      relation(
        observation,
        "selenium-runner-browser-driver",
      ).constraint,
      /browser-key=141\.0\.7390;driver-key=141\.0\.7390/u,
    );
    assert.deepEqual(
      {
        type: relation(
          observation,
          "selenium-axe-policy-alignment",
        ).type,
        hard: relation(
          observation,
          "selenium-axe-policy-alignment",
        ).hard,
      },
      { type: "policy-align", hard: false },
    );
    assert.match(
      relation(
        observation,
        "selenium-axe-policy-alignment",
      ).constraint,
      /candidate-axe-core=~4\.15\.0/u,
    );
    assert.deepEqual(
      selenium.candidate.evidence
        .filter((evidence) => evidence.type.startsWith("runner-"))
        .map((evidence) => evidence.type)
        .sort(),
      ["runner-browser", "runner-driver"],
    );
  });
});

test("missing runner evidence remains unknown and cannot be planned", async () => {
  await withRepository(async (repositoryRoot) => {
    const inputs = await candidateInputs(repositoryRoot);
    delete inputs.runnerEvidence;
    const observation = await collectSeleniumObservation(inputs);

    assert.deepEqual(observation.disposition, {
      state: "unknown",
      reason_codes: ["RUNNER_BROWSER_DRIVER_EVIDENCE_MISSING"],
    });
    assert.ok(
      observation.components.every(
        (entry) =>
          !entry.candidate.evidence.some((item) =>
            item.type.startsWith("runner-"),
          ),
      ),
    );
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog: {},
          runnerEvidence: null,
        }),
    );
  });
});

test("mismatched runner browser-driver evidence remains unknown", async () => {
  await withRepository(async (repositoryRoot) => {
    const runnerEvidence = await fixture("runner-evidence.json");
    runnerEvidence.driver.compatibility_key = "140.0.7339";
    const observation = await collectCandidate(repositoryRoot, {
      runnerEvidence,
    });

    assert.deepEqual(observation.disposition, {
      state: "unknown",
      reason_codes: ["RUNNER_BROWSER_DRIVER_MISMATCH"],
    });
    assert.match(
      relation(
        observation,
        "selenium-runner-browser-driver",
      ).constraint,
      /browser-key=141\.0\.7390;driver-key=140\.0\.7339/u,
    );
  });
});

test("invalid runner evidence is unavailable rather than inferred", async () => {
  await withRepository(async (repositoryRoot) => {
    const runnerEvidence = await fixture("runner-evidence.json");
    delete runnerEvidence.driver.digest;
    const observation = await collectCandidate(repositoryRoot, {
      runnerEvidence,
    });

    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["RUNNER_BROWSER_DRIVER_EVIDENCE_INVALID"],
    });
    assert.doesNotMatch(
      relation(
        observation,
        "selenium-runner-browser-driver",
      ).constraint,
      /browser-key/u,
    );
  });
});

test("npm source failures and malformed metadata remain unavailable", async () => {
  await withRepository(async (repositoryRoot) => {
    const unavailable = await collectCandidate(repositoryRoot, {
      npm: async () => {
        const error = new Error("registry unavailable");
        error.code = "ENETUNREACH";
        throw error;
      },
    });
    assert.deepEqual(unavailable.disposition, {
      state: "unavailable",
      reason_codes: ["NPM_METADATA_UNAVAILABLE"],
    });
    assert.ok(
      unavailable.components.every((entry) => entry.candidate === null),
    );

    const npmCandidates = await fixture("npm-candidates.json");
    delete npmCandidates["@axe-core/webdriverjs"].engines;
    const malformed = await collectCandidate(repositoryRoot, {
      npm: async (packageName) => npmCandidates[packageName],
    });
    assert.deepEqual(malformed.disposition, {
      state: "unavailable",
      reason_codes: ["NPM_METADATA_INVALID"],
    });
  });
});

test("independent source failures preserve missing runner evidence", async () => {
  await withRepository(async (repositoryRoot) => {
    const inputs = await candidateInputs(repositoryRoot, {
      npm: async () => {
        const error = new Error("registry unavailable");
        error.code = "ENETUNREACH";
        throw error;
      },
    });
    delete inputs.runnerEvidence;
    const observation = await collectSeleniumObservation(inputs);

    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: [
        "NPM_METADATA_UNAVAILABLE",
        "RUNNER_BROWSER_DRIVER_EVIDENCE_MISSING",
      ],
    });
  });
});

test("npm version regression fails closed", async () => {
  await withRepository(async (repositoryRoot) => {
    const npmCandidates = await fixture("npm-candidates.json");
    npmCandidates["selenium-webdriver"].version = "4.50.0";
    const observation = await collectCandidate(repositoryRoot, {
      npm: async (packageName) => npmCandidates[packageName],
    });
    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["NPM_METADATA_REGRESSION"],
    });
  });
});

test("an unchanged npm cohort reports current", async () => {
  await withRepository(async (repositoryRoot) => {
    const npmCandidates = await fixture("npm-candidates.json");
    npmCandidates["@axe-core/webdriverjs"].version = "4.14.0";
    npmCandidates["selenium-webdriver"].version = "4.51.0";
    const observation = await collectCandidate(repositoryRoot, {
      npm: async (packageName) => npmCandidates[packageName],
    });

    assert.deepEqual(observation.disposition, {
      state: "current",
      reason_codes: [],
    });
    assert.ok(
      observation.components.every((entry) => entry.candidate === null),
    );
  });
});

test("manifest and lock drift is rejected before npm discovery", async () => {
  await withRepository(async (repositoryRoot) => {
    const lockPath = join(
      repositoryRoot,
      "tests",
      "e2e",
      "selenium",
      "package-lock.json",
    );
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages[""].dependencies["selenium-webdriver"] = "4.50.0";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    let npmCalls = 0;

    await assert.rejects(
      collectSeleniumObservation(
        await candidateInputs(repositoryRoot, {
          npm: async () => {
            npmCalls += 1;
            return {};
          },
        }),
      ),
      /root dependency selenium-webdriver must match package\.json/u,
    );
    assert.equal(npmCalls, 0);
  });
});

test("plans boundary-limited preparation and every selected capability", async () => {
  await withRepository(async (repositoryRoot) => {
    const observation = await collectCandidate(repositoryRoot);
    const catalog = await fixture("capabilities.json");
    const runnerEvidence = await fixture("runner-evidence.json");
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog,
      runnerEvidence,
    });

    assert.equal(plan.workspace.kind, "ephemeral-copy");
    assert.equal(plan.workspace.repository_checkout_writable, false);
    assert.deepEqual(plan.managed_paths, SELENIUM_MANAGED_PATHS);
    assert.equal(plan.candidate_digest, subjectDigest(observation));
    assert.deepEqual(plan.selected_capabilities, [
      "selenium-linux-chromium",
      "selenium-ubuntu-chromium",
    ]);
    assert.deepEqual(plan.steps[0].writes, SELENIUM_MANAGED_PATHS);
    assert.deepEqual(
      plan.steps[0].command.slice(0, 7),
      [
        "npm",
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--save-exact",
        "--prefix",
        "tests/e2e/selenium",
      ],
    );
    assert.equal(plan.steps[1].command[1], "ci");
    assert.equal(plan.steps[2].id, "test-selenium-package");
    assert.deepEqual(
      plan.steps
        .filter((step) => step.phase === "capability")
        .map((step) => step.id),
      [
        "run-selenium-linux-chromium",
        "run-selenium-ubuntu-chromium",
      ],
    );
    assert.equal(
      plan.steps.find(
        (step) => step.id === "run-selenium-ubuntu-chromium",
      ).environment.E2E_DRIVER_BINARY,
      "/usr/bin/chromedriver",
    );
    assert.equal(
      plan.steps.find(
        (step) => step.id === "validate-selenium-ubuntu-chromium",
      ).environment.E2E_REQUIRE_ACCESSIBILITY,
      "true",
    );
  });
});

test("qualification planning rejects partial or changed evidence", async () => {
  await withRepository(async (repositoryRoot) => {
    const observation = await collectCandidate(repositoryRoot);
    const catalog = await fixture("capabilities.json");
    const runnerEvidence = await fixture("runner-evidence.json");

    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog,
          runnerEvidence,
          selectedCapabilityIds: ["selenium-ubuntu-chromium"],
        }),
      /complete selected Selenium capability set/u,
    );

    runnerEvidence.browser.digest = `sha256:${"f".repeat(64)}`;
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog,
          runnerEvidence,
        }),
      /must match the candidate observation/u,
    );
  });
});

test("warning-free full results are independently qualified", async () => {
  await withRepository(async (repositoryRoot) => {
    const observation = await collectCandidate(repositoryRoot);
    const results = [
      result("selenium-ubuntu-chromium"),
      result("selenium-linux-chromium", { digest: "f".repeat(64) }),
    ];
    const validation = createSeleniumValidation({
      observation,
      generatedAt: "2026-10-21T18:11:00Z",
      results,
    });

    assert.deepEqual(validation.disposition, {
      state: "independently-qualified",
      reason_codes: [],
    });
    assert.deepEqual(
      validation.results.map((entry) => entry.capability_id),
      ["selenium-linux-chromium", "selenium-ubuntu-chromium"],
    );
    assert.doesNotThrow(() =>
      validateIndependentQualification(observation, validation, {
        capabilityIds: new Set(validation.results.map(
          (entry) => entry.capability_id,
        )),
        capabilityCatalogDigest: observation.capability_catalog.digest,
      }),
    );
  });
});

test("warnings block qualification and partial results are rejected", async () => {
  await withRepository(async (repositoryRoot) => {
    const observation = await collectCandidate(repositoryRoot);
    const blocked = createSeleniumValidation({
      observation,
      results: [
        result("selenium-linux-chromium"),
        result("selenium-ubuntu-chromium", {
          warnings: ["artifact upload warned"],
        }),
      ],
    });
    assert.deepEqual(blocked.disposition, {
      state: "blocked",
      reason_codes: ["SELENIUM_QUALIFICATION_FAILED"],
    });

    assert.throws(
      () =>
        createSeleniumValidation({
          observation,
          results: [result("selenium-ubuntu-chromium")],
        }),
      /every selected Selenium capability/u,
    );
  });
});

test("collection and planning never mutate repository files", async () => {
  await withRepository(async (repositoryRoot) => {
    const observedPaths = [
      ...SELENIUM_MANAGED_PATHS,
      "tests/e2e/capabilities.json",
    ];
    const before = await Promise.all(
      observedPaths.map((path) => readFile(join(repositoryRoot, path))),
    );
    const observation = await collectCandidate(repositoryRoot);
    createSeleniumQualificationPlan({
      observation,
      catalog: await fixture("capabilities.json"),
      runnerEvidence: await fixture("runner-evidence.json"),
    });
    const after = await Promise.all(
      observedPaths.map((path) => readFile(join(repositoryRoot, path))),
    );

    assert.deepEqual(after, before);
  });
});
