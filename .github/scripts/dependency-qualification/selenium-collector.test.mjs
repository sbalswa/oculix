import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:https";
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
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  collectSeleniumObservation,
  createSeleniumExecutorAttestation,
  createSeleniumMutableSeedManifest,
  createSeleniumQualificationPlan,
  createSeleniumSourceMaterializationManifest,
  createSeleniumTrustedInputManifest,
  normalizeSemverRange,
  parseExactSemver,
  qualifySeleniumCandidate,
  readNpmMetadata,
  SELENIUM_MANAGED_PATHS,
  semverRangeSatisfies,
  signSeleniumExecutorAttestation,
  signSeleniumQualificationEnvelope,
  validateSeleniumQualificationArtifact,
} from "./selenium-collector.mjs";
import {
  canonicalDocument,
  readCapabilityCatalog,
  validateIndependentQualification,
  validateProviderSet,
} from "./contract.mjs";
import { createScenarioReporter } from "../../../tests/e2e/selenium/reporting.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/selenium/",
  import.meta.url,
);
const GENERATED_AT = "2026-10-21T18:00:00Z";
const execFileAsync = promisify(execFile);
const TEST_EXECUTOR_KEYS = generateKeyPairSync("ed25519");
const TEST_EXECUTOR_PUBLIC_KEY = TEST_EXECUTOR_KEYS.publicKey.export({
  format: "pem",
  type: "spki",
}).toString();

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURE_ROOT), "utf8"));
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "selenium-collector-"));
  const executableRoot = await mkdtemp(
    join(tmpdir(), "selenium-runner-bin-"),
  );
  const packageRoot = join(root, "tests", "e2e", "selenium");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, ".gitignore"),
    ".runtime/\ndiagnostics/\nnode_modules/\n",
  );
  for (const name of ["package.json", "package-lock.json"]) {
    await cp(new URL(name, FIXTURE_ROOT), join(packageRoot, name));
  }
  await cp(
    new URL("capabilities.json", FIXTURE_ROOT),
    join(root, "tests", "e2e", "capabilities.json"),
  );
  for (const path of [
    ".github/scripts/validate-e2e-reports.mjs",
    "tests/e2e/fixtures/web-calculator/lifecycle.mjs",
    "tests/e2e/selenium/browser-selection.test.mjs",
    "tests/e2e/selenium/harness.test.mjs",
    "tests/e2e/selenium/reporting.test.mjs",
    "tests/e2e/selenium/setup.mjs",
    "tests/e2e/selenium/smoke.mjs",
    "tests/e2e/selenium/web-calculator.mjs",
  ]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `// trusted fixture: ${path}\n`);
  }
  await writeFile(join(root, "README.md"), "unchanged\n", "utf8");
  const browserPath = join(executableRoot, "chromium");
  const driverPath = join(executableRoot, "chromedriver");
  const browserContent = "#!/bin/sh\nprintf 'Chromium 141.0.7390.54\\n'\n";
  const driverContent = "#!/bin/sh\nprintf 'ChromeDriver 141.0.7390.54\\n'\n";
  await Promise.all([
    writeFile(browserPath, browserContent, { mode: 0o755 }),
    writeFile(driverPath, driverContent, { mode: 0o755 }),
  ]);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync(
    "git",
    ["config", "user.email", "selenium-collector@example.invalid"],
    { cwd: root },
  );
  await execFileAsync(
    "git",
    ["config", "user.name", "Selenium Collector Tests"],
    { cwd: root },
  );
  await execFileAsync("git", ["add", "--all"], { cwd: root });
  await execFileAsync(
    "git",
    ["commit", "--quiet", "-m", "fixture"],
    { cwd: root },
  );
  return {
    root,
    runnerEvidence: {
      runner: "ubuntu-latest",
      browser: {
        name: "chromium",
        version: "141.0.7390.54",
        compatibility_key: "141.0.7390",
        locator: "https://github.com/actions/runner-images/commit/browser",
        digest: `sha256:${"b".repeat(64)}`,
        path: browserPath,
        realpath: browserPath,
        executable_digest: digest(browserContent),
      },
      driver: {
        name: "chromedriver",
        version: "141.0.7390.54",
        compatibility_key: "141.0.7390",
        locator: "https://github.com/actions/runner-images/commit/driver",
        digest: `sha256:${"d".repeat(64)}`,
        path: driverPath,
        realpath: driverPath,
        executable_digest: digest(driverContent),
      },
    },
    async cleanup() {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(executableRoot, { force: true, recursive: true }),
      ]);
    },
  };
}

