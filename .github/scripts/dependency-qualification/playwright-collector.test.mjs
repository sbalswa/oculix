import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  runQualificationStep,
} from "./playwright-collector.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/playwright/",
  import.meta.url,
);
const CAPABILITY_SOURCE = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);
const PLAYWRIGHT_SOURCE = new URL(
  "../../../tests/e2e/playwright/",
  import.meta.url,
);
const EXECUTION_SOURCE_FILES = [
  "harness.mjs",
  "playwright.config.mjs",
  "process-runner.mjs",
  "reporting.mjs",
  "result-reporter.mjs",
  "smoke.spec.mjs",
  "web-calculator.spec.mjs",
];
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
  for (const path of EXECUTION_SOURCE_FILES) {
    await cp(new URL(path, PLAYWRIGHT_SOURCE), join(packageRoot, path));
  }
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
  return {
    root,
    async cleanup() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

function testDigest(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function testRepositoryInspection(repository, overrides = {}) {
  const trackedPaths = [
    "tests/e2e/capabilities.json",
    "tests/e2e/playwright/package-lock.json",
    "tests/e2e/playwright/package.json",
    ...EXECUTION_SOURCE_FILES.map(
      (path) => `tests/e2e/playwright/${path}`,
    ),
  ];
  return {
    root: resolve(repository.root),
    revision: REVISION,
    repositoryName: "sbalswa/oculix",
    clean: true,
    trackedFiles: new Map(
      await Promise.all(
        trackedPaths.map(async (path) => [
          path,
          testDigest(await readFile(join(repository.root, path))),
        ]),
      ),
    ),
    ...overrides,
  };
}

function qualificationOptions(repository, overrides = {}) {
  return {
    repositoryRoot: repository.root,
    generatedAt: GENERATED_AT,
    createWorkspace: candidateWorkspace,
    inspectRepository: () => testRepositoryInspection(repository),
    ...overrides,
  };
}

async function applyCandidate(step) {
  if (step.phase !== "apply") {
    return;
  }
  await cp(
    new URL("candidate-package.json", FIXTURE_ROOT),
    join(step.cwd, "package.json"),
  );
  await cp(
    new URL("candidate-package-lock.json", FIXTURE_ROOT),
    join(step.cwd, "package-lock.json"),
  );
}

async function prepareRuntime(step, { revision = "1200" } = {}) {
  if (step.phase !== "prepare") {
    return;
  }
  const browserMetadata = await fixture("browser-metadata.json");
  const metadataRoot = join(step.cwd, "node_modules/playwright-core");
  const executable = join(
    step.cwd,
    `.playwright-browsers/chromium-${revision}/chrome`,
  );
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(join(executable, ".."), { recursive: true });
  await writeFile(
    join(metadataRoot, "browsers.json"),
    `${JSON.stringify(browserMetadata["1.65.0"])}\n`,
  );
  await writeFile(executable, "browser\n");
  const lockHash = createHash("sha256")
    .update(await readFile(join(step.cwd, "package-lock.json")))
    .digest("hex");
  await writeFile(
    join(step.cwd, "node_modules/.oculix-package-lock.sha256"),
    `${lockHash}\n`,
  );
  await writeFile(
    join(
      step.cwd,
      "node_modules",
      `.oculix-playwright-${process.platform}-${process.arch}-chromium.json`,
    ),
    `${JSON.stringify({
      arch: process.arch,
      lockHash,
      operatingSystem: "ubuntu",
      platform: process.platform,
      project: "chromium",
    })}\n`,
  );
}

function runtimeResult(step, { revision = "1200" } = {}) {
  if (step.phase !== "runtime-metadata") {
    return {};
  }
  const executablePath = join(
    step.cwd,
    `.playwright-browsers/chromium-${revision}/chrome`,
  );
  return {
    stdout:
      `OCULIX_PLAYWRIGHT_RUNTIME=${JSON.stringify({
        browser: "chromium",
        executablePath,
        revision,
      })}\n`,
  };
}

async function passingStep(step, options = {}) {
  await applyCandidate(step);
  await prepareRuntime(step, options);
  return {
    exitCode: 0,
    warnings: [],
    ...runtimeResult(step, options),
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

async function qualifyWithArtifacts(repository, mutateArtifacts) {
  const observation = await collect(repository);
  return qualifyPlaywrightCandidate({
    observation,
    ...qualificationOptions(repository),
    async runStep(step) {
      const result = await passingStep(step);
      if (step.scenario === "web-calculator") {
        await writePassingArtifacts(step.cwd);
        await mutateArtifacts?.(step.cwd);
      }
      return result;
    },
  });
}

function ebmlElement(identifier, payload) {
  assert.ok(payload.length < 127);
  return Buffer.concat([
    Buffer.from(identifier, "hex"),
    Buffer.from([0x80 | payload.length]),
    payload,
  ]);
}

function validWebmFixture() {
  const header = ebmlElement(
    "1a45dfa3",
    Buffer.concat([
      ebmlElement("4286", Buffer.from([1])),
      ebmlElement("42f7", Buffer.from([1])),
      ebmlElement("42f2", Buffer.from([4])),
      ebmlElement("42f3", Buffer.from([8])),
      ebmlElement("4282", Buffer.from("webm")),
      ebmlElement("4287", Buffer.from([4])),
      ebmlElement("4285", Buffer.from([2])),
    ]),
  );
  const information = ebmlElement(
    "1549a966",
    Buffer.concat([
      ebmlElement("2ad7b1", Buffer.from([0x0f, 0x42, 0x40])),
      ebmlElement("4d80", Buffer.from("test")),
      ebmlElement("5741", Buffer.from("test")),
    ]),
  );
  const video = ebmlElement(
    "e0",
    Buffer.concat([
      ebmlElement("b0", Buffer.from([1])),
      ebmlElement("ba", Buffer.from([1])),
    ]),
  );
  const track = ebmlElement(
    "ae",
    Buffer.concat([
      ebmlElement("d7", Buffer.from([1])),
      ebmlElement("73c5", Buffer.from([1])),
      ebmlElement("83", Buffer.from([1])),
      ebmlElement("86", Buffer.from("V_VP8")),
      video,
    ]),
  );
  const tracks = ebmlElement("1654ae6b", track);
  const cluster = ebmlElement(
    "1f43b675",
    Buffer.concat([
      ebmlElement("e7", Buffer.from([0])),
      ebmlElement("a3", Buffer.from([0x81, 0, 0, 0x80, 0])),
    ]),
  );
  return Buffer.concat([
    header,
    ebmlElement(
      "18538067",
      Buffer.concat([information, tracks, cluster]),
    ),
  ]);
}

async function writePassingArtifacts(packageRoot) {
  const incompleteFinding = {
    description: "Ensure text has sufficient color contrast",
    help: "Elements must meet minimum color contrast ratio thresholds",
    helpUrl: "https://example.invalid/color-contrast",
    id: "color-contrast",
    impact: "serious",
    nodes: [
      {
        failureSummary: "Fix the foreground or background color",
        html: "<button>Calculate</button>",
        impact: "serious",
        target: ["button"],
      },
      {
        failureSummary: "Review the muted result text",
        html: "<output>0</output>",
        impact: "serious",
        target: ["output"],
      },
    ],
    tags: ["wcag2aa", "wcag143"],
  };
  const accessibilitySummary = {
    status: "passed",
    testEngine: { name: "axe-core", version: "4.15.0" },
    testEnvironment: { orientationAngle: 0 },
    testRunner: { name: "axe" },
    timestamp: "2026-10-21T17:00:02.500Z",
    url: "http://127.0.0.1/",
    policy: {
      automatedStandard: "WCAG 2.0, 2.1, and 2.2 Level A/AA",
      blocking: "any-violation",
      incomplete: "retained-nonblocking",
      tags: [
        "wcag2a",
        "wcag2aa",
        "wcag21a",
        "wcag21aa",
        "wcag22a",
        "wcag22aa",
      ],
    },
    counts: {
      incomplete: { rules: 1, nodes: 2 },
      inapplicable: { rules: 0, nodes: 0 },
      passes: { rules: 0, nodes: 0 },
      violations: { rules: 0, nodes: 0 },
    },
    incomplete: [incompleteFinding],
    violations: [],
  };
  for (const scenario of ["smoke", "web-calculator"]) {
    const resultRoot = join(packageRoot, "test-results", scenario);
    await mkdir(join(resultRoot, "html-report"), { recursive: true });
    await mkdir(join(resultRoot, "artifacts"), { recursive: true });
    await writeFile(
      join(resultRoot, "html-report/index.html"),
      "<!doctype html><html><body>passed</body></html>\n",
    );
    await writeFile(
      join(resultRoot, "playwright-report.json"),
      `${JSON.stringify({
        config: { rootDir: packageRoot },
        suites: [
          {
            title: scenario,
            file: `${scenario}.spec.mjs`,
            specs: [{ file: `${scenario}.spec.mjs` }],
          },
        ],
        errors: [],
        stats: {
          expected: 1,
          skipped: 0,
          unexpected: 0,
          flaky: 0,
        },
      })}\n`,
    );
    await writeFile(
      join(resultRoot, "artifacts/video.webm"),
      validWebmFixture(),
    );
    const scenarioRoot =
      `tests/e2e/playwright/test-results/${scenario}`;
    await writeFile(
      join(resultRoot, "result.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        capabilityId: "playwright-ubuntu-chromium",
        tool: "playwright",
        scenario,
        status: "passed",
        timestamps: {
          startedAt:
            scenario === "smoke"
              ? "2026-10-21T17:00:00.000Z"
              : "2026-10-21T17:00:02.000Z",
          completedAt:
            scenario === "smoke"
              ? "2026-10-21T17:00:01.000Z"
              : "2026-10-21T17:00:03.000Z",
          durationMs: 1000,
        },
        environment: {
          arch: "x64",
          browser: {
            name: "chromium",
            project: "chromium",
            version: "142.0.7400.0",
          },
          operatingSystem: "ubuntu",
          platform: "linux",
          versions: {
            axe: "4.15.0",
            node: "v24.22.0",
            playwright: "1.65.0",
          },
        },
        assertion: {
          errors: [],
          expectedStatus: "passed",
          status: "passed",
        },
        accessibility:
          scenario === "web-calculator"
            ? accessibilitySummary
            : { status: "not-run", counts: null },
        artifacts: {
          htmlReport: `${scenarioRoot}/html-report/index.html`,
          nativeJsonReport: `${scenarioRoot}/playwright-report.json`,
          result: `${scenarioRoot}/result.json`,
          attachments: [
            {
              contentType: "video/webm",
              name: "video",
              path: `${scenarioRoot}/artifacts/video.webm`,
            },
          ],
          ...(scenario === "web-calculator"
            ? {
                accessibility:
                  `${scenarioRoot}/accessibility.json`,
                accessibilitySummary:
                  `${scenarioRoot}/accessibility-summary.json`,
                accessibilitySummaryMarkdown:
                  `${scenarioRoot}/accessibility-summary.md`,
                finalScreenshot: `${scenarioRoot}/final.png`,
              }
            : {}),
        },
      })}\n`,
    );
  }
  const calculatorRoot = join(
    packageRoot,
    "test-results/web-calculator",
  );
  await writeFile(
    join(calculatorRoot, "accessibility.json"),
    `${JSON.stringify({
      incomplete: [incompleteFinding],
      inapplicable: [],
      passes: [],
      testEngine: { name: "axe-core", version: "4.15.0" },
      testEnvironment: { orientationAngle: 0 },
      testRunner: { name: "axe" },
      timestamp: "2026-10-21T17:00:02.500Z",
      url: "http://127.0.0.1/",
      violations: [],
    })}\n`,
  );
  await writeFile(
    join(calculatorRoot, "accessibility-summary.json"),
    `${JSON.stringify(accessibilitySummary)}\n`,
  );
  await writeFile(
    join(calculatorRoot, "accessibility-summary.md"),
    "# Playwright accessibility audit\n\n" +
      "- Status: **passed**\n" +
      "- Policy: WCAG 2.0, 2.1, and 2.2 Level A/AA\n" +
      "- Violations: 0 rule(s) / 0 affected node(s) (blocking)\n" +
      "- Incomplete/manual review: 1 rule(s) / 2 affected node(s) " +
        "(nonblocking)\n" +
      "- Passes: 0 rule(s) / 0 affected node(s)\n" +
      "- Inapplicable: 0 rule(s) / 0 affected node(s)\n\n" +
      "## Violations\n\nNone.\n\n" +
      "## Incomplete findings requiring manual review\n\n" +
      "- `color-contrast` (serious): Elements must meet minimum color " +
        "contrast ratio thresholds — 2 node(s)\n\n" +
      "Automated auditing supplements rather than replaces manual " +
        "accessibility review.\n",
  );
  await writeFile(
    join(calculatorRoot, "final.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC" +
        "AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
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

    const packageManifest = JSON.parse(
      first.components[0].candidate.version,
    );
    assert.deepEqual(packageManifest.packages, {
      "@axe-core/playwright": "4.15.0",
      "@playwright/test": "1.65.0",
      playwright: "1.65.0",
      "playwright-core": "1.65.0",
    });
    assert.deepEqual(packageManifest.integrities, {
      "@axe-core/playwright": "sha512-Y2FuZGlkYXRlLWF4ZQ==",
      "@playwright/test": "sha512-Y2FuZGlkYXRlLXRlc3Q=",
      playwright: "sha512-Y2FuZGlkYXRlLXBsYXl3cmlnaHQ=",
      "playwright-core": "sha512-Y2FuZGlkYXRlLWNvcmU=",
    });
    assert.equal(
      packageManifest.tarballs["playwright-core"],
      "https://registry.npmjs.org/playwright-core/-/playwright-core-1.65.0.tgz",
    );
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
    const before = await packageState(repository);
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
    assert.deepEqual(await packageState(repository), before);
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
    assert.equal(plan.preparation.length, 1);
    assert.ok(
      plan.preparation.every(
        (step) =>
          step.command === process.execPath &&
          step.arguments[0].endsWith("/harness.mjs") &&
          step.arguments[1] === "prepare" &&
          step.arguments[2] === "chromium" &&
          step.cwd.startsWith(
            "/ephemeral/repository/tests/e2e/playwright",
          ) &&
          step.environment.PLAYWRIGHT_BROWSERS_PATH.startsWith(
            "/ephemeral/repository/tests/e2e/playwright",
          ) &&
          step.environment.npm_config_cache.startsWith(
            "/ephemeral/repository/tests/e2e/playwright",
          ) &&
          !step.arguments.includes("--with-deps"),
      ),
    );
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
      ...qualificationOptions(repository),
      async runStep(step) {
        phases.push(step.phase);
        if (step.scenario === "web-calculator") {
          await writePassingArtifacts(step.cwd);
        }
        return passingStep(step);
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
      "runtime-metadata",
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
      ...qualificationOptions(repository),
      async runStep(step) {
        executed.push(step.id);
        if (step.phase === "prepare") {
          return { exitCode: 1, warnings: [] };
        }
        return passingStep(step);
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

test("successful prepare command without real harness stamps cannot qualify", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const executed = [];
    const validation = await qualifyPlaywrightCandidate({
      observation,
      ...qualificationOptions(repository),
      async runStep(step) {
        executed.push(step.phase);
        await applyCandidate(step);
        return {
          exitCode: 0,
          warnings: [],
          ...runtimeResult(step),
        };
      },
      async inspectCapability() {
        assert.fail("unstamped preparation cannot reach artifact admission");
      },
    });

    assert.deepEqual(validation.disposition.reason_codes, [
      "PREPARATION_FAILED",
    ]);
    assert.ok(!executed.includes("capability"));
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
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        return {
          ...result,
          exitCode: step.scenario === "web-calculator" ? 1 : 0,
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
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        return {
          ...result,
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
      ...qualificationOptions(repository),
      async runStep(step) {
        return passingStep(step);
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
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        if (step.phase === "prepare") {
          await writeFile(
            join(repository.root, "tests/e2e/playwright/package.json"),
            "{}\n",
          );
        }
        return result;
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

test("source restoration unlinks replacement symlinks without touching targets", async () => {
  const repository = await createRepository();
  const externalRoot = await mkdtemp(
    join(tmpdir(), "playwright-restore-target-"),
  );
  try {
    const observation = await collect(repository);
    const before = await packageState(repository);
    const externalTarget = join(externalRoot, "package.json");
    const sourcePackage = join(
      repository.root,
      "tests/e2e/playwright/package.json",
    );
    await writeFile(externalTarget, "external target must remain unchanged\n");
    const validation = await qualifyPlaywrightCandidate({
      observation,
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        if (step.phase === "prepare") {
          await rm(sourcePackage);
          await symlink(externalTarget, sourcePackage);
        }
        return result;
      },
      async inspectCapability() {
        return passingInspection();
      },
    });

    assert.ok(
      validation.disposition.reason_codes.includes("PACKAGE_STATE_MUTATED"),
    );
    assert.deepEqual(await packageState(repository), before);
    assert.equal(
      await readFile(externalTarget, "utf8"),
      "external target must remain unchanged\n",
    );
  } finally {
    await repository.cleanup();
    await rm(externalRoot, { force: true, recursive: true });
  }
});

test("candidate lock and execution files remain bound through final state", async (t) => {
  const cases = [
    {
      name: "lock changed after preparation",
      phase: "prepare",
      path: "package-lock.json",
    },
    {
      name: "harness changed after package tests",
      phase: "package-test",
      path: "harness.mjs",
    },
    {
      name: "reporter changed after final scenario",
      phase: "capability",
      scenario: "web-calculator",
      path: "result-reporter.mjs",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const repository = await createRepository();
      try {
        const observation = await collect(repository);
        const validation = await qualifyPlaywrightCandidate({
          observation,
          ...qualificationOptions(repository),
          async runStep(step) {
            const result = await passingStep(step);
            if (
              step.phase === testCase.phase &&
              (testCase.scenario === undefined ||
                step.scenario === testCase.scenario)
            ) {
              await writeFile(
                join(step.cwd, testCase.path),
                "post-command tampering\n",
              );
            }
            return result;
          },
          async inspectCapability() {
            return passingInspection();
          },
        });
        assert.ok(
          validation.disposition.reason_codes.includes(
            "CANDIDATE_EVIDENCE_MUTATED",
          ),
        );
      } finally {
        await repository.cleanup();
      }
    });
  }

  await t.test("lock changed after artifact verification", async () => {
    const repository = await createRepository();
    try {
      const observation = await collect(repository);
      const validation = await qualifyPlaywrightCandidate({
        observation,
        ...qualificationOptions(repository),
        async runStep(step) {
          return passingStep(step);
        },
        async inspectCapability({ workspaceRoot }) {
          await writeFile(
            join(workspaceRoot, "tests/e2e/playwright/package-lock.json"),
            "post-verification tampering\n",
          );
          return passingInspection();
        },
      });
      assert.ok(
        validation.disposition.reason_codes.includes(
          "CANDIDATE_EVIDENCE_MUTATED",
        ),
      );
    } finally {
      await repository.cleanup();
    }
  });
});

test("artifact admission rejects semantically invalid evidence", async (t) => {
  const cases = [
    [
      "fake PNG",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/web-calculator/final.png"),
          "not a png\n",
        );
      },
    ],
    [
      "PNG with corrupt chunk CRC",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/final.png",
        );
        const png = await readFile(path);
        png[png.length - 1] ^= 0xff;
        await writeFile(path, png);
      },
    ],
    [
      "empty video",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/smoke/artifacts/video.webm"),
          "",
        );
      },
    ],
    [
      "nonempty non-WebM video",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/smoke/artifacts/video.webm"),
          "not actually webm\n",
        );
      },
    ],
    [
      "truncated WebM declared payload",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/smoke/artifacts/video.webm",
        );
        const contents = await readFile(path);
        await writeFile(path, contents.subarray(0, contents.length - 1));
      },
    ],
    [
      "invalid HTML",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/smoke/html-report/index.html"),
          "not html\n",
        );
      },
    ],
    [
      "invalid native report",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/smoke/playwright-report.json"),
          '{"stats":{"unexpected":0}}\n',
        );
      },
    ],
    [
      "invalid result structure",
      async (packageRoot) => {
        await writeFile(
          join(packageRoot, "test-results/smoke/result.json"),
          '{"status":"passed"}\n',
        );
      },
    ],
    [
      "swapped scenario reports",
      async (packageRoot) => {
        const smokePath = join(
          packageRoot,
          "test-results/smoke/result.json",
        );
        const calculatorPath = join(
          packageRoot,
          "test-results/web-calculator/result.json",
        );
        const [smoke, calculator] = await Promise.all([
          readFile(smokePath),
          readFile(calculatorPath),
        ]);
        await writeFile(smokePath, calculator);
        await writeFile(calculatorPath, smoke);
      },
    ],
    [
      "swapped native scenario reports",
      async (packageRoot) => {
        const smokePath = join(
          packageRoot,
          "test-results/smoke/playwright-report.json",
        );
        const calculatorPath = join(
          packageRoot,
          "test-results/web-calculator/playwright-report.json",
        );
        const [smoke, calculator] = await Promise.all([
          readFile(smokePath),
          readFile(calculatorPath),
        ]);
        await writeFile(smokePath, calculator);
        await writeFile(calculatorPath, smoke);
      },
    ],
    [
      "combined native scenario report",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/smoke/playwright-report.json",
        );
        const report = JSON.parse(await readFile(path, "utf8"));
        report.suites.push({
          file: "web-calculator.spec.mjs",
          specs: [{ file: "web-calculator.spec.mjs" }],
        });
        await writeFile(path, `${JSON.stringify(report)}\n`);
      },
    ],
    [
      "unrelated extra native report",
      async (packageRoot) => {
        const root = join(packageRoot, "test-results/unrelated");
        await mkdir(root, { recursive: true });
        await writeFile(
          join(root, "playwright-report.json"),
          '{"config":{},"suites":[],"errors":[],"stats":{}}\n',
        );
      },
    ],
    [
      "nonmonotonic timestamps",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/smoke/result.json",
        );
        const report = JSON.parse(await readFile(path, "utf8"));
        report.timestamps.completedAt = "2026-10-21T16:59:59.000Z";
        await writeFile(path, `${JSON.stringify(report)}\n`);
      },
    ],
    [
      "nonmonotonic scenario sequence",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/result.json",
        );
        const report = JSON.parse(await readFile(path, "utf8"));
        report.timestamps.startedAt = "2026-10-21T17:00:00.500Z";
        report.timestamps.completedAt = "2026-10-21T17:00:01.500Z";
        await writeFile(path, `${JSON.stringify(report)}\n`);
      },
    ],
    [
      "accessibility violation",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/accessibility.json",
        );
        const report = JSON.parse(await readFile(path, "utf8"));
        report.violations.push({ id: "blocking", nodes: [{}] });
        await writeFile(path, `${JSON.stringify(report)}\n`);
      },
    ],
    [
      "contradictory accessibility counts",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/accessibility-summary.json",
        );
        const summary = JSON.parse(await readFile(path, "utf8"));
        summary.counts.passes.rules = 1;
        await writeFile(path, `${JSON.stringify(summary)}\n`);
      },
    ],
    [
      "result contradicts accessibility summary",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/result.json",
        );
        const report = JSON.parse(await readFile(path, "utf8"));
        report.accessibility.status = "failed";
        await writeFile(path, `${JSON.stringify(report)}\n`);
      },
    ],
    [
      "incomplete finding details contradict raw audit",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/accessibility-summary.json",
        );
        const summary = JSON.parse(await readFile(path, "utf8"));
        summary.incomplete[0].help = "different finding";
        await writeFile(path, `${JSON.stringify(summary)}\n`);
      },
    ],
    [
      "Markdown incomplete counts contradict summary",
      async (packageRoot) => {
        const path = join(
          packageRoot,
          "test-results/web-calculator/accessibility-summary.md",
        );
        const markdown = await readFile(path, "utf8");
        await writeFile(
          path,
          markdown.replace(
            "1 rule(s) / 2 affected node(s)",
            "0 rule(s) / 0 affected node(s)",
          ),
        );
      },
    ],
    [
      "accessibility audit timestamp outside scenario",
      async (packageRoot) => {
        const rawPath = join(
          packageRoot,
          "test-results/web-calculator/accessibility.json",
        );
        const summaryPath = join(
          packageRoot,
          "test-results/web-calculator/accessibility-summary.json",
        );
        const resultPath = join(
          packageRoot,
          "test-results/web-calculator/result.json",
        );
        const raw = JSON.parse(await readFile(rawPath, "utf8"));
        const summary = JSON.parse(await readFile(summaryPath, "utf8"));
        const result = JSON.parse(await readFile(resultPath, "utf8"));
        raw.timestamp = "2026-10-21T17:00:01.999Z";
        summary.timestamp = raw.timestamp;
        result.accessibility.timestamp = raw.timestamp;
        await writeFile(rawPath, `${JSON.stringify(raw)}\n`);
        await writeFile(summaryPath, `${JSON.stringify(summary)}\n`);
        await writeFile(resultPath, `${JSON.stringify(result)}\n`);
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const repository = await createRepository();
      try {
        const validation = await qualifyWithArtifacts(repository, mutate);
        assert.equal(validation.disposition.state, "blocked");
        assert.ok(
          validation.disposition.reason_codes.includes(
            "ARTIFACT_VALIDATION_FAILED",
          ),
        );
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("tested locks must match observed integrities and tarballs", async (t) => {
  for (const field of ["integrity", "resolved"]) {
    await t.test(field, async () => {
      const repository = await createRepository();
      try {
        const observation = await collect(repository);
        const validation = await qualifyPlaywrightCandidate({
          observation,
          ...qualificationOptions(repository),
          async runStep(step) {
            const result = await passingStep(step);
            if (step.phase === "apply") {
              const path = join(step.cwd, "package-lock.json");
              const lockfile = JSON.parse(await readFile(path, "utf8"));
              lockfile.packages["node_modules/playwright-core"][field] =
                field === "integrity"
                  ? "sha512-dGFtcGVyZWQ="
                  : "https://example.invalid/tampered.tgz";
              await writeFile(path, `${JSON.stringify(lockfile)}\n`);
            }
            return result;
          },
          async inspectCapability() {
            return passingInspection();
          },
        });
        assert.deepEqual(validation.disposition.reason_codes, [
          "APPLICATION_FAILED",
        ]);
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("actual runtime browser revision must match candidate evidence", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const validation = await qualifyPlaywrightCandidate({
      observation,
      ...qualificationOptions(repository),
      async runStep(step) {
        return passingStep(step, { revision: "9999" });
      },
      async inspectCapability() {
        return passingInspection();
      },
    });

    assert.equal(validation.disposition.state, "blocked");
    assert.deepEqual(validation.disposition.reason_codes, [
      "RUNTIME_BROWSER_MISMATCH",
    ]);
  } finally {
    await repository.cleanup();
  }
});

test("qualification rejects dirty, wrong-revision, and unrelated sources", async (t) => {
  const cases = [
    ["dirty", { clean: false }, "SOURCE_DIRTY"],
    [
      "wrong revision",
      { revision: "f".repeat(40) },
      "SOURCE_REVISION_MISMATCH",
    ],
    [
      "unrelated repository",
      { repositoryName: "someone/else" },
      "SOURCE_REPOSITORY_MISMATCH",
    ],
    [
      "wrong root",
      { root: "/unrelated/repository" },
      "SOURCE_ROOT_MISMATCH",
    ],
  ];

  for (const [name, overrides, reason] of cases) {
    await t.test(name, async () => {
      const repository = await createRepository();
      try {
        const observation = await collect(repository);
        let workspaceCreated = false;
        const validation = await qualifyPlaywrightCandidate({
          observation,
          ...qualificationOptions(repository),
          async inspectRepository() {
            return testRepositoryInspection(repository, overrides);
          },
          async createWorkspace() {
            workspaceCreated = true;
            throw new Error("source rejection must precede workspace creation");
          },
        });
        assert.equal(workspaceCreated, false);
        assert.deepEqual(validation.disposition.reason_codes, [reason]);
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("ephemeral workspace must contain exactly the source revision", async (t) => {
  for (const mutation of ["changed tracked file", "extra ignored file"]) {
    await t.test(mutation, async () => {
      const repository = await createRepository();
      try {
        const observation = await collect(repository);
        const validation = await qualifyPlaywrightCandidate({
          observation,
          ...qualificationOptions(repository),
          async createWorkspace(sourceRoot) {
            const workspace = await candidateWorkspace(sourceRoot);
            await writeFile(
              mutation === "changed tracked file"
                ? join(workspace.root, "tests/e2e/capabilities.json")
                : join(workspace.root, "ignored-extra.txt"),
              "{}\n",
            );
            return workspace;
          },
        });
        assert.deepEqual(validation.disposition.reason_codes, [
          "WORKSPACE_REVISION_MISMATCH",
        ]);
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("plural, mixed-case, and structured warnings block admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const validation = await qualifyPlaywrightCandidate({
      observation,
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        if (step.scenario !== "smoke") {
          return result;
        }
        return {
          ...result,
          stdout: "WaRnInGs: plural warning form\n",
          structuredWarnings: [
            { message: "structured warning object" },
          ],
          annotations: [
            { level: "WARNING", message: "annotation warning" },
          ],
        };
      },
      async inspectCapability() {
        return passingInspection();
      },
    });

    assert.equal(validation.disposition.state, "blocked");
    assert.deepEqual(validation.disposition.reason_codes, [
      "VALIDATION_WARNINGS",
    ]);
    assert.ok(
      validation.results[0].warnings.some((warning) =>
        warning.includes("WaRnInGs")),
    );
    assert.ok(
      validation.results[0].warnings.includes("structured warning object"),
    );
    assert.ok(
      validation.results[0].warnings.includes("annotation warning"),
    );
  } finally {
    await repository.cleanup();
  }
});

test("writes outside the ephemeral Playwright package boundary fail", async () => {
  const repository = await createRepository();
  try {
    const observation = await collect(repository);
    const validation = await qualifyPlaywrightCandidate({
      observation,
      ...qualificationOptions(repository),
      async runStep(step) {
        const result = await passingStep(step);
        if (step.phase === "apply") {
          await writeFile(
            resolve(step.cwd, "../../..", "outside-package.txt"),
            "unexpected write\n",
          );
        }
        return result;
      },
    });
    assert.deepEqual(validation.disposition.reason_codes, [
      "WORKSPACE_BOUNDARY_VIOLATION",
    ]);
  } finally {
    await repository.cleanup();
  }
});

test("symlinks cannot escape repository, workspace, or package confinement", async (t) => {
  await t.test("collector package path", async () => {
    const repository = await createRepository();
    const externalRoot = await mkdtemp(join(tmpdir(), "playwright-external-"));
    try {
      const packagePath = join(
        repository.root,
        "tests/e2e/playwright/package.json",
      );
      const externalPackage = join(externalRoot, "package.json");
      await cp(packagePath, externalPackage);
      await rm(packagePath);
      await symlink(externalPackage, packagePath);
      await assert.rejects(
        collect(repository),
        /Resolved path escapes confinement/,
      );
    } finally {
      await repository.cleanup();
      await rm(externalRoot, { force: true, recursive: true });
    }
  });

  await t.test("qualification artifact", async () => {
    const repository = await createRepository();
    const externalRoot = await mkdtemp(join(tmpdir(), "playwright-external-"));
    try {
      const observation = await collect(repository);
      const externalPng = join(externalRoot, "outside.png");
      await writeFile(
        externalPng,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC" +
            "AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const validation = await qualifyPlaywrightCandidate({
        observation,
        ...qualificationOptions(repository),
        async runStep(step) {
          const result = await passingStep(step);
          if (step.scenario === "web-calculator") {
            await writePassingArtifacts(step.cwd);
            const finalPng = join(
              step.cwd,
              "test-results/web-calculator/final.png",
            );
            await rm(finalPng);
            await symlink(externalPng, finalPng);
          }
          return result;
        },
      });
      assert.ok(
        validation.disposition.reason_codes.includes(
          "WORKSPACE_BOUNDARY_VIOLATION",
        ),
      );
    } finally {
      await repository.cleanup();
      await rm(externalRoot, { force: true, recursive: true });
    }
  });
});

test("candidate processes receive only a sanitized environment", async () => {
  const packageRoot = await mkdtemp(
    join(tmpdir(), "playwright-sanitized-environment-"),
  );
  const previousSecret = process.env.OCULIX_TEST_SECRET;
  process.env.OCULIX_TEST_SECRET = "must-not-leak";
  try {
    const result = await runQualificationStep({
      command: process.execPath,
      arguments: [
        "--input-type=module",
        "--eval",
        "process.stdout.write(JSON.stringify(process.env))",
      ],
      cwd: packageRoot,
      environment: {},
    });
    const environment = JSON.parse(result.stdout);
    assert.equal(environment.OCULIX_TEST_SECRET, undefined);
    assert.equal(environment.HOME, undefined);
    for (const key of ["TEMP", "TMP", "TMPDIR"]) {
      assert.ok(environment[key].startsWith(packageRoot));
    }
    await assert.rejects(
      runQualificationStep({
        command: process.execPath,
        arguments: ["--version"],
        cwd: packageRoot,
        environment: {
          GITHUB_TOKEN: "must-not-be-accepted",
        },
      }),
      /unsafe environment keys: GITHUB_TOKEN/,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.OCULIX_TEST_SECRET;
    } else {
      process.env.OCULIX_TEST_SECRET = previousSecret;
    }
    await rm(packageRoot, { force: true, recursive: true });
  }
});

test("candidate versions and Node or peer ranges require strict semver", async (t) => {
  const cases = [
    [
      "version",
      (metadata) => {
        const packument = metadata["@playwright/test"];
        const record = packument.versions["1.65.0"];
        delete packument.versions["1.65.0"];
        packument["dist-tags"].latest = "01.65.0";
        record.version = "01.65.0";
        packument.versions["01.65.0"] = record;
      },
      "SEMVER_METADATA_INVALID",
    ],
    [
      "leading-zero prerelease",
      (metadata) => {
        const packument = metadata["@playwright/test"];
        const record = packument.versions["1.65.0"];
        delete packument.versions["1.65.0"];
        packument["dist-tags"].latest = "1.65.0-alpha.01";
        record.version = "1.65.0-alpha.01";
        packument.versions["1.65.0-alpha.01"] = record;
      },
      "SEMVER_METADATA_INVALID",
    ],
    [
      "Node range",
      (metadata) => {
        metadata.playwright.versions["1.65.0"].engines.node =
          "definitely not semver";
      },
      "SEMVER_RANGE_INVALID",
    ],
    [
      "peer range",
      (metadata) => {
        metadata["@axe-core/playwright"].versions["4.15.0"]
          .peerDependencies["playwright-core"] = ">=1.0.0; rm -rf";
      },
      "SEMVER_RANGE_INVALID",
    ],
    ...[
      ">=1.0.0 - <2.0.0",
      "1.0.0 -",
      ">=1.0.0 ||",
      ">=1.0.0 <",
      "1.0.0 - 2.0.0 - 3.0.0",
      "=>1.0.0",
      "1.x.3",
      "^1.0.0 <2.0.0",
      "1.0.0 >=1.0.0",
      ">=1.0.0-alpha.01",
    ].map((range) => [
      `malformed range ${range}`,
      (metadata) => {
        metadata.playwright.versions["1.65.0"].engines.node = range;
      },
      "SEMVER_RANGE_INVALID",
    ]),
  ];

  for (const [name, mutate, reason] of cases) {
    await t.test(name, async () => {
      const repository = await createRepository();
      try {
        const npm = await fixture("npm-metadata.json");
        const browsers = await fixture("browser-metadata.json");
        mutate(npm);
        const observation = await collectPlaywrightCohort({
          repositoryRoot: repository.root,
          repository: {
            name: "sbalswa/oculix",
            revision: REVISION,
          },
          generatedAt: GENERATED_AT,
          async npmMetadata(packageName) {
            return structuredClone(npm[packageName]);
          },
          async browserMetadata(version) {
            return structuredClone(browsers[version]);
          },
        });
        assert.equal(observation.disposition.state, "unknown");
        assert.deepEqual(observation.disposition.reason_codes, [reason]);
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("invalid current versions and ranges fail collection closed", async (t) => {
  for (const field of ["version", "range"]) {
    await t.test(field, async () => {
      const repository = await createRepository();
      try {
        if (field === "version") {
          const path = join(repository.root, "tests/e2e/playwright/package.json");
          const packageJson = JSON.parse(await readFile(path, "utf8"));
          packageJson.devDependencies["@playwright/test"] = "1.64";
          await writeFile(path, `${JSON.stringify(packageJson)}\n`);
        } else {
          const path = join(
            repository.root,
            "tests/e2e/playwright/package-lock.json",
          );
          const lockfile = JSON.parse(await readFile(path, "utf8"));
          lockfile.packages["node_modules/playwright"].engines.node =
            "1.x.3";
          await writeFile(path, `${JSON.stringify(lockfile)}\n`);
        }
        await assert.rejects(
          collect(repository),
          /semantic version|semantic-version range/,
        );
      } finally {
        await repository.cleanup();
      }
    });
  }
});

test("collector tests run against the repository capability catalog", async () => {
  const catalog = await readCapabilityCatalog(CAPABILITY_SOURCE);
  assert.ok(catalog.ids.has("playwright-ubuntu-chromium"));
});
