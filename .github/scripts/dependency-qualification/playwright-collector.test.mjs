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
  canonicalDocument,
  readCapabilityCatalog,
  validateDocument,
  validateIndependentQualification,
  validateProviderSet,
} from "./contract.mjs";
import {
  collectPlaywrightCohort,
  createPlaywrightQualificationPlan,
  PLAYWRIGHT_MANAGED_PATHS,
  qualifyPlaywrightCandidate,
} from "./playwright-collector.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/playwright/",
  import.meta.url,
);
const CAPABILITY_SOURCE = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);
const REVISION = "d460a7e8ce751eb772d1b3120e5508bbecaa7bff";
const GENERATED_AT = "2026-10-21T17:00:00Z";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "playwright-collector-test-"));
  const packageRoot = join(root, "tests/e2e/playwright");
  await mkdir(packageRoot, { recursive: true });
  await cp(new URL("package.json", FIXTURE_ROOT), join(packageRoot, "package.json"));
  await cp(
    new URL("package-lock.json", FIXTURE_ROOT),
    join(packageRoot, "package-lock.json"),
  );
  await cp(CAPABILITY_SOURCE, join(root, "tests/e2e/capabilities.json"));
  return {
    root,
    async cleanup() {
      await rm(root, { force: true, recursive: true });
    },
  };
}

async function metadataProviders({
  missingBrowserVersion = null,
  npmFailure = null,
} = {}) {
  const npm = await fixture("npm-metadata.json");
  const browsers = await fixture("browser-metadata.json");
  return {
    async npmMetadata(name) {
      if (npmFailure === name) {
        throw new Error("registry unavailable");
      }
      return structuredClone(npm[name]);
    },
    async browserMetadata(version) {
      if (version === missingBrowserVersion) {
        return null;
      }
      return {
        locator:
          `https://example.invalid/playwright-core@${version}/browsers.json`,
        metadata: structuredClone(browsers[version]),
      };
    },
  };
}

async function collect(repository, providerOptions = {}) {
  const providers = await metadataProviders(providerOptions);
  return collectPlaywrightCohort({
    repositoryRoot: repository.root,
    repository: {
      name: "sbalswa/oculix",
      revision: REVISION,
    },
    generatedAt: GENERATED_AT,
    ...providers,
  });
}

