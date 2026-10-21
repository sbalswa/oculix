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
import { dirname, join } from "node:path";
import test from "node:test";

import {
  collectSeleniumObservation,
  createSeleniumQualificationPlan,
  normalizeSemverRange,
  parseExactSemver,
  qualifySeleniumCandidate,
  SELENIUM_MANAGED_PATHS,
  semverRangeSatisfies,
} from "./selenium-collector.mjs";
import {
  canonicalDocument,
  readCapabilityCatalog,
  validateIndependentQualification,
  validateProviderSet,
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
  const root = await mkdtemp(join(tmpdir(), "selenium-collector-"));
  const packageRoot = join(root, "tests", "e2e", "selenium");
  await mkdir(packageRoot, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await cp(new URL(name, FIXTURE_ROOT), join(packageRoot, name));
  }
  await cp(
    new URL("capabilities.json", FIXTURE_ROOT),
    join(root, "tests", "e2e", "capabilities.json"),
  );
  await writeFile(join(root, "README.md"), "unchanged\n", "utf8");
  return {
    root,
    async cleanup() {
      await rm(root, { force: true, recursive: true });
    },
  };
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

function deterministicClock() {
  let second = 0;
  return () => {
    const value = new Date(`2026-10-21T18:10:${String(second).padStart(2, "0")}Z`);
    second += 1;
    return value;
  };
}

function rawResult({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
  };
}

async function materializeInstalledPackages(packageRoot) {
  for (const [name, version] of [
    ["@axe-core/webdriverjs", "4.15.0"],
    ["selenium-webdriver", "4.52.0"],
  ]) {
    const directory = join(packageRoot, "node_modules", ...name.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name, version })}\n`,
      "utf8",
    );
  }
}

async function writeCapabilityArtifacts(workspaceRoot, capabilityId) {
  const scenario =
    capabilityId === "selenium-ubuntu-chromium"
      ? "web-calculator"
      : "smoke";
  const directory = join(
    workspaceRoot,
    "tests",
    "e2e",
    "selenium",
    "diagnostics",
    scenario,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "result.png"), "png\n", "utf8");
  await writeFile(
    join(directory, "result.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      capability: { id: capabilityId },
      scenario,
      status: "passed",
      assertion: { status: "passed" },
      accessibility:
        scenario === "web-calculator"
          ? { status: "passed", counts: { violations: 0 } }
          : { status: "not-run", counts: null },
    })}\n`,
    "utf8",
  );
}

function passingRunner(observed, overrides = {}) {
  return async (step, context) => {
    observed.push({ step, context });
    if (step.id === "apply-selenium-tarballs") {
      await cp(
        new URL("candidate-package-lock.json", FIXTURE_ROOT),
        join(context.packageRoot, "package-lock.json"),
      );
    }
    if (step.id === "install-selenium-candidate") {
      await materializeInstalledPackages(context.packageRoot);
    }
    if (step.id === "verify-runner-browser") {
      return rawResult({
        stdout: "Chromium 141.0.7390.54\n",
        ...overrides.browser,
      });
    }
    if (step.id === "verify-runner-driver") {
      return rawResult({
        stdout: "ChromeDriver 141.0.7390.54\n",
        ...overrides.driver,
      });
    }
    if (step.id.endsWith("-artifact-contracts")) {
      await writeCapabilityArtifacts(
        context.workspaceRoot,
        step.capability_id,
      );
    }
    return rawResult(
      overrides.result?.(step) ?? {},
    );
  };
}

async function qualify(
  repository,
  observation,
  overrides = {},
) {
  const catalog = await fixture("capabilities.json");
  return qualifySeleniumCandidate(
    {
      observation,
      repositoryRoot: repository.root,
    },
    {
      catalog,
      generatedAt: "2026-10-21T18:20:00Z",
      now: deterministicClock(),
      readGitState: async () => " M pre-existing-change\n",
      ...overrides,
    },
  );
}

