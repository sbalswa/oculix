import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectCypressCohort,
  createCypressQualificationPlan,
  detectCypressWarnings,
  qualifyCypressCandidate as qualifyCypressCandidateRaw,
} from "./cypress-collector.mjs";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "../../..");
const FIXTURE_PATH = resolve(
  REPOSITORY_ROOT,
  "tests/dependency-qualification/fixtures/cypress/evidence.valid.json",
);
const FIXTURE_DIRECTORY = dirname(FIXTURE_PATH);
const PACKAGE_PATH = "tests/e2e/cypress/package.json";
const LOCK_PATH = "tests/e2e/cypress/package-lock.json";
const REVISION = "a".repeat(40);
const GENERATED_AT = "2026-10-21T17:00:00Z";

async function fixture() {
  const evidence = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  for (const binary of Object.values(evidence.binary)) {
    binary.locator = resolve(FIXTURE_DIRECTORY, binary.locator);
    binary.realpath = await realpath(binary.locator);
    binary.digest =
      `sha256:${createHash("sha256")
        .update(await readFile(binary.realpath))
        .digest("hex")}`;
  }
  for (const browser of Object.values(evidence.browser)) {
    browser.path = resolve(FIXTURE_DIRECTORY, browser.path);
    browser.realpath = await realpath(browser.path);
    browser.digest =
      `sha256:${createHash("sha256")
        .update(await readFile(browser.realpath))
        .digest("hex")}`;
  }
  return evidence;
}

async function cleanSourceCheckout() {
  return { clean: true, revision: REVISION };
}

function qualifyCypressCandidate(collection, options = {}) {
  return qualifyCypressCandidateRaw(collection, {
    inspectSourceCheckout: cleanSourceCheckout,
    ...options,
  });
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function rebindPlanDigest(plan) {
  const { plan_digest: ignored, ...prescription } = plan;
  plan.plan_digest =
    `sha256:${createHash("sha256")
      .update(JSON.stringify(stableValue(prescription)))
      .digest("hex")}`;
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
  assert.equal(plan.cypress_binary.locator, plan.cypress_binary.realpath);
  assert.match(
    plan.cypress_binary.realpath,
    /fixtures\/cypress\/binaries\/cypress-16\.3\.0\.archive$/u,
  );
  assert.equal(
    plan.cypress_binary.evidence.type,
    "cypress-binary",
  );
  const binaryCheck = plan.checks.find(
    ({ id }) => id === "cypress-installed-binary",
  );
  assert.equal(binaryCheck.expected_package_version, "16.3.0");
  assert.equal(binaryCheck.expected_binary_version, "16.3.0");
  assert.equal(
    plan.checks.find(({ id }) => id === "cypress-candidate-install")
      .environment.CYPRESS_INSTALL_BINARY,
    plan.cypress_binary.realpath,
  );
  assert.equal(
    plan.selected_capabilities[0].browser_evidence.path,
    plan.selected_capabilities[0].browser_evidence.realpath,
  );
  assert.match(plan.plan_digest, /^sha256:[0-9a-f]{64}$/u);
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
    ({ covers }) =>
      covers.length === 1 &&
      ["smoke", "web-calculator"].includes(covers[0]),
  )) {
    assert.deepEqual(check.arguments.slice(-2), ["--browser", "chrome"]);
    assert.equal(check.environment.E2E_BROWSER, "chrome");
    assert.equal(
      check.environment.CHROME_BIN,
      plan.selected_capabilities[0].browser_evidence.realpath,
    );
    assert.equal(
      check.environment.CYPRESS_INSTALL_BINARY,
      plan.cypress_binary.realpath,
    );
    assert.ok(!check.arguments.includes("electron"));
  }
});