async function candidateWorkspace(sourceRoot) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "playwright-candidate-workspace-"),
  );
  const root = join(temporaryRoot, "repository");
  await cp(sourceRoot, root, { recursive: true });
  await cp(
    new URL("candidate-package.json", FIXTURE_ROOT),
    join(root, "tests/e2e/playwright/package.json"),
  );
  await cp(
    new URL("candidate-package-lock.json", FIXTURE_ROOT),
    join(root, "tests/e2e/playwright/package-lock.json"),
  );
  return {
    root,
    async cleanup() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

async function contractOptions(repository) {
  const catalog = await readCapabilityCatalog(
    join(repository.root, "tests/e2e/capabilities.json"),
  );
  return {
    capabilityIds: catalog.ids,
    capabilityCatalogDigest: catalog.digest,
  };
}

function passingInspection() {
  return {
    passed: true,
    problems: [],
    warnings: [],
    digest: `sha256:${"a".repeat(64)}`,
  };
}

async function packageState(repository) {
  return Promise.all(
    PLAYWRIGHT_MANAGED_PATHS.map((path) =>
      readFile(join(repository.root, path), "utf8")),
  );
}

async function writePassingArtifacts(packageRoot) {
  for (const scenario of ["smoke", "web-calculator"]) {
    const resultRoot = join(packageRoot, "test-results", scenario);
    await mkdir(join(resultRoot, "html-report"), { recursive: true });
    await mkdir(join(resultRoot, "artifacts"), { recursive: true });
    await writeFile(join(resultRoot, "html-report/index.html"), "<html></html>\n");
    await writeFile(join(resultRoot, "playwright-report.json"), "{}\n");
    await writeFile(join(resultRoot, "artifacts/video.webm"), "video\n");
    await writeFile(
      join(resultRoot, "result.json"),
      `${JSON.stringify({
        capabilityId: "playwright-ubuntu-chromium",
        scenario,
        status: "passed",
        assertion: { status: "passed" },
        accessibility:
          scenario === "web-calculator"
            ? {
                status: "passed",
                counts: { violations: { rules: 0, nodes: 0 } },
              }
            : { status: "not-run", counts: null },
      })}\n`,
    );
  }
  const calculatorRoot = join(
    packageRoot,
    "test-results/web-calculator",
  );
  await writeFile(join(calculatorRoot, "accessibility.json"), "{}\n");
  await writeFile(
    join(calculatorRoot, "accessibility-summary.json"),
    '{"status":"passed","counts":{"violations":{"rules":0,"nodes":0}}}\n',
  );
  await writeFile(
    join(calculatorRoot, "accessibility-summary.md"),
    "# Accessibility\n\nPassed.\n",
  );
  await writeFile(join(calculatorRoot, "final.png"), "png\n");
}

test("collection is deterministic and records the complete candidate cohort", async () => {
  const repository = await createRepository();
  try {
    const first = await collect(repository);
    const second = await collect(repository);
    const options = await contractOptions(repository);

    assert.equal(canonicalDocument(first), canonicalDocument(second));
    assert.doesNotThrow(() => validateDocument(first, options));
    assert.equal(first.disposition.state, "candidate");
    assert.deepEqual(
      first.components.map(({ id }) => id),
      [
        "playwright-package-cohort",
        "playwright-chromium-bundle",
      ],
    );
    assert.deepEqual(
      first.components.flatMap(({ eventual_managed_paths }) =>
        eventual_managed_paths),
      [
        "tests/e2e/playwright/package.json",
        "tests/e2e/playwright/package-lock.json",
      ],
    );

    const packages = JSON.parse(first.components[0].candidate.version);
    assert.deepEqual(packages, {
      "@axe-core/playwright": "4.15.0",
      "@playwright/test": "1.65.0",
      playwright: "1.65.0",
      "playwright-core": "1.65.0",
    });
    assert.deepEqual(JSON.parse(first.components[1].candidate.version), {
      name: "chromium",
      revision: "1200",
    });

    const relations = new Map(
      first.relations.map((relation) => [relation.id, relation]),
    );
    assert.equal(relations.get("playwright-lockstep").hard, true);
    assert.deepEqual(
      JSON.parse(relations.get("playwright-lockstep").constraint),
      {
        "@playwright/test": "1.65.0",
        playwright: "1.65.0",
        "playwright-core": "1.65.0",
      },
    );
    assert.equal(relations.get("playwright-node-ranges").to, "node-runtime");
    assert.deepEqual(
      JSON.parse(relations.get("playwright-node-ranges").constraint),
      {
        "@axe-core/playwright": ">=22.12.0",
        "@playwright/test": ">=20",
        playwright: ">=20",
        "playwright-core": ">=20",
      },
    );
    assert.deepEqual(
      JSON.parse(relations.get("playwright-bundled-chromium").constraint),
      {
        browser: "chromium",
        package: "playwright-core@1.65.0",
        revision: "1200",
      },
    );
    assert.equal(relations.get("playwright-axe-alignment").hard, false);
    assert.equal(
      first.components[0].affected_capabilities[0],
      "playwright-ubuntu-chromium",
    );
  } finally {
    await repository.cleanup();
  }
});

test("the observation composes with the Node provider without path collisions", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const options = await contractOptions(repository);
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
          affected_capabilities: ["playwright-ubuntu-chromium"],
        },
      ],
      relations: [],
    };

    assert.doesNotThrow(() =>
      validateProviderSet([node, observation], options),
    );
  } finally {
    await repository.cleanup();
  }
});

test("missing candidate browser metadata is unknown and cannot qualify", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository, {
      missingBrowserVersion: "1.65.0",
    });
    let workspaceCreated = false;
    const validation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      async createWorkspace() {
        workspaceCreated = true;
        throw new Error("must not create a workspace");
      },
    });

    assert.equal(observation.disposition.state, "unknown");
    assert.deepEqual(observation.disposition.reason_codes, [
      "BROWSER_METADATA_MISSING",
    ]);
    assert.equal(observation.components[1].candidate, null);
    assert.equal(workspaceCreated, false);
    assert.equal(validation.disposition.state, "unknown");
    assert.equal(validation.results[0].status, "unknown");
    const options = await contractOptions(repository);
    assert.throws(
      () =>
        validateIndependentQualification(
          observation,
          validation,
          options,
        ),
      /must identify a candidate|must be independently-qualified/,
    );
  } finally {
    await repository.cleanup();
  }
});

test("unavailable npm metadata fails closed without inventing a candidate", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository, {
      npmFailure: "@playwright/test",
    });
    assert.equal(observation.disposition.state, "unavailable");
    assert.deepEqual(observation.disposition.reason_codes, [
      "NPM_METADATA_UNAVAILABLE",
    ]);
    assert.ok(
      observation.components.every((component) => component.candidate === null),
    );
  } finally {
    await repository.cleanup();
  }
});

test("qualification plan confines mutation and orders tests before scenarios", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const catalog = await readFile(
      join(repository.root, "tests/e2e/capabilities.json"),
      "utf8",
    ).then(JSON.parse);
    const plan = createPlaywrightQualificationPlan({
      observation,
      workspaceRoot: "/ephemeral/repository",
      capabilityCatalog: catalog,
    });

    assert.deepEqual(plan.managed_paths, PLAYWRIGHT_MANAGED_PATHS);
    assert.match(plan.apply.cwd, /^\/ephemeral\/repository\//u);
    assert.deepEqual(plan.capabilities, ["playwright-ubuntu-chromium"]);
    assert.equal(plan.package_tests.phase, "package-test");
    assert.deepEqual(
      plan.execution.map(({ scenario }) => scenario),
      ["smoke", "web-calculator"],
    );
    assert.ok(
      plan.execution.every(({ cwd }) =>
        cwd.startsWith("/ephemeral/repository/tests/e2e/playwright")),
    );
  } finally {
    await repository.cleanup();
  }
});