test("collects a deterministic immutable candidate cohort", async () => {
  const repository = await createRepository();
  try {
    const first = await collectCandidate(repository.root);
    const npmCandidates = await fixture("npm-candidates.json");
    const second = await collectCandidate(repository.root, {
      npm: async (name) =>
        Object.fromEntries(
          Object.entries(npmCandidates[name]).toReversed(),
        ),
      selectedCapabilityIds: [
        "selenium-ubuntu-chromium",
        "selenium-linux-chromium",
      ],
    });
    const catalog = await readCapabilityCatalog(
      join(repository.root, "tests/e2e/capabilities.json"),
    );

    assert.equal(canonicalDocument(first), canonicalDocument(second));
    assert.equal(first.capability_catalog.digest, catalog.digest);
    assert.deepEqual(first.disposition, {
      state: "candidate",
      reason_codes: ["CANDIDATE_AVAILABLE"],
    });
    assert.equal(
      component(first, "selenium-webdriver").candidate.version,
      "4.52.0",
    );
    assert.equal(
      component(first, "selenium-axe-webdriverjs").candidate.version,
      "4.15.0",
    );
    const metadata = JSON.parse(
      component(first, "selenium-webdriver")
        .candidate.evidence[0].revision,
    );
    assert.deepEqual(metadata.dist, {
      integrity: "sha512-Y2FuZGlkYXRlLXNlbGVuaXVt",
      tarball:
        "https://registry.npmjs.org/selenium-webdriver/-/selenium-webdriver-4.52.0.tgz",
    });
  } finally {
    await repository.cleanup();
  }
});

test("emits machine-evaluable Node, browser-driver, and axe relations", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const node = relation(observation, "selenium-webdriver-node");
    const browserDriver = relation(
      observation,
      "selenium-runner-browser-driver",
    );
    const axe = relation(
      observation,
      "selenium-axe-policy-alignment",
    );

    assert.equal(node.type, "requires");
    assert.equal(node.hard, true);
    assert.equal(
      semverRangeSatisfies("24.22.0", node.constraint),
      true,
    );
    assert.equal(
      semverRangeSatisfies("23.11.0", node.constraint),
      false,
    );
    assert.deepEqual(
      {
        type: browserDriver.type,
        hard: browserDriver.hard,
        from: browserDriver.from,
        to: browserDriver.to,
        constraint: browserDriver.constraint,
      },
      {
        type: "must-match",
        hard: true,
        from: "selenium-runner-browser",
        to: "selenium-runner-driver",
        constraint: "=141.0.7390",
      },
    );
    assert.equal(
      semverRangeSatisfies(
        component(
          observation,
          "selenium-runner-driver",
        ).candidate.version,
        browserDriver.constraint,
      ),
      true,
    );
    assert.equal(axe.type, "policy-align");
    assert.equal(axe.hard, false);
    assert.equal(axe.constraint, ">=4.40.0");
    assert.equal(
      semverRangeSatisfies(
        component(observation, "selenium-webdriver").candidate.version,
        axe.constraint,
      ),
      true,
    );
  } finally {
    await repository.cleanup();
  }
});

test("uses actual runner components without provider path collisions", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const catalog = await readCapabilityCatalog(
      join(repository.root, "tests/e2e/capabilities.json"),
    );
    const node = {
      schema_version: 1,
      kind: "observation",
      generated_at: GENERATED_AT,
      repository: observation.repository,
      capability_catalog: observation.capability_catalog,
      provider_id: "node",
      disposition: { state: "current", reason_codes: [] },
      components: [
        {
          id: "node-runtime",
          lane: "node",
          ecosystem: "mise",
          current: {
            version: "24.22.0",
            evidence: [
              {
                type: "repository-file",
                locator: "mise/mise.web-e2e.lock",
                revision: REVISION,
                digest: `sha256:${"b".repeat(64)}`,
                observed_at: GENERATED_AT,
              },
            ],
          },
          candidate: null,
          eventual_managed_paths: ["mise/mise.web-e2e.lock"],
          affected_capabilities: ["selenium-ubuntu-chromium"],
        },
      ],
      relations: [],
    };

    assert.deepEqual(
      observation.components.map(({ id }) => id),
      [
        "selenium-axe-webdriverjs",
        "selenium-runner-browser",
        "selenium-runner-driver",
        "selenium-webdriver",
      ],
    );
    assert.deepEqual(
      observation.components.flatMap(
        ({ eventual_managed_paths }) => eventual_managed_paths,
      ),
      [
        "tests/e2e/selenium/package-lock.json",
        "tests/e2e/selenium/configuration.mjs",
        "tests/e2e/selenium/setup.mjs",
        "tests/e2e/selenium/package.json",
      ],
    );
    assert.doesNotThrow(() =>
      validateProviderSet([observation, node], {
        capabilityIds: catalog.ids,
        capabilityCatalogDigest: catalog.digest,
      }),
    );
  } finally {
    await repository.cleanup();
  }
});