async function candidateInputs(repositoryRoot, overrides = {}) {
  const npmCandidates = await fixture("npm-candidates.json");
  const { stdout: revision } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return {
    repositoryRoot,
    repository: {
      name: "sbalswa/oculix",
      revision: revision.trim(),
    },
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

async function collectQualificationCandidate(repository, overrides = {}) {
  return collectCandidate(repository.root, {
    runnerEvidence: repository.runnerEvidence,
    ...overrides,
  });
}

async function qualificationPlanInputs(repository, observation) {
  return {
    executorTools: (await localExecutorIdentity()).tools,
    mutableSeedManifest: await createSeleniumMutableSeedManifest(
      repository.root,
      observation.repository.revision,
    ),
    sourceMaterializationManifest:
      await createSeleniumSourceMaterializationManifest(
        repository.root,
        observation.repository.revision,
      ),
    trustedInputManifest: await createSeleniumTrustedInputManifest(
      repository.root,
      observation.repository.revision,
    ),
  };
}

function component(observation, id) {
  return observation.components.find((entry) => entry.id === id);
}

function relation(observation, id) {
  return observation.relations.find((entry) => entry.id === id);
}

function deterministicClock() {
  let second = 0;
  const start = Date.parse("2026-10-21T18:10:00Z");
  return () => {
    const value = new Date(start + second * 1000);
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

function sealQualificationEnvelope(envelope) {
  return signSeleniumQualificationEnvelope(
    envelope,
    TEST_EXECUTOR_KEYS.privateKey,
  );
}

let localExecutorIdentityPromise;

async function localExecutorIdentity() {
  localExecutorIdentityPromise ??= (async () => {
    const nodeRealpath = await realpath(process.execPath);
    const npmCandidates = process.platform === "win32"
      ? [
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
        ]
      : [
          join(
            dirname(process.execPath),
            "..",
            "lib",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
        ];
    let npmRealpath;
    for (const candidate of npmCandidates) {
      try {
        await access(candidate);
        npmRealpath = await realpath(candidate);
        break;
      } catch {
        // Try the next platform layout.
      }
    }
    assert.ok(npmRealpath, "npm CLI entrypoint must be discoverable");
    const { stdout: npmVersion } = await execFileAsync(
      nodeRealpath,
      [npmRealpath, "--version"],
      { encoding: "utf8" },
    );
    const authority = {
      github_api_permission: "none",
      identity_digest: digest(TEST_EXECUTOR_PUBLIC_KEY),
      kind: "ed25519",
      public_key: TEST_EXECUTOR_PUBLIC_KEY,
    };
    return {
      authority,
      path: [
        ...new Set([
          dirname(nodeRealpath),
          dirname(npmRealpath),
          ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
        ]),
      ],
      tools: {
        node: {
          digest: digest(await readFile(nodeRealpath)),
          path: process.execPath,
          realpath: nodeRealpath,
          version: process.version.slice(1),
        },
        npm: {
          digest: digest(await readFile(npmRealpath)),
          path: npmRealpath,
          realpath: npmRealpath,
          version: npmVersion.trim(),
        },
      },
    };
  })();
  return structuredClone(await localExecutorIdentityPromise);
}

async function executeRaw(step, context) {
  try {
    const { stdout, stderr } = await execFileAsync(
      step.command,
      step.arguments,
      {
        cwd: context.cwd,
        encoding: "utf8",
        env: context.environment,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return rawResult({ stdout, stderr });
  } catch (error) {
    return rawResult({
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    });
  }
}

async function packLocalCandidate(root, packageJson, extras = {}) {
  const packageRoot = join(root, packageJson.name.replaceAll("/", "-"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await writeFile(
    join(packageRoot, "index.js"),
    `export const packageName = ${JSON.stringify(packageJson.name)};\n`,
  );
  for (const [path, value] of Object.entries(extras)) {
    const target = join(packageRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--pack-destination", root, "--json"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(stdout);
  return {
    filename,
    content: await readFile(join(root, filename)),
  };
}

async function localNpmCandidates() {
  const root = await mkdtemp(join(tmpdir(), "selenium-local-npm-"));
  const keyPath = join(root, "key.pem");
  const certificatePath = join(root, "certificate.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const axeCorePackage = {
    name: "axe-core",
    version: "4.15.0",
    type: "module",
    engines: { node: ">=4.0.0" },
  };
  const axeCore = await packLocalCandidate(root, axeCorePackage);
  const axe = await packLocalCandidate(root, {
    name: "@axe-core/webdriverjs",
    version: "4.15.0",
    type: "module",
    dependencies: { "axe-core": "~4.15.0" },
    peerDependencies: { "selenium-webdriver": ">=4.40.0" },
    engines: { node: ">=24.0.0" },
  });
  const selenium = await packLocalCandidate(root, {
    name: "selenium-webdriver",
    version: "4.52.0",
    type: "module",
    engines: { node: ">=24.0.0" },
  });
  const tarballs = new Map([
    [`/${axeCore.filename}`, axeCore.content],
    [`/${axe.filename}`, axe.content],
    [`/${selenium.filename}`, selenium.content],
  ]);
  const packuments = new Map();
  const server = createServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certificatePath),
    },
    (request, response) => {
      const content = tarballs.get(request.url);
      if (content !== undefined) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": content.length,
        });
        response.end(content);
        return;
      }
      const packument = packuments.get(request.url);
      if (packument === undefined) {
        response.writeHead(404).end();
        return;
      }
      const body = Buffer.from(JSON.stringify(packument));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": body.length,
      });
      response.end(body);
    },
  );
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  const metadata = {
    "@axe-core/webdriverjs": {
      name: "@axe-core/webdriverjs",
      version: "4.15.0",
      dist: {
        tarball: `https://127.0.0.1:${port}/${axe.filename}`,
        integrity: `sha512-${createHash("sha512").update(axe.content).digest("base64")}`,
      },
      dependencies: { "axe-core": "~4.15.0" },
      engines: { node: ">=24.0.0" },
      peerDependencies: { "selenium-webdriver": ">=4.40.0" },
    },
    "axe-core": {
      ...axeCorePackage,
      dist: {
        tarball: `https://127.0.0.1:${port}/${axeCore.filename}`,
        integrity: `sha512-${createHash("sha512").update(axeCore.content).digest("base64")}`,
      },
    },
    "selenium-webdriver": {
      name: "selenium-webdriver",
      version: "4.52.0",
      dist: {
        tarball: `https://127.0.0.1:${port}/${selenium.filename}`,
        integrity: `sha512-${createHash("sha512").update(selenium.content).digest("base64")}`,
      },
      engines: { node: ">=24.0.0" },
    },
  };
  const axePackument = {
    name: "@axe-core/webdriverjs",
    "dist-tags": { latest: "4.15.0" },
    versions: {
      "4.15.0": metadata["@axe-core/webdriverjs"],
    },
  };
  for (const path of [
    "/@axe-core%2fwebdriverjs",
    "/@axe-core%2Fwebdriverjs",
    "/@axe-core/webdriverjs",
  ]) {
    packuments.set(path, axePackument);
  }
  packuments.set("/selenium-webdriver", {
    name: "selenium-webdriver",
    "dist-tags": { latest: "4.52.0" },
    versions: {
      "4.52.0": metadata["selenium-webdriver"],
    },
  });
  packuments.set("/axe-core", {
    name: "axe-core",
    "dist-tags": { latest: "4.15.0" },
    versions: {
      "4.15.0": metadata["axe-core"],
    },
  });
  return {
    metadata,
    async cleanup() {
      await new Promise((resolvePromise, rejectPromise) =>
        server.close((error) =>
          error === undefined ? resolvePromise() : rejectPromise(error)),
      );
      await rm(root, { force: true, recursive: true });
    },
  };
}

async function materializeInstalledPackages(packageRoot) {
  for (const [name, version] of [
    ["@axe-core/webdriverjs", "4.15.0"],
    ["axe-core", "4.15.0"],
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

async function writeCapabilityArtifacts(
  workspaceRoot,
  capabilityId,
  reportPaths,
  runner = {
    browser: {
      digest: digest("#!/bin/sh\nprintf 'Chromium 141.0.7390.54\\n'\n"),
      realpath: "/usr/bin/chromium",
      version: "141.0.7390.54",
    },
    driver: {
      digest: digest("#!/bin/sh\nprintf 'ChromeDriver 141.0.7390.54\\n'\n"),
      realpath: "/usr/bin/chromedriver",
      version: "141.0.7390.54",
    },
  },
) {
  for (const reportPath of reportPaths) {
    const scenario = reportPath.split("/").at(-2);
    const diagnosticsDirectory = join(
      workspaceRoot,
      "tests",
      "e2e",
      "selenium",
      "diagnostics",
    );
    const assertion =
      scenario === "smoke"
        ? {
            actual: "clicked",
            expected: "clicked",
            name: "selenium smoke button state",
          }
        : {
            actual: "238",
            expected: "238",
            name: "web-calculator final display",
          };
    const reporter = await createScenarioReporter({
      assertion,
      diagnosticsDirectory,
      repositoryDirectory: workspaceRoot,
      scenario,
      versions: {
        axeCore: "4.15.0",
        axeWebdriver: "4.15.0",
        selenium: "4.52.0",
      },
    });
    reporter.recordMetadata({
      browser: "chromium",
      browserExecutable: runner.browser,
      browserName: "chrome",
      browserVersion: "141.0.7390.54",
      driverExecutable: runner.driver,
      driverVersion: "141.0.7390.54",
      hostDistribution: "ubuntu",
      hostPlatform: "linux",
      nodeVersion: "v24.0.0",
      os: capabilityId.split("-")[1],
      platformName: "linux",
    });
    reporter.recordAssertion({
      actual: assertion.actual,
      status: "passed",
    });
    await mkdir(reporter.directory, { recursive: true });
    await writeFile(reporter.paths.screenshot, "png\n", "utf8");
    if (scenario === "web-calculator") {
      const accessibility = {
        incomplete: [],
        inapplicable: [],
        passes: [],
        testEngine: { version: "4.15.0" },
        violations: [],
      };
      await writeFile(
        reporter.paths.accessibility,
        `${JSON.stringify(accessibility)}\n`,
      );
      await writeFile(
        reporter.paths.accessibilitySummary,
        "# Selenium accessibility\n",
      );
      reporter.recordAccessibility(accessibility);
    }
    await reporter.write({ status: "passed" });
  }
}

async function pinCandidateManifest(packageRoot) {
  const path = join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.dependencies["@axe-core/webdriverjs"] = "4.15.0";
  manifest.dependencies["selenium-webdriver"] = "4.52.0";
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function materializeCandidateLock(packageRoot) {
  const path = join(packageRoot, "package-lock.json");
  const lock = JSON.parse(await readFile(path, "utf8"));
  const metadata = await fixture("npm-candidates.json");
  lock.packages[""].dependencies["@axe-core/webdriverjs"] = "4.15.0";
  lock.packages[""].dependencies["selenium-webdriver"] = "4.52.0";
  for (const name of [
    "@axe-core/webdriverjs",
    "axe-core",
    "selenium-webdriver",
  ]) {
    lock.packages[`node_modules/${name}`] = {
      version: metadata[name].version,
      resolved: metadata[name].dist.tarball,
      integrity: metadata[name].dist.integrity,
      engines: metadata[name].engines,
      ...(metadata[name].dependencies === undefined
        ? {}
        : { dependencies: metadata[name].dependencies }),
      ...(metadata[name].peerDependencies === undefined
        ? {}
        : { peerDependencies: metadata[name].peerDependencies }),
    };
  }
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function passingRunner(observed, overrides = {}) {
  return async (step, context) => {
    observed.push({ step, context });
    if (step.id === "apply-selenium-tarballs") {
      await pinCandidateManifest(context.packageRoot);
      await materializeCandidateLock(context.packageRoot);
    }
    if (step.id === "install-selenium-candidate") {
      await materializeInstalledPackages(context.packageRoot);
    }
    if (step.kind === "node-identity") {
      return rawResult({ stdout: `${process.version}\n` });
    }
    if (step.kind === "npm-identity") {
      return rawResult({
        stdout: `${context.execution.policy.tools.npm.version}\n`,
      });
    }
    if (step.kind === "browser-identity") {
      return rawResult({
        stdout: "Chromium 141.0.7390.54\n",
        ...overrides.browser,
      });
    }
    if (step.kind === "driver-identity") {
      return rawResult({
        stdout: "ChromeDriver 141.0.7390.54\n",
        ...overrides.driver,
      });
    }
    if (
      overrides.artifacts !== false &&
      step.kind === "command" &&
      step.scenario !== null
    ) {
      await writeCapabilityArtifacts(
        context.workspaceRoot,
        step.capability_id,
        [
          `tests/e2e/selenium/diagnostics/${step.scenario}/result.json`,
        ],
        {
          browser: {
            digest:
              context.environment.E2E_BROWSER_EXECUTABLE_DIGEST,
            realpath:
              context.environment.E2E_BROWSER_EXECUTABLE_REALPATH,
            version:
              context.environment.E2E_BROWSER_EXECUTABLE_VERSION,
          },
          driver: {
            digest: context.environment.E2E_DRIVER_EXECUTABLE_DIGEST,
            realpath:
              context.environment.E2E_DRIVER_EXECUTABLE_REALPATH,
            version:
              context.environment.E2E_DRIVER_EXECUTABLE_VERSION,
          },
        },
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
  const {
    attestation: mutateAttestation,
    environment,
    executor,
    requestConsumer,
    requestFreshness,
    runCommand = async () => rawResult({ exitCode: 1 }),
    trustedAuthority,
    ...qualificationOverrides
  } = overrides;
  const identity = await localExecutorIdentity();
  const isolatedExecutor =
    executor ??
    {
      ...identity,
      id: "test-disposable-executor",
      seal: sealQualificationEnvelope,
      async execute(step, context) {
        const result = await runCommand(step, context);
        const attestation = createSeleniumExecutorAttestation({
          environment: context.environment,
          execution: context.execution,
          result,
          step,
        });
        const signedAttestation = signSeleniumExecutorAttestation(
          attestation,
          TEST_EXECUTOR_KEYS.privateKey,
        );
        return {
          attestation:
            mutateAttestation === undefined
              ? signedAttestation
              : mutateAttestation(signedAttestation, step, context),
          result,
        };
      },
    };
  return qualifySeleniumCandidate(
    {
      observation,
      repositoryRoot: repository.root,
    },
    {
      catalog,
      consumeExecutionRequest:
        requestConsumer ??
        (() => {
          const consumed = new Set();
          return (request) => {
            if (consumed.has(request.request_digest)) {
              return false;
            }
            consumed.add(request.request_digest);
            return true;
          };
        })(),
      environmentOverrides: environment ?? {},
      executionRequestFreshness:
        requestFreshness ?? {
          challenge: "c".repeat(64),
          run_id: "workflow-123-attempt-1-selenium",
          issued_at: "2026-10-21T18:09:00.000Z",
          expires_at: "2026-10-21T18:24:00.000Z",
        },
      executor: isolatedExecutor,
      generatedAt: "2026-10-21T18:20:00Z",
      now: deterministicClock(),
      trustedExecutorAuthority:
        trustedAuthority ?? identity.authority,
      ...qualificationOverrides,
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

test("npm range discovery selects and re-queries one exact highest version", async () => {
  const calls = [];
  const metadata = {
    name: "axe-core",
    version: "4.15.2",
    dist: {
      integrity: "sha512-ZXhhY3Q=",
      tarball: "https://registry.npmjs.org/axe-core/-/axe-core-4.15.2.tgz",
    },
    engines: { node: ">=4.0.0" },
  };
  const result = await readNpmMetadata("axe-core", "~4.15.0", {
    execute: async (_command, arguments_) => {
      calls.push(arguments_);
      return {
        stdout: arguments_.length === 4
          ? JSON.stringify(["4.15.0", "4.15.2", "4.15.1"])
          : JSON.stringify(metadata),
      };
    },
  });

  assert.deepEqual(result, metadata);
  assert.deepEqual(
    calls.map((arguments_) => arguments_[1]),
    ["axe-core@~4.15.0", "axe-core@4.15.2"],
  );
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
                revision: observation.repository.revision,
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
    "1.2",
    "^1.2",
    "1.x",
    ">1",
    "1.2.3 - 2.0.0",
  ]) {
    assert.throws(
      () => normalizeSemverRange(range),
      /nonempty|invalid|empty|exact|unsupported/u,
    );
  }
  assert.equal(normalizeSemverRange(">=24"), ">=24.0.0");
  assert.equal(semverRangeSatisfies("0.2.9", "^0.2.3"), true);
  assert.equal(semverRangeSatisfies("0.3.0", "^0.2.3"), false);
  assert.equal(semverRangeSatisfies("0.0.3", "^0.0.3"), true);
  assert.equal(semverRangeSatisfies("0.0.4", "^0.0.3"), false);
  assert.equal(
    semverRangeSatisfies(
      "1.2.3-beta.2",
      ">=1.2.3-beta.1 <1.2.3",
    ),
    true,
  );
  assert.equal(
    semverRangeSatisfies("1.2.4-beta.1", ">=1.2.3"),
    false,
  );
  assert.equal(
    semverRangeSatisfies(
      "1.0.0-90071992547409931234567891",
      ">1.0.0-90071992547409931234567890 <1.0.0",
    ),
    true,
  );
  assert.equal(
    semverRangeSatisfies(
      "1.0.0-90071992547409931234567889",
      ">1.0.0-90071992547409931234567890 <1.0.0",
    ),
    false,
  );
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
    const planInputs = await qualificationPlanInputs(
      repository,
      observation,
    );
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog: await fixture("capabilities.json"),
      ...planInputs,
    });
    const apply = plan.steps.find(
      ({ id }) => id === "apply-selenium-tarballs",
    );
    const cacheSteps = plan.steps.filter(
      ({ id }) => id.startsWith("cache-selenium-"),
    );

    assert.equal(plan.workspace.kind, "isolated-executor");
    assert.equal(plan.workspace.github_api_permission, "none");
    assert.equal(
      plan.workspace.source_materialization.kind,
      "repository-source-materialization-manifest",
    );
    assert.equal(
      plan.workspace.mutable_seed.kind,
      "repository-mutable-seed-manifest",
    );
    assert.equal(
      plan.workspace.immutable_inputs.kind,
      "repository-trusted-input-manifest",
    );
    assert.equal(plan.workspace.immutable_inputs.access, "read-only");
    assert.equal(
      plan.workspace.immutable_inputs.manifest.repository_revision,
      observation.repository.revision,
    );
    assert.equal(
      plan.workspace.immutable_inputs.manifest.github_api_permission,
      "none",
    );
    assert.ok(
      plan.workspace.immutable_inputs.manifest.files.every(
        ({ digest: fileDigest }) =>
          /^sha256:[0-9a-f]{64}$/u.test(fileDigest),
      ),
    );
    const mutablePath = (path) =>
      plan.workspace.mutable_paths.some(
        (root) => path === root || path.startsWith(`${root}/`),
      );
    assert.ok(
      plan.workspace.source_materialization.manifest.files.some(
        ({ path }) => path === "tests/e2e/selenium/package.json",
      ),
    );
    assert.ok(
      plan.workspace.mutable_seed.manifest.files.every(
        ({ path }) => mutablePath(path),
      ),
    );
    assert.ok(
      plan.workspace.immutable_inputs.manifest.files.every(
        ({ path }) => !mutablePath(path),
      ),
    );
    assert.deepEqual(
      plan.workspace.mutable_seed.manifest.files.map(({ path }) => path),
      [
        "tests/e2e/selenium/package-lock.json",
        "tests/e2e/selenium/package.json",
      ],
    );
    assert.deepEqual(plan.workspace.mutable_paths, [
        "tests/e2e/selenium/package.json",
        "tests/e2e/selenium/package-lock.json",
        "tests/e2e/selenium/.npm-cache",
        "tests/e2e/selenium/.runtime",
        "tests/e2e/selenium/diagnostics",
        "tests/e2e/selenium/node_modules",
    ]);
    assert.deepEqual(plan.workspace.managed_paths, SELENIUM_MANAGED_PATHS);
    assert.equal(cacheSteps.length, 3);
    assert.ok(
      [
        ...cacheSteps,
        apply,
        plan.steps.find(
          ({ id }) => id === "install-selenium-candidate",
        ),
      ].every(({ cwd }) => cwd === "tests/e2e/selenium"),
    );
    assert.ok(
      cacheSteps.every(
        ({ arguments: arguments_ }) =>
          arguments_[1] === "cache" &&
          arguments_[2] === "add" &&
          arguments_.includes("--cache") &&
          arguments_.includes(".npm-cache"),
      ),
    );
    assert.ok(
      cacheSteps.some(({ arguments: arguments_ }) =>
        arguments_.includes(
          "https://registry.npmjs.org/@axe-core/webdriverjs/-/webdriverjs-4.15.0.tgz",
        )),
    );
    assert.ok(
      cacheSteps.some(({ arguments: arguments_ }) =>
        arguments_.includes(
          "https://registry.npmjs.org/axe-core/-/axe-core-4.15.0.tgz",
        )),
    );
    assert.ok(
      cacheSteps.some(({ arguments: arguments_ }) =>
        arguments_.includes(
          "https://registry.npmjs.org/selenium-webdriver/-/selenium-webdriver-4.52.0.tgz",
        )),
    );
    assert.ok(
      apply.arguments.includes("@axe-core/webdriverjs@4.15.0"),
    );
    assert.ok(
      apply.arguments.includes("selenium-webdriver@4.52.0"),
    );
    assert.ok(apply.arguments.includes("--save-exact"));
    assert.ok(apply.arguments.includes("--registry"));
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
      plan.steps.every(
        ({ command }) => command !== "node" && command !== "npm",
      ),
    );
    const installIndex = plan.steps.findIndex(
      ({ id }) => id === "install-selenium-candidate",
    );
    assert.ok(installIndex >= 0);
    assert.ok(
      plan.steps
        .slice(installIndex + 1)
        .every(({ tool }) => tool !== "npm"),
    );
    assert.deepEqual(
      plan.steps.find(({ id }) => id === "test-selenium-package")
        .arguments,
      [
        "--test",
        "tests/e2e/selenium/browser-selection.test.mjs",
        "tests/e2e/selenium/harness.test.mjs",
        "tests/e2e/selenium/reporting.test.mjs",
      ],
    );
    assert.deepEqual(
      plan.steps.find(
        ({ id }) => id === "selenium-ubuntu-chromium-smoke",
      ).arguments,
      [
        "tests/e2e/selenium/smoke.mjs",
        "--browser",
        "chromium",
        "--os",
        "ubuntu",
      ],
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
          ...planInputs,
        }),
    );

    for (const mutate of [
      (candidate) => {
        relation(candidate, "selenium-webdriver-node").hard = false;
      },
      (candidate) => {
        relation(candidate, "selenium-axe-node").constraint = ">=0.0.0";
      },
      (candidate) => {
        relation(candidate, "selenium-axe-policy-alignment").from =
          "selenium-runner-browser";
      },
    ]) {
      const redirected = structuredClone(observation);
      mutate(redirected);
      assert.throws(
        () =>
          createSeleniumQualificationPlan({
            observation: redirected,
            catalog,
            ...planInputs,
          }),
        /relations do not exactly bind/u,
      );
    }
    const tamperedManifest = structuredClone(
      planInputs.trustedInputManifest,
    );
    tamperedManifest.repository_revision = "0".repeat(40);
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog,
          executorTools: planInputs.executorTools,
          mutableSeedManifest: planInputs.mutableSeedManifest,
          sourceMaterializationManifest:
            planInputs.sourceMaterializationManifest,
          trustedInputManifest: tamperedManifest,
        }),
      /trusted-input manifest/u,
    );
    assert.deepEqual(
      plan.selected_capabilities.find(
        ({ id }) => id === "selenium-ubuntu-chromium",
      ).result_reports,
      [
        "tests/e2e/selenium/diagnostics/smoke/result.json",
        "tests/e2e/selenium/diagnostics/web-calculator/result.json",
      ],
    );
  } finally {
    await repository.cleanup();
  }
});

test("qualification requires the exact clean source checkout", async () => {
  const headRepository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(headRepository);
    await writeFile(join(headRepository.root, "post-observation.txt"), "new\n");
    await execFileAsync("git", ["add", "--all"], { cwd: headRepository.root });
    await execFileAsync(
      "git",
      ["commit", "--quiet", "-m", "advance head"],
      { cwd: headRepository.root },
    );
    await assert.rejects(
      qualify(headRepository, observation),
      /HEAD must exactly match/u,
    );
  } finally {
    await headRepository.cleanup();
  }

  for (const [name, mutate] of [
    [
      "tracked",
      (repository) =>
        writeFile(join(repository.root, "README.md"), "dirty tracked\n"),
    ],
    [
      "untracked",
      (repository) =>
        writeFile(join(repository.root, "untracked.txt"), "dirty untracked\n"),
    ],
    [
      "ignored",
      async (repository) => {
        const path = join(
          repository.root,
          "tests",
          "e2e",
          "selenium",
          "diagnostics",
          "ignored.txt",
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "dirty ignored\n");
      },
    ],
  ]) {
    const repository = await createRepository();
    try {
      const observation = await collectQualificationCandidate(repository);
      await mutate(repository);
      await assert.rejects(
        qualify(repository, observation),
        /clean across tracked, untracked, and ignored/u,
        name,
      );
    } finally {
      await repository.cleanup();
    }
  }
});

test("source and materialized workspace symlinks cannot escape their roots", async () => {
  for (const mode of ["absolute", "relative"]) {
    const repository = await createRepository();
    try {
      const outside = join(
        dirname(repository.root),
        `selenium-source-outside-${mode}-${Date.now()}`,
      );
      await writeFile(outside, "outside\n");
      const link = join(repository.root, `source-${mode}-escape`);
      await symlink(
        mode === "absolute" ? outside : relative(repository.root, outside),
        link,
      );
      await execFileAsync("git", ["add", "--all"], { cwd: repository.root });
      await execFileAsync(
        "git",
        ["commit", "--quiet", "-m", `source ${mode} escape`],
        { cwd: repository.root },
      );
      const observation = await collectQualificationCandidate(repository);
      await assert.rejects(
        qualify(repository, observation),
        /Source repository symlink .* escapes its root/u,
      );
      await rm(outside, { force: true });
    } finally {
      await repository.cleanup();
    }
  }

  for (const mode of ["absolute", "relative"]) {
    const repository = await createRepository();
    let outside;
    try {
      const observation = await collectQualificationCandidate(repository);
      await assert.rejects(
        qualify(repository, observation, {
          materializeWorkspace: async (source, destination) => {
            await cp(source, destination, {
              recursive: true,
              filter: (path) =>
                !relative(source, path)
                  .split("/")
                  .includes(".git"),
            });
            outside = join(
              dirname(destination),
              `workspace-outside-${mode}`,
            );
            await writeFile(outside, "outside\n");
            await symlink(
              mode === "absolute"
                ? outside
                : relative(destination, outside),
              join(destination, `workspace-${mode}-escape`),
            );
          },
        }),
        /Ephemeral workspace symlink .* escapes its root/u,
      );
    } finally {
      if (outside !== undefined) {
        await rm(outside, { force: true });
      }
      await repository.cleanup();
    }
  }
});

test("materialization cannot substitute a trusted repository file", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    let calls = 0;
    await assert.rejects(
      qualify(repository, observation, {
        materializeWorkspace: async (source, destination) => {
          await cp(source, destination, {
            recursive: true,
            filter: (path) =>
              !relative(source, path).split("/").includes(".git"),
          });
          await writeFile(
            join(destination, "README.md"),
            "substituted before measurement\n",
          );
        },
        runCommand: async () => {
          calls += 1;
          return rawResult();
        },
      }),
      /does not exactly match the source, seed, and trusted-input manifests/u,
    );
    assert.equal(calls, 0);
  } finally {
    await repository.cleanup();
  }
});