test("strictly binds the entire prescribed qualification plan", async () => {
  const mutations = [
    (plan) => {
      plan.checks.find(
        ({ id }) => id === "cypress-package-tests",
      ).arguments.push("--forged");
    },
    (plan) => {
      plan.checks.pop();
    },
    (plan) => {
      plan.packages.find(
        ({ name }) => name === "cypress",
      ).integrity = "sha512-forged";
    },
    (plan) => {
      plan.selected_capabilities[0].browser_evidence.version =
        "999.0.0.0";
    },
    (plan) => {
      plan.workspace.mutation_boundary = "tests/e2e";
    },
    (plan) => {
      plan.cypress_binary.digest = `sha256:${"f".repeat(64)}`;
    },
    (plan) => {
      plan.cypress_binary.realpath = "/tmp/forged-cypress";
    },
    (plan) => {
      plan.selected_capabilities[0].browser_evidence.realpath =
        "/tmp/forged-chrome";
    },
    (plan) => {
      plan.selected_capabilities[0]
        .accessibility_policy.blockingViolationCount = 99;
    },
    (plan) => {
      plan.node.locked = "26.0.0";
    },
  ];
  for (const mutate of mutations) {
    const collection = await collect();
    mutate(collection.qualification_plan);
    rebindPlanDigest(collection.qualification_plan);
    assert.doesNotThrow(() =>
      createCypressQualificationPlan(collection),
    );
    await assert.rejects(
      qualifyCypressCandidate(collection, {
        materializeWorkspace: materializeQualificationInputs,
        repositoryRoot: REPOSITORY_ROOT,
      }),
    );
  }

  const digestMutation = await collect();
  digestMutation.qualification_plan.plan_digest =
    `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => createCypressQualificationPlan(digestMutation),
    /plan digest does not match/u,
  );
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

test("enforces Node ranges and strict prerelease SemVer ordering", async () => {
  const incompatibleNode = await fixture();
  incompatibleNode.npm.cypress.engines.node = ">=26.0.0";
  const nodeResult = await collect({ evidence: incompatibleNode });
  assert.equal(nodeResult.observation.disposition.state, "unavailable");
  assert.ok(
    nodeResult.observation.disposition.reason_codes.includes(
      "NODE_RANGE_INCOMPATIBLE",
    ),
  );
  assert.equal(nodeResult.qualification_plan, null);

  const invalidAlternative = await fixture();
  invalidAlternative.npm.cypress.engines.node =
    ">=24.0.0 || >=26.0.0 definitely-invalid";
  const invalidAlternativeResult = await collect({
    evidence: invalidAlternative,
  });
  assert.ok(
    invalidAlternativeResult.observation.disposition.reason_codes.includes(
      "CYPRESS_NPM_EVIDENCE_UNAVAILABLE",
    ),
  );
  assert.equal(invalidAlternativeResult.qualification_plan, null);

  const invalid = await fixture();
  invalid.npm.cypress.version = "16.3.0-beta.01";
  const invalidResult = await collect({ evidence: invalid });
  assert.ok(
    invalidResult.observation.disposition.reason_codes.includes(
      "CYPRESS_NPM_EVIDENCE_UNAVAILABLE",
    ),
  );

  const directory = await mkdtemp(join(tmpdir(), "cypress-semver-"));
  try {
    await copyCollectorInputs(REPOSITORY_ROOT, directory);
    const packagePath = join(directory, PACKAGE_PATH);
    const lockPath = join(directory, LOCK_PATH);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    packageJson.dependencies.cypress = "16.3.0-beta.10";
    lock.packages[""].dependencies.cypress = "16.3.0-beta.10";
    Object.assign(lock.packages["node_modules/cypress"], {
      version: "16.3.0-beta.10",
      resolved:
        "https://registry.npmjs.org/cypress/-/cypress-16.3.0-beta.10.tgz",
      integrity: "sha512-current-prerelease",
    });
    await writeFile(
      packagePath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const evidence = await fixture();
    evidence.npm.cypress.version = "16.3.0-beta.2";
    evidence.npm.cypress.dist.tarball =
      "https://registry.npmjs.org/cypress/-/cypress-16.3.0-beta.2.tgz";
    evidence.binary.current.version = "16.3.0-beta.10";
    const result = await collect({
      evidence,
      repositoryRoot: directory,
    });
    assert.ok(
      result.observation.disposition.reason_codes.includes(
        "CYPRESS_NPM_METADATA_REGRESSION",
      ),
    );
    assert.equal(result.qualification_plan, null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }

  const largeDirectory = await mkdtemp(
    join(tmpdir(), "cypress-large-semver-"),
  );
  try {
    await copyCollectorInputs(REPOSITORY_ROOT, largeDirectory);
    const packagePath = join(largeDirectory, PACKAGE_PATH);
    const lockPath = join(largeDirectory, LOCK_PATH);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const currentVersion = "16.3.0-beta.9007199254740993";
    const candidateVersion = "16.3.0-beta.9007199254740992";
    packageJson.dependencies.cypress = currentVersion;
    lock.packages[""].dependencies.cypress = currentVersion;
    Object.assign(lock.packages["node_modules/cypress"], {
      version: currentVersion,
      resolved:
        `https://registry.npmjs.org/cypress/-/cypress-${currentVersion}.tgz`,
      integrity: "sha512-current-large-prerelease",
    });
    await writeFile(
      packagePath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const evidence = await fixture();
    evidence.npm.cypress.version = candidateVersion;
    evidence.npm.cypress.dist.tarball =
      `https://registry.npmjs.org/cypress/-/cypress-${candidateVersion}.tgz`;
    evidence.binary.current.version = currentVersion;
    const result = await collect({
      evidence,
      repositoryRoot: largeDirectory,
    });
    assert.ok(
      result.observation.disposition.reason_codes.includes(
        "CYPRESS_NPM_METADATA_REGRESSION",
      ),
    );
    assert.equal(result.qualification_plan, null);
  } finally {
    await rm(largeDirectory, { force: true, recursive: true });
  }
});