test("warning-free all-capability evidence independently qualifies", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const before = await packageState(repository);
    const phases = [];
    const validation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep(step) {
        phases.push(step.phase);
        if (step.scenario === "web-calculator") {
          await writePassingArtifacts(step.cwd);
        }
        return { exitCode: 0, warnings: [] };
      },
    });
    const after = await packageState(repository);
    const options = await contractOptions(repository);

    assert.equal(validation.disposition.state, "independently-qualified");
    assert.deepEqual(validation.results.map(({ status }) => status), ["pass"]);
    assert.deepEqual(validation.results[0].warnings, []);
    assert.doesNotThrow(() =>
      validateIndependentQualification(observation, validation, options),
    );
    assert.deepEqual(phases, [
      "apply",
      "prepare",
      "package-test",
      "capability",
      "capability",
    ]);
    assert.deepEqual(after, before);
  } finally {
    await repository.cleanup();
  }
});

test("preparation failure cannot qualify, run scenarios, or mutate source state", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const before = await packageState(repository);
    const executed = [];
    const validation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep(step) {
        executed.push(step.id);
        return {
          exitCode: step.phase === "prepare" ? 1 : 0,
          warnings: [],
        };
      },
      async inspectCapability() {
        assert.fail("artifacts must not be admitted after failed preparation");
      },
    });

    assert.equal(validation.disposition.state, "blocked");
    assert.deepEqual(validation.disposition.reason_codes, [
      "PREPARATION_FAILED",
    ]);
    assert.equal(validation.results[0].status, "fail");
    assert.ok(!executed.some((id) => id.endsWith("-smoke")));
    assert.deepEqual(await packageState(repository), before);
  } finally {
    await repository.cleanup();
  }
});

test("scenario execution failure cannot qualify or mutate source state", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const before = await packageState(repository);
    const validation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep(step) {
        return {
          exitCode: step.scenario === "web-calculator" ? 1 : 0,
          warnings: [],
        };
      },
      async inspectCapability() {
        assert.fail("failed execution cannot publish passing artifacts");
      },
    });

    assert.equal(validation.disposition.state, "blocked");
    assert.deepEqual(validation.disposition.reason_codes, [
      "EXECUTION_FAILED",
    ]);
    assert.equal(validation.results[0].status, "fail");
    assert.deepEqual(await packageState(repository), before);
  } finally {
    await repository.cleanup();
  }
});

test("warnings and incomplete artifact contracts prevent admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const warningValidation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep(step) {
        return {
          exitCode: 0,
          warnings:
            step.scenario === "smoke" ? ["browser emitted warning"] : [],
        };
      },
      async inspectCapability() {
        return passingInspection();
      },
    });
    assert.equal(warningValidation.disposition.state, "blocked");
    assert.deepEqual(warningValidation.disposition.reason_codes, [
      "VALIDATION_WARNINGS",
    ]);
    assert.equal(warningValidation.results[0].status, "pass");
    assert.deepEqual(warningValidation.results[0].warnings, [
      "browser emitted warning",
    ]);

    const artifactValidation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep() {
        return { exitCode: 0, warnings: [] };
      },
      async inspectCapability() {
        return {
          passed: false,
          problems: ["missing accessibility summary"],
          warnings: [],
          digest: `sha256:${"c".repeat(64)}`,
        };
      },
    });
    assert.equal(artifactValidation.disposition.state, "blocked");
    assert.deepEqual(artifactValidation.disposition.reason_codes, [
      "ARTIFACT_VALIDATION_FAILED",
    ]);
    assert.equal(artifactValidation.results[0].status, "fail");
  } finally {
    await repository.cleanup();
  }
});

test("source mutation is restored and reported as a qualification failure", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const before = await packageState(repository);
    const validation = await qualifyPlaywrightCandidate({
      observation,
      repositoryRoot: repository.root,
      generatedAt: GENERATED_AT,
      createWorkspace: candidateWorkspace,
      async runStep(step) {
        if (step.phase === "prepare") {
          await writeFile(
            join(repository.root, "tests/e2e/playwright/package.json"),
            "{}\n",
          );
        }
        return { exitCode: 0, warnings: [] };
      },
      async inspectCapability() {
        return passingInspection();
      },
    });

    assert.equal(validation.disposition.state, "blocked");
    assert.deepEqual(validation.disposition.reason_codes, [
      "PACKAGE_STATE_MUTATED",
    ]);
    assert.deepEqual(await packageState(repository), before);
  } finally {
    await repository.cleanup();
  }
});

test("collector tests run against the repository capability catalog", async () => {
  const catalog = await readCapabilityCatalog(CAPABILITY_SOURCE);
  assert.ok(catalog.ids.has("playwright-ubuntu-chromium"));
});