test("controlled ephemeral execution independently qualifies all capabilities", async () => {
  const repository = await createRepository();
  let temporaryRoot;
  try {
    const observation = await collectQualificationCandidate(repository);
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
    assert.ok(
      observed.every(
        ({ context }) =>
          context.environment.GITHUB_WORKSPACE === context.workspaceRoot,
      ),
    );
    assert.equal(result.executor.policy.environment.inherit_host, false);
    assert.equal(
      result.executor.plan.workspace.github_api_permission,
      "none",
    );
    assert.equal(
      result.executor.trusted_inputs.github_api_permission,
      "none",
    );
    assert.equal(
      result.executor.policy.authority.github_api_permission,
      "none",
    );
    assert.deepEqual(result.executor.policy.isolation, {
      disposable: true,
      github_api_access: false,
      network: "candidate-registry-only",
      privileges: "unprivileged",
      repository_write_access: false,
      secrets: "none",
    });
    assert.equal(
      result.executor.policy.filesystem.immutable_inputs.access,
      "read-only",
    );
    assert.deepEqual(
      result.executor.policy.filesystem.mutable_paths.repository,
      result.executor.plan.workspace.mutable_paths,
    );
    assert.ok(result.executor.attestations.length > 0);
    assert.ok(
      result.validation.results.every(({ evidence }) =>
        evidence.some(
          ({ type }) =>
            type === "qualification-executor-attestation-set",
        )),
    );
    assert.equal(
      result.executor.policy.environment.variables.GITHUB_WORKSPACE,
      "${WORKSPACE_ROOT}",
    );
    assert.ok(
      !JSON.stringify(result.executor.policy).includes(temporaryRoot),
    );
    assert.ok(
      result.executor.attestations.every(
        (attestation) =>
          attestation.request_digest ===
            result.executor.request.request_digest &&
          attestation.plan_digest ===
            result.executor.request.plan_digest &&
          typeof attestation.working_directory === "string" &&
          !("stdout" in attestation) &&
          !("stderr" in attestation) &&
          !("payload" in attestation),
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("cross-job artifact strictly validates authority, execution, results, and request time", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const catalog = await fixture("capabilities.json");
    const authority = (await localExecutorIdentity()).authority;
    const artifact = await qualify(repository, observation, {
      runCommand: passingRunner([]),
    });
    const options = {
      catalog,
      observation,
      trustedExecutorAuthority: authority,
    };
    const serializedArtifact = JSON.parse(JSON.stringify(artifact));

    assert.deepEqual(
      validateSeleniumQualificationArtifact(serializedArtifact, options),
      serializedArtifact,
    );
    assert.equal(artifact.kind, "selenium-qualification-artifact");
    assert.equal(
      artifact.envelope.status,
      "independently-qualified",
    );
    assert.deepEqual(artifact.envelope.warnings, []);
    assert.ok(artifact.executor.executions.length > 0);
    assert.ok(
      artifact.executor.executions.every(
        ({ completed_at: completedAt, started_at: startedAt }) =>
          startedAt >= artifact.executor.request.issued_at &&
          completedAt < artifact.executor.request.expires_at,
      ),
    );

    const mutations = [
      ["unknown artifact field", (value) => {
        value.untrusted = true;
      }],
      ["missing request field", (value) => {
        delete value.executor.request.policy_digest;
      }],
      ["tampered authority", (value) => {
        value.authority.identity_digest = `sha256:${"0".repeat(64)}`;
      }],
      ["tampered plan", (value) => {
        value.executor.plan.workspace.mutable_paths.push("README.md");
      }],
      ["read-only mutable seed", (value) => {
        value.executor.policy.filesystem.mutable_seed.access = "read-only";
      }],
      ["execution after expiry", (value) => {
        value.executor.executions[0].completed_at =
          value.executor.request.expires_at;
      }],
      ["tampered check status", (value) => {
        value.checks[0].status =
          value.checks[0].status === "pass" ? "fail" : "pass";
      }],
      ["tampered warning", (value) => {
        value.validation.results[0].warnings.push("forged warning");
      }],
      ["tampered evidence", (value) => {
        value.validation.results[0].evidence.at(-1).digest =
          `sha256:${"0".repeat(64)}`;
      }],
      ["tampered envelope digest", (value) => {
        value.envelope.checks_digest = `sha256:${"0".repeat(64)}`;
      }],
      ["forged envelope signature", (value) => {
        value.envelope.signature =
          `${value.envelope.signature.startsWith("A") ? "B" : "A"}` +
          value.envelope.signature.slice(1);
      }],
    ];
    for (const [name, mutate] of mutations) {
      const forged = structuredClone(artifact);
      mutate(forged);
      assert.throws(
        () => validateSeleniumQualificationArtifact(forged, options),
        undefined,
        name,
      );
    }
  } finally {
    await repository.cleanup();
  }
});

test("source materialization exactly partitions mutable seed from read-only trusted inputs", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const catalog = await fixture("capabilities.json");
    const inputs = await qualificationPlanInputs(repository, observation);
    const plan = createSeleniumQualificationPlan({
      observation,
      catalog,
      ...inputs,
    });
    const sourcePaths = new Set(
      plan.workspace.source_materialization.manifest.files.map(
        ({ path }) => path,
      ),
    );
    const seedPaths = new Set(
      plan.workspace.mutable_seed.manifest.files.map(({ path }) => path),
    );
    const trustedPaths = new Set(
      plan.workspace.immutable_inputs.manifest.files.map(
        ({ path }) => path,
      ),
    );
    assert.equal(sourcePaths.size, seedPaths.size + trustedPaths.size);
    assert.ok([...seedPaths].every((path) => !trustedPaths.has(path)));
    assert.ok(
      [...sourcePaths].every(
        (path) => seedPaths.has(path) || trustedPaths.has(path),
      ),
    );

    const overlap = structuredClone(inputs);
    overlap.trustedInputManifest.files.push(
      structuredClone(overlap.mutableSeedManifest.files[0]),
    );
    overlap.trustedInputManifest.files.sort(({ path: left }, { path: right }) =>
      left.localeCompare(right));
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog,
          ...overlap,
        }),
      /labels mutable path|overlap/u,
    );

    const incomplete = structuredClone(inputs);
    incomplete.mutableSeedManifest.files.pop();
    assert.throws(
      () =>
        createSeleniumQualificationPlan({
          observation,
          catalog,
          ...incomplete,
        }),
      /exactly partition/u,
    );
  } finally {
    await repository.cleanup();
  }
});