test("missing or mismatched runner evidence remains unknown", async () => {
  const repository = await createRepository();
  try {
    const missingInputs = await candidateInputs(repository.root);
    delete missingInputs.runnerEvidence;
    const missing = await collectSeleniumObservation(missingInputs);
    assert.deepEqual(missing.disposition, {
      state: "unknown",
      reason_codes: ["RUNNER_BROWSER_DRIVER_EVIDENCE_MISSING"],
    });
    assert.equal(
      component(missing, "selenium-runner-browser").candidate,
      null,
    );

    const runnerEvidence = await fixture("runner-evidence.json");
    runnerEvidence.driver.compatibility_key = "140.0.7339";
    runnerEvidence.driver.version = "140.0.7339.80";
    const mismatched = await collectCandidate(repository.root, {
      runnerEvidence,
    });
    assert.deepEqual(mismatched.disposition, {
      state: "unknown",
      reason_codes: ["RUNNER_BROWSER_DRIVER_MISMATCH"],
    });
    assert.equal(
      semverRangeSatisfies(
        component(
          mismatched,
          "selenium-runner-driver",
        ).candidate.version,
        relation(
          mismatched,
          "selenium-runner-browser-driver",
        ).constraint,
      ),
      false,
    );
  } finally {
    await repository.cleanup();
  }
});

test("strictly rejects malformed semantic versions and ranges", async () => {
  for (const version of [
    "4.01.0",
    "4.1",
    "v4.1.0",
    "4.1.0-01",
    "4.1.0+",
  ]) {
    assert.throws(
      () => parseExactSemver(version),
      /exact semantic version|identifier/u,
    );
  }
  for (const range of [
    "",
    ">=banana",
    ">=01.0.0",
    ">=1.2.3 ||",
    ">x.2",
    "1..2",
  ]) {
    assert.throws(
      () => normalizeSemverRange(range),
      /nonempty|invalid|empty/u,
    );
  }
  assert.equal(
    normalizeSemverRange(
      ">3.0.0-beta  || >= 2.53.1 || >4.0.0-alpha",
    ),
    ">3.0.0-beta || >=2.53.1 || >4.0.0-alpha",
  );

  const repository = await createRepository();
  try {
    const metadata = await fixture("npm-candidates.json");
    metadata["selenium-webdriver"].engines.node = ">=banana";
    const observation = await collectCandidate(repository.root, {
      npm: async (name) => metadata[name],
    });
    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["NPM_METADATA_INVALID"],
    });
    assert.ok(
      observation.components.every(
        ({ candidate }) => candidate === null,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("rejects malformed current package pins before npm discovery", async () => {
  const repository = await createRepository();
  try {
    const path = join(
      repository.root,
      "tests",
      "e2e",
      "selenium",
      "package.json",
    );
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.dependencies["selenium-webdriver"] = "4.051.0";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    let calls = 0;

    await assert.rejects(
      collectSeleniumObservation(
        await candidateInputs(repository.root, {
          npm: async () => {
            calls += 1;
            return {};
          },
        }),
      ),
      /exact semantic version/u,
    );
    assert.equal(calls, 0);
  } finally {
    await repository.cleanup();
  }
});

test("qualification plan installs immutable tarballs and binds executables", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog: await fixture("capabilities.json"),
    });
    const apply = plan.steps.find(
      ({ id }) => id === "apply-selenium-tarballs",
    );

    assert.deepEqual(plan.workspace, {
      kind: "ephemeral-copy",
      mutation_boundary: "tests/e2e/selenium",
      managed_paths: SELENIUM_MANAGED_PATHS,
    });
    assert.ok(
      apply.arguments.includes(
        "https://registry.npmjs.org/@axe-core/webdriverjs/-/webdriverjs-4.15.0.tgz",
      ),
    );
    assert.ok(
      apply.arguments.includes(
        "https://registry.npmjs.org/selenium-webdriver/-/selenium-webdriver-4.52.0.tgz",
      ),
    );
    assert.ok(
      apply.arguments.every(
        (argument) =>
          argument !== "selenium-webdriver@4.52.0" &&
          argument !== "@axe-core/webdriverjs@4.15.0",
      ),
    );
    assert.equal(
      plan.packages[0].dist.integrity,
      "sha512-Y2FuZGlkYXRlLWF4ZQ==",
    );
    assert.equal(
      plan.steps.find(({ id }) => id === "verify-runner-browser")
        .command,
      "/usr/bin/chromium",
    );
    assert.ok(
      plan.steps
        .filter(({ capability_id: id }) => id !== null)
        .every(
          ({ environment }) =>
            environment.E2E_BROWSER_BINARY === "/usr/bin/chromium" &&
            environment.E2E_DRIVER_BINARY === "/usr/bin/chromedriver",
        ),
    );
    const tampered = structuredClone(observation);
    const browser = component(tampered, "selenium-runner-browser");
    browser.candidate.evidence[0].locator = "/tmp/unobserved-browser";
    const catalog = await fixture("capabilities.json");
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation: tampered,
          catalog,
        }),
    );
  } finally {
    await repository.cleanup();
  }
});