test("detects compound, plural, case-insensitive, and structured warnings", () => {
  const warnings = detectCypressWarnings([
    "npm WARN deprecated package",
    "DeprecationWarning: legacy API",
    "ExperimentalWarning: unstable feature",
    "MULTIPLE WARNINGS were emitted",
    '{"severity":"WARNING","message":"structured warning"}',
    '{"Diagnostics":[{"type":"ExperimentalWarning","message":"nested"}]}',
  ].join("\n"));
  assert.ok(warnings.length >= 6);
  for (const expected of [
    "WARN",
    "DeprecationWarning",
    "ExperimentalWarning",
    "WARNINGS",
    "structured warning",
    "nested",
  ]) {
    assert.ok(
      warnings.some((warning) => warning.includes(expected)),
      `expected warning containing ${expected}`,
    );
  }
  assert.deepEqual(
    detectCypressWarnings('{"warnings":[],"warningCount":0}'),
    [],
  );
  assert.deepEqual(
    detectCypressWarnings('{\n  "warnings": [],\n  "warningCount": 0\n}'),
    [],
  );
  assert.ok(
    detectCypressWarnings('{"warningsCount":2,"warnings":[]}')
      .some((warning) => warning === "warningsCount: 2"),
  );
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
  lock.packages["node_modules/cypress"].engines.node =
    plan.node.ranges.cypress;
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function writeArtifact(path, contents = "evidence\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function accessibilityPolicy() {
  return {
    blockingViolationCount: 1,
    incompleteBlocking: false,
    levels: ["A", "AA"],
    standards: ["WCAG 2.0", "WCAG 2.1", "WCAG 2.2"],
    tags: [
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
    ],
  };
}

function emptyAccessibilityCounts() {
  return {
    incomplete: { rules: 0, nodes: 0 },
    inapplicable: { rules: 0, nodes: 0 },
    passes: { rules: 0, nodes: 0 },
    violations: { rules: 0, nodes: 0 },
  };
}

function accessibilityResult(plan, scenario) {
  return {
    schemaVersion: 1,
    tool: "cypress",
    scenario,
    axeCoreVersion: plan.packages.find(
      ({ name }) => name === "axe-core",
    ).version,
    policy: accessibilityPolicy(),
    audits: [
      {
        state: "final",
        counts: emptyAccessibilityCounts(),
        result: {
          incomplete: [],
          inapplicable: [],
          passes: [],
          violations: [],
        },
      },
    ],
  };
}

function scenarioReport(plan, capability, scenario) {
  const base = `tests/e2e/cypress/diagnostics/${scenario}`;
  const spec = scenario === "smoke"
    ? "smoke.cy.mjs"
    : "web-calculator.cy.mjs";
  const screenshot = `${base}/screenshots/${spec}/result.png`;
  return {
    schemaVersion: 1,
    capabilityId: capability.id,
    scenario,
    status: "passed",
    assertion: { status: "passed" },
    accessibility: {
      status: "passed",
      blocking: false,
      audits: ["final"],
      counts: emptyAccessibilityCounts(),
      policy: accessibilityPolicy(),
    },
    artifacts: {
      accessibilityJson: `${base}/accessibility.json`,
      accessibilityMarkdown: `${base}/accessibility.md`,
      assertion: `${base}/assertion.json`,
      runJson: `${base}/run.json`,
      screenshots: [screenshot],
      videos: [`${base}/videos/${spec}.mp4`],
    },
    browser: {
      name: capability.browser,
      requested: capability.browser,
      selectionSource: "--browser",
      version: capability.browser_evidence.version,
    },
    operatingSystem: {
      requested: capability.os,
    },
    tool: {
      name: "cypress",
      version: plan.packages.find(
        ({ name }) => name === "cypress",
      ).version,
    },
    versions: {
      axeCore: plan.packages.find(
        ({ name }) => name === "axe-core",
      ).version,
      node: `v${plan.node.locked}`,
    },
  };
}

async function writeMockArtifacts(
  plan,
  workspaceRoot,
  mutateArtifacts,
  mutateWrittenArtifacts,
) {
  const capability = plan.selected_capabilities[0];
  const reports = Object.fromEntries(
    capability.scenarios.map((scenario) => [
      scenario,
      scenarioReport(plan, capability, scenario),
    ]),
  );
  await mutateArtifacts?.(reports, capability);
  for (const [scenario, report] of Object.entries(reports)) {
    const base = join(
      workspaceRoot,
      `tests/e2e/cypress/diagnostics/${scenario}`,
    );
    await writeArtifact(
      join(base, "run.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeArtifact(
      join(base, "accessibility.json"),
      `${JSON.stringify(
        accessibilityResult(plan, scenario),
        null,
        2,
      )}\n`,
    );
    await writeArtifact(join(base, "accessibility.md"));
    await writeArtifact(
      join(base, "assertion.json"),
      '{"status":"passed"}\n',
    );
    for (const path of [
      ...report.artifacts.screenshots,
      ...report.artifacts.videos,
    ]) {
      await writeArtifact(join(workspaceRoot, path));
    }
  }
  const summary = {
    schemaVersion: 1,
    capabilityId: capability.id,
    status: "passed",
    scenarios: capability.scenarios.map((scenario) => ({
      capabilityId: capability.id,
      scenario,
      status: "passed",
    })),
  };
  await writeArtifact(
    join(
      workspaceRoot,
      "tests/e2e/cypress/diagnostics/summary.json",
    ),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeArtifact(
    join(
      workspaceRoot,
      "tests/e2e/cypress/diagnostics/summary.md",
    ),
  );
  await mutateWrittenArtifacts?.(workspaceRoot, reports, capability);
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
      environment: context.environment,
      packageRoot: context.packageRoot,
      workspaceRoot: context.workspaceRoot,
    });
    if (check.id === "cypress-candidate-lock") {
      await updateEphemeralLock(plan, context.workspaceRoot);
    }
    if (
      check.id === "cypress-candidate-install" &&
      overrides.skipInstallCache !== true
    ) {
      await writeArtifact(
        join(
          context.environment.CYPRESS_CACHE_FOLDER,
          plan.cypress_binary.version,
          "Cypress",
        ),
        "installed binary\n",
      );
    }
    if (check.id.endsWith("-web-calculator")) {
      await writeMockArtifacts(
        plan,
        context.workspaceRoot,
        overrides.mutateArtifacts,
        overrides.mutateWrittenArtifacts,
      );
    }
    const currentSequence = sequence;
    sequence += 1;
    const binding = {
      "file-evidence": {
        digest: check.expected_digest,
        locator: check.path,
        realpath: check.expected_realpath,
        version: check.expected_version,
      },
      "browser-evidence": {
        digest: check.expected_digest,
        locator: check.expected_alias,
        realpath: check.expected_realpath,
        version: check.expected_version,
      },
      "binary-evidence": {
        version: check.expected_binary_version,
      },
      "node-evidence": {
        version: check.expected_version,
      },
    }[check.kind];
    return {
      status: overrides.status?.(check) ?? "pass",
      warnings: overrides.warnings?.(check) ?? [],
      binding: overrides.binding?.(check, binding) ?? binding,
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
  assert.ok(
    observed.every(
      ({ environment }) =>
        environment.GITHUB_WORKSPACE === workspaceRoot &&
        environment.CYPRESS_CACHE_FOLDER.startsWith(
          join(workspaceRoot, "tests/e2e/cypress"),
        ) &&
        environment.npm_config_cache.startsWith(
          join(workspaceRoot, "tests/e2e/cypress"),
        ),
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

test("binary and external Chrome execution must match reviewed evidence", async () => {
  const installedCollection = await collect();
  const installedResult = await qualifyCypressCandidate(
    installedCollection,
    {
      executeCheck: passingExecutor(
        installedCollection.qualification_plan,
        [],
        {
          binding: (check, binding) =>
            check.id === "cypress-installed-binary"
              ? {
                  ...binding,
                  version: "99.0.0",
                }
              : binding,
        },
      ),
      generatedAt: "2026-10-21T17:04:30Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    },
  );
  assert.equal(installedResult.validation.disposition.state, "blocked");
  assert.equal(
    installedResult.checks.find(
      ({ id }) => id === "cypress-installed-binary",
    ).status,
    "fail",
  );

  const missingProvenanceCollection = await collect();
  const missingProvenance = await qualifyCypressCandidate(
    missingProvenanceCollection,
    {
      executeCheck: passingExecutor(
        missingProvenanceCollection.qualification_plan,
        [],
        { skipInstallCache: true },
      ),
      generatedAt: "2026-10-21T17:04:31Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    },
  );
  assert.equal(missingProvenance.validation.disposition.state, "blocked");
  assert.equal(
    missingProvenance.checks.find(
      ({ id }) => id === "cypress-install-provenance",
    ).status,
    "fail",
  );

  const aliasDirectory = await mkdtemp(
    join(tmpdir(), "cypress-reviewed-alias-"),
  );
  try {
    const evidence = await fixture();
    const reviewedArchive = evidence.binary.candidate;
    const archiveAlias = join(aliasDirectory, "cypress.zip");
    await symlink(reviewedArchive.realpath, archiveAlias);
    reviewedArchive.locator = archiveAlias;
    const archiveCollection = await collect({ evidence });
    await rm(archiveAlias);
    const replacementArchive = join(aliasDirectory, "replacement.zip");
    await writeFile(replacementArchive, "unreviewed archive\n");
    await symlink(replacementArchive, archiveAlias);
    const archiveResult = await qualifyCypressCandidate(
      archiveCollection,
      {
        executeCheck: passingExecutor(
          archiveCollection.qualification_plan,
          [],
        ),
        generatedAt: "2026-10-21T17:04:32Z",
        materializeWorkspace: materializeQualificationInputs,
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    assert.equal(
      archiveResult.validation.disposition.state,
      "blocked",
    );
    assert.equal(
      archiveResult.checks.find(
        ({ id }) => id === "cypress-binary-source",
      ).status,
      "fail",
    );
    assert.equal(
      archiveResult.checks.find(
        ({ id }) => id === "cypress-install-provenance",
      ).status,
      "fail",
    );

    const browserEvidence = await fixture();
    const reviewedBrowser =
      browserEvidence.browser["cypress-ubuntu-chrome"];
    const browserAlias = join(aliasDirectory, "google-chrome");
    await symlink(reviewedBrowser.realpath, browserAlias);
    reviewedBrowser.path = browserAlias;
    const collection = await collect({ evidence: browserEvidence });
    assert.equal(
      collection.qualification_plan.selected_capabilities[0]
        .browser_evidence.realpath,
      reviewedBrowser.realpath,
    );
    await rm(browserAlias);
    const replacement = join(aliasDirectory, "replacement-chrome");
    await writeFile(
      replacement,
      "#!/bin/sh\nprintf '%s\\n' 'Google Chrome 141.0.7390.54'\nchanged\n",
      { mode: 0o755 },
    );
    await symlink(replacement, browserAlias);
    const observed = [];
    const result = await qualifyCypressCandidate(collection, {
      executeCheck: passingExecutor(
        collection.qualification_plan,
        observed,
      ),
      generatedAt: "2026-10-21T17:04:33Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    });
    assert.equal(result.validation.disposition.state, "blocked");
    assert.equal(
      result.checks.find(
        ({ id }) => id ===
          "cypress-ubuntu-chrome-external-browser",
      ).status,
      "fail",
    );
    assert.ok(
      observed
        .filter(({ check }) => check.covers.includes("smoke"))
        .every(
          ({ environment }) =>
            environment.CHROME_BIN === reviewedBrowser.realpath &&
            environment.CYPRESS_BROWSER_PATH ===
              reviewedBrowser.realpath,
        ),
    );
  } finally {
    await rm(aliasDirectory, { force: true, recursive: true });
  }
});

test("artifact semantics require complete scenario, browser, Node, accessibility, and evidence identity", async () => {
  const mutations = [
    (reports) => {
      delete reports.smoke;
    },
    (reports) => {
      reports.smoke.accessibility.status = "failed";
    },
    (reports) => {
      reports["web-calculator"].browser.version = "999.0.0.0";
    },
    (reports) => {
      reports["web-calculator"].versions.node = "v26.0.0";
    },
    (reports) => {
      reports["web-calculator"].artifacts.screenshots = [
        "tests/e2e/cypress/diagnostics/web-calculator/screenshots/other.png",
      ];
    },
  ];
  for (const mutateArtifacts of mutations) {
    const collection = await collect();
    const result = await qualifyCypressCandidate(collection, {
      executeCheck: passingExecutor(
        collection.qualification_plan,
        [],
        { mutateArtifacts },
      ),
      generatedAt: "2026-10-21T17:04:45Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    });
    assert.equal(result.validation.disposition.state, "blocked");
    assert.equal(
      result.checks.find(
        ({ id }) => id === "cypress-ubuntu-chrome-artifact-semantics",
      ).status,
      "fail",
    );
  }

  const rawViolationCollection = await collect();
  const rawViolation = await qualifyCypressCandidate(
    rawViolationCollection,
    {
      executeCheck: passingExecutor(
        rawViolationCollection.qualification_plan,
        [],
        {
          mutateWrittenArtifacts: async (workspaceRoot) => {
            const path = join(
              workspaceRoot,
              "tests/e2e/cypress/diagnostics/smoke/accessibility.json",
            );
            const accessibility = JSON.parse(
              await readFile(path, "utf8"),
            );
            accessibility.audits[0].result.violations = [
              { id: "forged-violation", nodes: [{}] },
            ];
            accessibility.audits[0].counts.violations = {
              nodes: 1,
              rules: 1,
            };
            await writeFile(
              path,
              `${JSON.stringify(accessibility, null, 2)}\n`,
            );
          },
        },
      ),
      generatedAt: "2026-10-21T17:04:46Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    },
  );
  assert.equal(rawViolation.validation.disposition.state, "blocked");
  assert.equal(
    rawViolation.checks.find(
      ({ id }) => id === "cypress-ubuntu-chrome-artifact-semantics",
    ).status,
    "fail",
  );
});

test("rejects artifact symlinks and realpath escapes", async () => {
  const outsideDirectory = await mkdtemp(
    join(tmpdir(), "cypress-outside-artifact-"),
  );
  try {
    const outsideArtifact = join(outsideDirectory, "outside.png");
    await writeFile(outsideArtifact, "outside\n");
    const collection = await collect();
    const result = await qualifyCypressCandidate(collection, {
      executeCheck: passingExecutor(
        collection.qualification_plan,
        [],
        {
          mutateWrittenArtifacts: async (
            workspaceRoot,
            reports,
          ) => {
            const screenshot = join(
              workspaceRoot,
              reports.smoke.artifacts.screenshots[0],
            );
            await rm(screenshot);
            await symlink(outsideArtifact, screenshot);
          },
        },
      ),
      generatedAt: "2026-10-21T17:04:47Z",
      materializeWorkspace: materializeQualificationInputs,
      repositoryRoot: REPOSITORY_ROOT,
    });
    assert.equal(result.validation.disposition.state, "blocked");
    assert.equal(
      result.checks.find(
        ({ id }) => id ===
          "cypress-ubuntu-chrome-artifact-semantics",
      ).status,
      "fail",
    );
  } finally {
    await rm(outsideDirectory, { force: true, recursive: true });
  }
});

test("requires a clean source checkout at the exact claimed revision before copying", async () => {
  for (const checkout of [
    { clean: false, revision: REVISION },
    { clean: true, revision: "b".repeat(40) },
  ]) {
    const collection = await collect();
    let copied = false;
    await assert.rejects(
      qualifyCypressCandidate(collection, {
        inspectSourceCheckout: async () => checkout,
        materializeWorkspace: async () => {
          copied = true;
        },
        repositoryRoot: REPOSITORY_ROOT,
      }),
      /clean source checkout/u,
    );
    assert.equal(copied, false);
  }
});

test("guards the entire source repository against qualification mutation", async () => {
  const source = await mkdtemp(join(tmpdir(), "cypress-source-guard-"));
  try {
    await copyCollectorInputs(REPOSITORY_ROOT, source);
    await writeFile(join(source, "README.md"), "source\n");
    const collection = await collect({ repositoryRoot: source });
    const executor = passingExecutor(
      collection.qualification_plan,
      [],
    );
    let mutated = false;
    await assert.rejects(
      qualifyCypressCandidate(collection, {
        executeCheck: async (check, context) => {
          const result = await executor(check, context);
          if (!mutated && check.id === "cypress-package-tests") {
            mutated = true;
            await writeFile(join(source, "README.md"), "mutated\n");
          }
          return result;
        },
        generatedAt: "2026-10-21T17:04:50Z",
        materializeWorkspace: materializeQualificationInputs,
        repositoryRoot: source,
      }),
      /mutated the source repository/u,
    );
  } finally {
    await rm(source, { force: true, recursive: true });
  }
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