test("candidate-mutated package scripts are never invoked", async () => {
  const repository = await createRepository();
  const markerRoot = await mkdtemp(join(tmpdir(), "selenium-script-attack-"));
  const marker = join(markerRoot, "executed");
  try {
    const observation = await collectQualificationCandidate(repository);
    const observed = [];
    const runner = passingRunner(observed);
    const result = await qualify(repository, observation, {
      runCommand: async (step, context) => {
        const raw = await runner(step, context);
        if (step.id === "test-selenium-package") {
          const manifestPath = join(context.packageRoot, "package.json");
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          );
          manifest.scripts = {
            setup: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'setup')"`,
            smoke: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'smoke')"`,
            "web-calculator":
              `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'calculator')"`,
          };
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
        }
        return raw;
      },
    });

    assert.equal(
      result.validation.disposition.state,
      "independently-qualified",
    );
    const packageTestIndex = observed.findIndex(
      ({ step }) => step.id === "test-selenium-package",
    );
    assert.ok(packageTestIndex >= 0);
    assert.ok(
      observed
        .slice(packageTestIndex)
        .every(
          ({ step }) =>
            step.tool !== "npm" &&
            step.command !== "node" &&
            step.command !== "npm",
        ),
    );
    await assert.rejects(access(marker));
  } finally {
    await rm(markerRoot, { force: true, recursive: true });
    await repository.cleanup();
  }
});