test("controlled ephemeral execution independently qualifies all capabilities", async () => {
  const repository = await createRepository();
  let temporaryRoot;
  try {
    const observation = await collectCandidate(repository.root);
    const before = await Promise.all(
      SELENIUM_MANAGED_PATHS.map((path) =>
        readFile(join(repository.root, path))),
    );
    const observed = [];
    const result = await qualify(repository, observation, {
      createWorkspace: async () => {
        temporaryRoot = await mkdtemp(
          join(tmpdir(), "selenium-qualification-test-"),
        );
        return temporaryRoot;
      },
      runCommand: passingRunner(observed),
    });

    assert.deepEqual(result.validation.disposition, {
      state: "independently-qualified",
      reason_codes: [],
    });
    assert.deepEqual(
      result.validation.results.map(
        ({ capability_id: id, status, warnings }) => ({
          id,
          status,
          warnings,
        }),
      ),
      [
        {
          id: "selenium-linux-chromium",
          status: "pass",
          warnings: [],
        },
        {
          id: "selenium-ubuntu-chromium",
          status: "pass",
          warnings: [],
        },
      ],
    );
    assert.ok(
      result.validation.results.every(({ evidence }) =>
        evidence.some(
          ({ type }) => type === "qualification-artifacts",
        ) &&
        evidence.some(
          ({ type }) => type === "qualification-git-state",
        )),
    );
    assert.doesNotThrow(() =>
      validateIndependentQualification(
        observation,
        result.validation,
        {
          capabilityIds: new Set(
            result.validation.results.map(
              ({ capability_id: id }) => id,
            ),
          ),
          capabilityCatalogDigest:
            observation.capability_catalog.digest,
        },
      ),
    );
    await assert.rejects(access(temporaryRoot));
    assert.deepEqual(
      await Promise.all(
        SELENIUM_MANAGED_PATHS.map((path) =>
          readFile(join(repository.root, path))),
      ),
      before,
    );
    assert.ok(
      observed.every(
        ({ step }) =>
          step.status === undefined &&
          step.evidence === undefined &&
          step.warnings === undefined,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("caller-supplied statuses or evidence cannot fabricate success", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    let calls = 0;
    const result = await qualify(repository, observation, {
      runCommand: async () => {
        calls += 1;
        return {
          ...rawResult(),
          status: "pass",
          warnings: [],
          evidence: [
            {
              type: "forged",
            },
          ],
        };
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(result.validation.disposition, {
      state: "blocked",
      reason_codes: ["APPLICATION_FAILED"],
    });
    assert.ok(
      result.validation.results.every(
        ({ status }) => status === "fail",
      ),
    );
    assert.ok(
      result.validation.results.every(({ evidence }) =>
        evidence.every(({ type }) => type !== "forged")),
    );
  } finally {
    await repository.cleanup();
  }
});

test("wrong lock integrity cannot pass preparation", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const observed = [];
    const runner = passingRunner(observed);
    const result = await qualify(repository, observation, {
      runCommand: async (step, context) => {
        const raw = await runner(step, context);
        if (step.id === "apply-selenium-tarballs") {
          const path = join(context.packageRoot, "package-lock.json");
          const lock = JSON.parse(await readFile(path, "utf8"));
          lock.packages[
            "node_modules/selenium-webdriver"
          ].integrity = "sha512-d3Jvbmc=";
          await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
        }
        return raw;
      },
    });

    assert.deepEqual(result.validation.disposition, {
      state: "blocked",
      reason_codes: ["LOCK_VERIFICATION_FAILED"],
    });
    assert.ok(
      observed.every(
        ({ step }) => step.id !== "install-selenium-candidate",
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("runner executable identity is verified before scenarios", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const observed = [];
    const result = await qualify(repository, observation, {
      runCommand: passingRunner(observed, {
        browser: { stdout: "Chromium 140.0.7339.80\n" },
      }),
    });

    assert.deepEqual(result.validation.disposition, {
      state: "blocked",
      reason_codes: ["RUNNER_EXECUTABLE_IDENTITY_MISMATCH"],
    });
    assert.ok(
      observed.every(
        ({ step }) => step.capability_id === null,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("captured warnings prevent independent admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const result = await qualify(repository, observation, {
      runCommand: passingRunner([], {
        result: (step) =>
          step.id === "test-selenium-package"
            ? { stderr: "WARNING: package emitted a warning\n" }
            : {},
      }),
    });

    assert.deepEqual(result.validation.disposition, {
      state: "blocked",
      reason_codes: ["QUALIFICATION_WARNINGS"],
    });
    assert.ok(
      result.validation.results.every(
        ({ status, warnings }) =>
          status === "pass" && warnings.length === 1,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("missing artifacts prevent independent admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const observed = [];
    const runner = passingRunner(observed);
    const result = await qualify(repository, observation, {
      runCommand: async (step, context) => {
        if (step.id.endsWith("-artifact-contracts")) {
          observed.push({ step, context });
          return rawResult();
        }
        return runner(step, context);
      },
    });

    assert.ok(
      result.validation.disposition.reason_codes.includes(
        "ARTIFACT_VALIDATION_FAILED",
      ),
    );
    assert.ok(
      result.validation.results.every(
        ({ status }) => status === "fail",
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("workspace boundary and source Git-state mutations fail closed", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root);
    const outsideRunner = passingRunner([]);
    await assert.rejects(
      qualify(repository, observation, {
        runCommand: async (step, context) => {
          const raw = await outsideRunner(step, context);
          if (step.id === "test-selenium-package") {
            await writeFile(
              join(context.workspaceRoot, "README.md"),
              "mutated\n",
              "utf8",
            );
          }
          return raw;
        },
      }),
      /outside its package boundary/u,
    );

    let gitState = "clean\n";
    const sourceRunner = passingRunner([]);
    await assert.rejects(
      qualify(repository, observation, {
        readGitState: async () => gitState,
        runCommand: async (step, context) => {
          const raw = await sourceRunner(step, context);
          if (step.id === "test-selenium-package") {
            gitState = "changed\n";
          }
          return raw;
        },
      }),
      /changed source Git state/u,
    );
  } finally {
    await repository.cleanup();
  }
});

test("collection and planning never mutate source package state", async () => {
  const repository = await createRepository();
  try {
    const before = await Promise.all(
      [
        ...SELENIUM_MANAGED_PATHS,
        "tests/e2e/capabilities.json",
      ].map((path) => readFile(join(repository.root, path))),
    );
    const observation = await collectCandidate(repository.root);
    createSeleniumQualificationPlan({
      observation,
      catalog: await fixture("capabilities.json"),
    });
    const after = await Promise.all(
      [
        ...SELENIUM_MANAGED_PATHS,
        "tests/e2e/capabilities.json",
      ].map((path) => readFile(join(repository.root, path))),
    );

    assert.deepEqual(after, before);
  } finally {
    await repository.cleanup();
  }
});

test("npm source failures remain unavailable without candidate invention", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectCandidate(repository.root, {
      npm: async () => {
        const error = new Error("registry unavailable");
        error.code = "ENETUNREACH";
        throw error;
      },
    });

    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["NPM_METADATA_UNAVAILABLE"],
    });
    assert.ok(
      observation.components.every(
        ({ candidate }) => candidate === null,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});