test("qualification has no implicit executor and rejects host environment input", async () => {
  const repository = await createRepository();
  const previousSecret = process.env.SELENIUM_EXECUTOR_TEST_SECRET;
  process.env.SELENIUM_EXECUTOR_TEST_SECRET = "must-not-cross";
  try {
    const observation = await collectQualificationCandidate(repository);
    await assert.rejects(
      qualifySeleniumCandidate(
        {
          observation,
          repositoryRoot: repository.root,
        },
        {
          catalog: await fixture("capabilities.json"),
          generatedAt: "2026-10-21T18:20:00Z",
        },
      ),
      /Selenium executor must be an object/u,
    );

    const observed = [];
    const result = await qualify(repository, observation, {
      runCommand: passingRunner(observed),
    });
    assert.equal(
      result.validation.disposition.state,
      "independently-qualified",
    );
    assert.ok(
      observed.every(
        ({ context }) =>
          context.environment.SELENIUM_EXECUTOR_TEST_SECRET === undefined &&
          context.environment.GITHUB_TOKEN === undefined &&
          context.environment.AWS_SECRET_ACCESS_KEY === undefined,
      ),
    );
    await assert.rejects(
      qualify(repository, observation, {
        environment: {
          GITHUB_TOKEN: "forbidden",
        },
        runCommand: passingRunner([]),
      }),
      /GITHUB_TOKEN is not allowlisted/u,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.SELENIUM_EXECUTOR_TEST_SECRET;
    } else {
      process.env.SELENIUM_EXECUTOR_TEST_SECRET = previousSecret;
    }
    await repository.cleanup();
  }
});

test("unknown executor authorities fail before execution", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const identity = await localExecutorIdentity();
    const rogueKeys = generateKeyPairSync("ed25519");
    const roguePublicKey = rogueKeys.publicKey.export({
      format: "pem",
      type: "spki",
    }).toString();
    let calls = 0;
    await assert.rejects(
      qualify(repository, observation, {
        executor: {
          ...identity,
          authority: {
            github_api_permission: "none",
            identity_digest: digest(roguePublicKey),
            kind: "ed25519",
            public_key: roguePublicKey,
          },
          id: "rogue-disposable-executor",
          seal: sealQualificationEnvelope,
          async execute() {
            calls += 1;
            throw new Error("must not execute");
          },
        },
      }),
      /not caller-trusted/u,
    );
    assert.equal(calls, 0);
  } finally {
    await repository.cleanup();
  }
});

test("stale and replayed executor requests fail closed", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    for (const requestFreshness of [
      {
        challenge: "a".repeat(64),
        run_id: "workflow-123-attempt-1-stale",
        issued_at: "2026-10-21T17:00:00.000Z",
        expires_at: "2026-10-21T17:10:00.000Z",
      },
      {
        challenge: "b".repeat(64),
        run_id: "workflow-123-attempt-1-future",
        issued_at: "2026-10-21T19:00:00.000Z",
        expires_at: "2026-10-21T19:10:00.000Z",
      },
    ]) {
      await assert.rejects(
        qualify(repository, observation, { requestFreshness }),
        /stale or not yet valid/u,
      );
    }

    const consumedChallenges = new Set();
    const requestConsumer = (request) => {
      if (consumedChallenges.has(request.challenge)) {
        return false;
      }
      consumedChallenges.add(request.challenge);
      return true;
    };
    await qualify(repository, observation, {
      requestConsumer,
      runCommand: async () => rawResult({ exitCode: 1 }),
    });
    await assert.rejects(
      qualify(repository, observation, {
        requestConsumer,
        runCommand: async () => rawResult({ exitCode: 1 }),
      }),
      /already consumed/u,
    );
  } finally {
    await repository.cleanup();
  }
});

test("prior-run executor attestations cannot be replayed", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const first = await qualify(repository, observation, {
      runCommand: async (step, context) =>
        step.kind === "node-identity"
          ? rawResult({ stdout: `${process.version}\n` })
          : rawResult({ exitCode: 1 }),
    });
    const replayed = first.executor.attestations[0];
    assert.ok(replayed);
    const second = await qualify(repository, observation, {
      requestConsumer: () => true,
      requestFreshness: {
        challenge: "d".repeat(64),
        run_id: "workflow-123-attempt-2-selenium",
        issued_at: "2026-10-21T18:09:00.000Z",
        expires_at: "2026-10-21T18:24:00.000Z",
      },
      executor: {
        ...(await localExecutorIdentity()),
        id: "test-disposable-executor",
        seal: sealQualificationEnvelope,
        async execute(step) {
          return {
            attestation: structuredClone(replayed),
            result:
              step.kind === "node-identity"
                ? rawResult({ stdout: `${process.version}\n` })
                : rawResult({ exitCode: 1 }),
          };
        },
      },
    });
    assert.deepEqual(second.validation.disposition, {
      state: "blocked",
      reason_codes: ["APPLICATION_FAILED"],
    });
    assert.equal(second.executor.attestations.length, 0);
  } finally {
    await repository.cleanup();
  }
});

test("Node and npm shims or forged identities cannot intercept execution", async () => {
  for (const toolName of ["node", "npm"]) {
    for (const mutation of ["path", "digest", "version"]) {
      const repository = await createRepository();
      const shimRoot = await mkdtemp(
        join(tmpdir(), `selenium-${toolName}-shim-`),
      );
      try {
        const observation = await collectQualificationCandidate(repository);
        const identity = await localExecutorIdentity();
        const tools = structuredClone(identity.tools);
        if (mutation === "path") {
          const shim = join(
            shimRoot,
            process.platform === "win32" ? `${toolName}.cmd` : toolName,
          );
          await writeFile(
            shim,
            process.platform === "win32"
              ? "@echo off\r\nexit /b 99\r\n"
              : "#!/bin/sh\nexit 99\n",
            { mode: 0o755 },
          );
          tools[toolName].path = shim;
        } else if (mutation === "digest") {
          tools[toolName].digest = `sha256:${"0".repeat(64)}`;
        } else {
          tools[toolName].version = "0.0.1";
        }
        let calls = 0;
        await assert.rejects(
          qualify(repository, observation, {
            executor: {
              ...identity,
              id: "test-disposable-executor",
              seal: sealQualificationEnvelope,
              tools,
              async execute() {
                calls += 1;
                throw new Error("must not execute");
              },
            },
          }),
          /executable|version|realpath/u,
          `${toolName}/${mutation}`,
        );
        assert.equal(calls, 0, `${toolName}/${mutation}`);
      } finally {
        await rm(shimRoot, { force: true, recursive: true });
        await repository.cleanup();
      }
    }
  }
});

test("missing or forged executor attestations fail closed", async () => {
  for (const mutation of [
    "missing",
    "candidate",
    "challenge",
    "environment",
    "expires",
    "executable",
    "isolation",
    "payload",
    "signature",
    "tools",
    "run",
  ]) {
    const repository = await createRepository();
    try {
      const observation = await collectQualificationCandidate(repository);
      let calls = 0;
      const result = await qualify(repository, observation, {
        attestation(attestation) {
          calls += 1;
          const forged = structuredClone(attestation);
          if (mutation === "missing") {
            return undefined;
          } else if (mutation === "candidate") {
            forged.candidate_digest = "0".repeat(64);
          } else if (mutation === "challenge") {
            forged.challenge = "d".repeat(64);
          } else if (mutation === "environment") {
            forged.environment_digest = `sha256:${"0".repeat(64)}`;
          } else if (mutation === "expires") {
            forged.expires_at = "2026-10-21T18:23:00.000Z";
          } else if (mutation === "executable") {
            forged.executable_identity_digest = `sha256:${"0".repeat(64)}`;
          } else if (mutation === "payload") {
            forged.payload = "forbidden";
          } else if (mutation === "signature") {
            forged.signature =
              `${forged.signature.startsWith("A") ? "B" : "A"}` +
              forged.signature.slice(1);
          } else if (mutation === "tools") {
            forged.tools_digest = `sha256:${"0".repeat(64)}`;
          } else if (mutation === "run") {
            forged.run_id = "workflow-123-attempt-2-selenium";
          } else {
            forged.isolation.repository_write_access = true;
          }
          return forged;
        },
        runCommand: passingRunner([]),
      });

      assert.equal(calls, 1, mutation);
      assert.deepEqual(
        result.validation.disposition,
        {
          state: "blocked",
          reason_codes: ["APPLICATION_FAILED"],
        },
        mutation,
      );
      assert.ok(
        result.validation.results.every(
          ({ evidence }) =>
            evidence.every(
              ({ type }) =>
                type !== "qualification-executor-attestation",
            ),
        ),
        mutation,
      );
    } finally {
      await repository.cleanup();
    }
  }
});

test("real npm creates and installs the candidate manifest and lock", async () => {
  const repository = await createRepository();
  const localRegistry = await localNpmCandidates();
  let generatedManifest;
  let generatedLock;
  let applyRaw;
  try {
    const observation = await collectQualificationCandidate(repository, {
      npm: async (name) => structuredClone(localRegistry.metadata[name]),
    });
    const observed = [];
    const result = await qualify(repository, observation, {
      environment: {
        NPM_CONFIG_STRICT_SSL: "false",
      },
      runCommand: async (step, context) => {
        observed.push({ step, context });
        if (
          step.kind === "node-identity" ||
          step.kind === "npm-identity"
        ) {
          return executeRaw(step, context);
        }
        if (
          step.id.startsWith("cache-selenium-") ||
          step.id === "apply-selenium-tarballs" ||
          step.id === "install-selenium-candidate"
        ) {
          const raw = await executeRaw(step, context);
          if (step.id === "apply-selenium-tarballs") {
            applyRaw = raw;
          }
          if (step.id === "apply-selenium-tarballs" && raw.exitCode === 0) {
            generatedManifest = JSON.parse(
              await readFile(join(context.packageRoot, "package.json")),
            );
            generatedLock = JSON.parse(
              await readFile(join(context.packageRoot, "package-lock.json")),
            );
          }
          return raw;
        }
        if (step.kind === "browser-identity") {
          return rawResult({ stdout: "Chromium 141.0.7390.54\n" });
        }
        if (step.kind === "driver-identity") {
          return rawResult({
            stdout: "ChromeDriver 141.0.7390.54\n",
          });
        }
        if (step.kind === "command" && step.scenario !== null) {
          await writeCapabilityArtifacts(
            context.workspaceRoot,
            step.capability_id,
            [
              `tests/e2e/selenium/diagnostics/${step.scenario}/result.json`,
            ],
            {
              browser: {
                digest:
                  context.environment.E2E_BROWSER_EXECUTABLE_DIGEST,
                realpath:
                  context.environment.E2E_BROWSER_EXECUTABLE_REALPATH,
                version:
                  context.environment.E2E_BROWSER_EXECUTABLE_VERSION,
              },
              driver: {
                digest:
                  context.environment.E2E_DRIVER_EXECUTABLE_DIGEST,
                realpath:
                  context.environment.E2E_DRIVER_EXECUTABLE_REALPATH,
                version:
                  context.environment.E2E_DRIVER_EXECUTABLE_VERSION,
              },
            },
          );
        }
        return rawResult();
      },
    });

    assert.equal(
      result.validation.disposition.state,
      "independently-qualified",
      JSON.stringify({ applyRaw, result }, null, 2),
    );
    assert.deepEqual(generatedManifest.dependencies, {
      "@axe-core/webdriverjs": "4.15.0",
      "selenium-webdriver": "4.52.0",
    });
    for (const [name, metadata] of Object.entries(localRegistry.metadata)) {
      const locked = generatedLock.packages[`node_modules/${name}`];
      if (name !== "axe-core") {
        assert.equal(
          generatedLock.packages[""].dependencies[name],
          metadata.version,
        );
      }
      assert.equal(locked.version, metadata.version);
      assert.equal(locked.resolved, metadata.dist.tarball);
      assert.equal(locked.integrity, metadata.dist.integrity);
    }
    assert.ok(
      observed.every(
        ({ context }) =>
          context.environment.GITHUB_WORKSPACE === context.workspaceRoot,
      ),
    );
  } finally {
    await localRegistry.cleanup();
    await repository.cleanup();
  }
});

test("caller-supplied statuses or evidence cannot fabricate success", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
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
    const observation = await collectQualificationCandidate(repository);
    const observed = [];
    const runner = passingRunner(observed, { artifacts: false });
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
    const observation = await collectQualificationCandidate(repository);
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

    const aliasResult = await qualify(repository, observation, {
      runCommand: passingRunner([], {
        browser: {
          stdout: "NotChromium 141.0.7390.54 accepted alias\n",
        },
      }),
    });
    assert.deepEqual(aliasResult.validation.disposition, {
      state: "blocked",
      reason_codes: ["RUNNER_EXECUTABLE_IDENTITY_MISMATCH"],
    });
  } finally {
    await repository.cleanup();
  }
});

test("runner executable realpath and digest are checked independently", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    await writeFile(
      repository.runnerEvidence.browser.realpath,
      "#!/bin/sh\nprintf 'Chromium 141.0.7390.54\\n'\n# changed\n",
      { mode: 0o755 },
    );
    const observed = [];
    const result = await qualify(repository, observation, {
      runCommand: passingRunner(observed),
    });

    assert.deepEqual(result.validation.disposition, {
      state: "blocked",
      reason_codes: ["RUNNER_EXECUTABLE_IDENTITY_MISMATCH"],
    });
    assert.ok(
      observed.every(
        ({ step }) => step.id !== "verify-runner-browser",
      ),
    );

    const browserContent = "#!/bin/sh\nprintf 'Chromium 141.0.7390.54\\n'\n";
    await writeFile(
      repository.runnerEvidence.browser.realpath,
      browserContent,
      { mode: 0o755 },
    );
    const redirectedEvidence = structuredClone(repository.runnerEvidence);
    redirectedEvidence.browser.realpath =
      `${redirectedEvidence.browser.realpath}-redirected`;
    const redirected = await collectQualificationCandidate(repository, {
      runnerEvidence: redirectedEvidence,
    });
    const redirectedResult = await qualify(repository, redirected, {
      runCommand: passingRunner([]),
    });
    assert.deepEqual(redirectedResult.validation.disposition, {
      state: "blocked",
      reason_codes: ["RUNNER_EXECUTABLE_IDENTITY_MISMATCH"],
    });
  } finally {
    await repository.cleanup();
  }
});

test("runner replacement after package tests or during a scenario cannot qualify", async () => {
  for (const replacementPoint of ["package-tests", "scenario"]) {
    for (const kind of ["browser", "driver"]) {
      const repository = await createRepository();
      try {
        const observation = await collectQualificationCandidate(repository);
        const runner = passingRunner([]);
        let replaced = false;
        const result = await qualify(repository, observation, {
          runCommand: async (step, context) => {
            const raw = await runner(step, context);
            const replaceNow =
              (replacementPoint === "package-tests" &&
                step.id === "test-selenium-package") ||
              (replacementPoint === "scenario" &&
                step.kind === "command" &&
                step.scenario === "smoke");
            if (replaceNow && !replaced) {
              replaced = true;
              await writeFile(
                repository.runnerEvidence[kind].realpath,
                `#!/bin/sh\nprintf '${kind === "browser" ? "Chromium" : "ChromeDriver"} 141.0.7390.54\\n'\n# replaced\n`,
                { mode: 0o755 },
              );
            }
            return raw;
          },
        });

        assert.equal(replaced, true);
        assert.ok(
          result.validation.disposition.reason_codes.some((code) =>
            [
              "RUNNER_EXECUTABLE_IDENTITY_MISMATCH",
              "CAPABILITY_EXECUTION_FAILED",
            ].includes(code)),
          `${replacementPoint}/${kind}`,
        );
      } finally {
        await repository.cleanup();
      }
    }
  }
});

test("axe-core lock and installed identities are exact and immutable", async () => {
  for (const mutation of ["lock-version", "lock-integrity", "installed"]) {
    const repository = await createRepository();
    try {
      const observation = await collectQualificationCandidate(repository);
      const runner = passingRunner([]);
      const result = await qualify(repository, observation, {
        runCommand: async (step, context) => {
          const raw = await runner(step, context);
          if (
            step.id === "apply-selenium-tarballs" &&
            mutation.startsWith("lock-")
          ) {
            const lockPath = join(context.packageRoot, "package-lock.json");
            const lock = JSON.parse(await readFile(lockPath, "utf8"));
            const axeCore = lock.packages["node_modules/axe-core"];
            if (mutation === "lock-version") {
              axeCore.version = "4.14.0";
            } else {
              axeCore.integrity = "sha512-Zm9yZ2Vk";
            }
            await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
          }
          if (
            step.id === "install-selenium-candidate" &&
            mutation === "installed"
          ) {
            const installedPath = join(
              context.packageRoot,
              "node_modules",
              "axe-core",
              "package.json",
            );
            await writeFile(
              installedPath,
              `${JSON.stringify({
                name: "axe-core",
                version: "4.14.0",
              })}\n`,
            );
          }
          return raw;
        },
      });

      assert.deepEqual(result.validation.disposition, {
        state: "blocked",
        reason_codes: [
          mutation === "installed"
            ? "INSTALLED_PACKAGE_MISMATCH"
            : "LOCK_VERIFICATION_FAILED",
        ],
      });
    } finally {
      await repository.cleanup();
    }
  }
});

test("captured warnings prevent independent admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const result = await qualify(repository, observation, {
      runCommand: passingRunner([], {
        result: (step) =>
          step.id === "test-selenium-package"
            ? {
                stderr: [
                  "WARNING: package emitted a warning",
                  "npm WaRn deprecated package",
                  "Warnings: plural form",
                  "(node:1) DeprecationWarning: deprecated API",
                  "(node:1) ExperimentalWarning: experimental API",
                  "(node:1) MaxListenersExceededWarning: listener leak",
                ].join("\n"),
              }
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
          status === "pass" && warnings.length === 6,
      ),
    );
  } finally {
    await repository.cleanup();
  }
});

test("missing artifacts prevent independent admission", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const observed = [];
    const runner = passingRunner(observed, { artifacts: false });
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

test("report and evidence artifacts cannot escape through symlinks", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    for (const artifactPath of [
      "tests/e2e/selenium/diagnostics/web-calculator/result.png",
      "tests/e2e/selenium/diagnostics/web-calculator/result.json",
    ]) {
      const runner = passingRunner([]);
      const result = await qualify(repository, observation, {
        runCommand: async (step, context) => {
          const raw = await runner(step, context);
          if (
            step.id ===
            "selenium-ubuntu-chromium-artifact-contracts"
          ) {
            const artifact = join(context.workspaceRoot, artifactPath);
            const outside = join(
              dirname(context.workspaceRoot),
              `outside-${artifactPath.endsWith(".json") ? "report.json" : "evidence.png"}`,
            );
            await writeFile(
              outside,
              artifactPath.endsWith(".json")
                ? await readFile(artifact)
                : "outside evidence\n",
            );
            await rm(artifact, { force: true });
            await symlink(outside, artifact);
          }
          return raw;
        },
      });

      assert.ok(
        result.validation.disposition.reason_codes.includes(
          "ARTIFACT_VALIDATION_FAILED",
        ),
      );
      assert.equal(
        result.validation.results.find(
          ({ capability_id: id }) => id === "selenium-ubuntu-chromium",
        ).status,
        "fail",
      );
    }
  } finally {
    await repository.cleanup();
  }
});

test("reports must bijectively cover the selected scenario set", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
    const runner = passingRunner([]);
    const result = await qualify(repository, observation, {
      runCommand: async (step, context) => {
        const raw = await runner(step, context);
        if (
          step.id ===
          "selenium-ubuntu-chromium-artifact-contracts"
        ) {
          const reportPath =
            "tests/e2e/selenium/diagnostics/web-calculator/result.json";
          const report = JSON.parse(
            await readFile(join(context.workspaceRoot, reportPath)),
          );
          report.scenario = "smoke";
          await writeFile(
            join(context.workspaceRoot, reportPath),
            `${JSON.stringify(report)}\n`,
          );
          await writeCapabilityArtifacts(
            context.workspaceRoot,
            step.capability_id,
            [
              "tests/e2e/selenium/diagnostics/unselected/result.json",
            ],
          );
        }
        return raw;
      },
    });

    assert.ok(
      result.validation.disposition.reason_codes.includes(
        "ARTIFACT_VALIDATION_FAILED",
      ),
    );
    assert.equal(
      result.validation.results.find(
        ({ capability_id: id }) => id === "selenium-ubuntu-chromium",
      ).status,
      "fail",
    );
  } finally {
    await repository.cleanup();
  }
});

test("reports reject forged or missing package and runner identities", async () => {
  const mutations = [
    ["tool.version", (report, missing) => {
      if (missing) delete report.tool.version;
      else report.tool.version = "4.51.0";
    }],
    ["tool.accessibility.integrationVersion", (report, missing) => {
      if (missing) delete report.tool.accessibility.integrationVersion;
      else report.tool.accessibility.integrationVersion = "4.14.0";
    }],
    ["tool.accessibility.engineVersion", (report, missing) => {
      if (missing) delete report.tool.accessibility.engineVersion;
      else report.tool.accessibility.engineVersion = "4.14.0";
    }],
    ["environment.browserVersion", (report, missing) => {
      if (missing) delete report.environment.browserVersion;
      else report.environment.browserVersion = "140.0.0.0";
    }],
    ["environment.driverVersion", (report, missing) => {
      if (missing) delete report.environment.driverVersion;
      else report.environment.driverVersion = "140.0.0.0";
    }],
    ["environment.browserExecutable", (report, missing) => {
      if (missing) delete report.environment.browserExecutable;
      else report.environment.browserExecutable.digest = `sha256:${"0".repeat(64)}`;
    }],
    ["environment.driverExecutable", (report, missing) => {
      if (missing) delete report.environment.driverExecutable;
      else report.environment.driverExecutable.realpath = "/tmp/forged-driver";
    }],
  ];

  for (const [field, mutate] of mutations) {
    for (const missing of [false, true]) {
      const repository = await createRepository();
      try {
        const observation = await collectQualificationCandidate(repository);
        const runner = passingRunner([]);
        const result = await qualify(repository, observation, {
          runCommand: async (step, context) => {
            const raw = await runner(step, context);
            if (
              step.id ===
              "selenium-linux-chromium-artifact-contracts"
            ) {
              const reportPath = join(
                context.workspaceRoot,
                "tests/e2e/selenium/diagnostics/smoke/result.json",
              );
              const report = JSON.parse(await readFile(reportPath, "utf8"));
              mutate(report, missing);
              await writeFile(
                reportPath,
                `${JSON.stringify(report, null, 2)}\n`,
              );
            }
            return raw;
          },
        });

        assert.ok(
          result.validation.disposition.reason_codes.includes(
            "ARTIFACT_VALIDATION_FAILED",
          ),
          `${missing ? "missing" : "forged"} ${field}`,
        );
      } finally {
        await repository.cleanup();
      }
    }
  }
});

test("workspace boundary and source mutations fail closed", async () => {
  const repository = await createRepository();
  try {
    const observation = await collectQualificationCandidate(repository);
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
      /modified immutable trusted inputs/u,
    );

    const ignoredRunner = passingRunner([]);
    await assert.rejects(
      qualify(repository, observation, {
        runCommand: async (step, context) => {
          const raw = await ignoredRunner(step, context);
          if (step.id === "test-selenium-package") {
            const ignoredPath = join(
              repository.root,
              "tests",
              "e2e",
              "selenium",
              "diagnostics",
              "source-mutation.txt",
            );
            await mkdir(dirname(ignoredPath), { recursive: true });
            await writeFile(ignoredPath, "mutated ignored source\n");
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
      ...(await qualificationPlanInputs(repository, observation)),
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
