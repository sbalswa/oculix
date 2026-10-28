import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  canonicalDocument,
  contentDigest,
  evidenceDigest,
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
  validateProviderSet,
} from "./contract.mjs";
import {
  OCULIX_CONFIG_PATH,
  OCULIX_JAVA_COMPONENT_ID,
  OCULIX_LOCK_PATH,
  OCULIX_LOCK_PLATFORMS,
  OCULIX_QUALIFICATION_CHECKS,
  OculixJavaRuntimeIncompatibilityError,
  classifyOculixWarnings,
  collectOculixRcObservation,
  compareOculixRcVersions,
  createEphemeralOculixWorkspace,
  createOculixRcQualificationPlan,
  executeOculixQualificationCheck,
  observeOculixJavaRuntime,
  parseOculixRcTag,
  parseOculixJavaIdentity,
  parseStableOculixVersion,
  prepareOculixRcCandidate,
  qualifyOculixRc,
  selectNewestOculixRc,
} from "./oculix-rc-collector.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/oculix-rc/",
  import.meta.url,
);
const CAPABILITY_PATH = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);
const REPOSITORY = {
  name: "sbalswa/oculix",
  revision: "1234567890abcdef1234567890abcdef12345678",
};
const GENERATED_AT = "2026-10-21T16:00:00Z";
const RUNNER = {
  name: "ubuntu-latest",
  os: "linux",
  arch: "arm64",
};
const DIFF_DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const execFile = promisify(execFileCallback);

async function fixture(name) {
  return readFile(new URL(name, FIXTURE_ROOT), "utf8");
}

async function jsonFixture(name) {
  return JSON.parse(await fixture(name));
}

const capabilityCatalog = await readCapabilityCatalog(CAPABILITY_PATH);
const contractOptions = {
  capabilityCatalogDigest: capabilityCatalog.digest,
  capabilityIds: capabilityCatalog.ids,
};

async function collectorInputs(overrides = {}) {
  const files = new Map([
    [OCULIX_CONFIG_PATH, await fixture("config.oculix.toml")],
    [OCULIX_LOCK_PATH, await fixture("mise.oculix.lock")],
  ]);
  const releases = await jsonFixture("releases.json");
  const revisions = await jsonFixture("tag-revisions.json");
  return {
    capabilityCatalog: {
      schema_version: capabilityCatalog.schemaVersion,
      digest: capabilityCatalog.digest,
    },
    generatedAt: GENERATED_AT,
    listReleases: async () => structuredClone(releases),
    readRepositoryFile: async (path) => files.get(path),
    repository: REPOSITORY,
    resolveTagRevision: async (tag) => revisions[tag],
    ...overrides,
  };
}

async function candidateObservation(overrides = {}) {
  return collectOculixRcObservation(await collectorInputs(overrides));
}

function component(observation, id) {
  return observation.components.find((entry) => entry.id === id);
}

function generatedCandidateLock(lockContents) {
  return lockContents
    .replace('version = "4.0.0"', 'version = "4.1.0-rc10"')
    .replace(
      'specifiers = ["4.0.0"]',
      'specifiers = ["4.1.0-rc10"]',
    )
    .replaceAll(
      "releases/download/v4.0.0/oculixide-4.0.0-linux.jar",
      "releases/download/v4.1.0-rc10/oculixide-4.1.0-rc10-linux.jar",
    )
    .replaceAll(
      "releases/download/v4.0.0/oculixide-4.0.0-macos.jar",
      "releases/download/v4.1.0-rc10/oculixide-4.1.0-rc10-macos.jar",
    )
    .replaceAll(
      "releases/download/v4.0.0/oculixide-4.0.0-windows.jar",
      "releases/download/v4.1.0-rc10/oculixide-4.1.0-rc10-windows.jar",
    );
}

function javaRuntimeOutput({
  vendor = "Eclipse Adoptium",
  version = "17.0.20.1+1",
} = {}) {
  return [
    "Property settings:",
    `    java.runtime.version = ${version}`,
    `    java.vendor = ${vendor}`,
    'openjdk version "17.0.20.1" 2026-10-20',
  ].join("\n");
}

function isolatedMiseEnvironment(workspacePath) {
  return {
    MISE_CONFIG_DIR: `${workspacePath}-mise-config`,
    MISE_STATE_DIR: `${workspacePath}-mise-state`,
    MISE_TRUSTED_CONFIG_PATHS: workspacePath,
  };
}

test("strict RC parsing rejects lookalikes and leading zeroes", () => {
  assert.deepEqual(parseOculixRcTag("v4.1.0-rc10"), {
    major: 4n,
    minor: 1n,
    patch: 0n,
    rc: 10n,
    tag: "v4.1.0-rc10",
    version: "4.1.0-rc10",
  });
  assert.deepEqual(parseOculixRcTag("4.1.0-rc1"), {
    major: 4n,
    minor: 1n,
    patch: 0n,
    rc: 1n,
    tag: "4.1.0-rc1",
    version: "4.1.0-rc1",
  });
  for (const malformed of [
    "v4.1-rc1",
    "v4.1.0.0-rc1",
    "v4.1.0-RC1",
    "v4.1.0-rc",
    "v4.1.0-rc0",
    "v4.1.0-rc01",
    "v04.1.0-rc1",
    "v4.1.0-rc1+build",
    "release-v4.1.0-rc1",
  ]) {
    assert.equal(parseOculixRcTag(malformed), null, malformed);
  }
  assert.throws(
    () => parseStableOculixVersion("v4.0.0"),
    /must match N.N.N exactly/,
  );
});

test("RC ordering is numeric across versions and multi-digit RCs", () => {
  assert.equal(
    compareOculixRcVersions("v4.1.0-rc10", "v4.1.0-rc9"),
    1,
  );
  assert.equal(
    compareOculixRcVersions("v4.10.0-rc1", "v4.2.99-rc99"),
    1,
  );
  assert.equal(
    compareOculixRcVersions(
      "v9007199254740993.0.0-rc1",
      "v9007199254740992.999.999-rc999",
    ),
    1,
  );
});

test("selection ignores stable, draft, malformed, old, and non-RC releases", async () => {
  const releases = await jsonFixture("releases.json");
  const selected = selectNewestOculixRc(releases, "4.0.0");
  assert.equal(selected.version, "4.1.0-rc10");
  assert.equal(selected.release.id, 410);
  assert.equal(
    selected.release.published_at,
    "2026-10-21T15:59:59Z",
    "fresh RCs are not subject to the stable release-age gate",
  );
});

test("no RC newer than stable produces no candidate", async () => {
  const releases = await jsonFixture("releases.json");
  assert.equal(selectNewestOculixRc(releases, "4.1.0"), null);
  const observation = await candidateObservation({
    listReleases: async () => releases,
    readRepositoryFile: async (path) =>
      path === OCULIX_CONFIG_PATH
        ? (await fixture("config.oculix.toml")).replaceAll(
            "4.0.0",
            "4.1.0",
          )
        : (await fixture("mise.oculix.lock")).replaceAll(
            "4.0.0",
            "4.1.0",
          ),
  });
  assert.equal(observation.disposition.state, "current");
  assert.equal(observation.components[0].candidate, null);
});

test("duplicate releases for the newest numeric RC fail closed", async () => {
  const releases = await jsonFixture("releases.json");
  releases.push({
    ...structuredClone(releases[0]),
    id: 999,
    tag_name: "4.1.0-rc10",
  });
  assert.throws(
    () => selectNewestOculixRc(releases, "4.0.0"),
    /Multiple releases claim newest Oculix RC/,
  );
});

test("strictly parses the configured and resolved Temurin identity", async () => {
  const identity = parseOculixJavaIdentity(
    await fixture("config.oculix.toml"),
    await fixture("mise.oculix.lock"),
  );
  assert.equal(identity.specifier, "temurin-17");
  assert.equal(identity.major, "17");
  assert.equal(identity.resolved_version, "17.0.20+101");
  assert.equal(identity.runtime_version, "17.0.20.1+1");
  assert.equal(identity.runtime_vendor, "Eclipse Adoptium");
  assert.equal(identity.solver_version, "17.0.20");
  assert.match(
    identity.runtime_identity_digest,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(
    identity.platforms.map(({ platform }) => platform),
    [...OCULIX_LOCK_PLATFORMS].sort(),
  );
  assert.match(identity.identity_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(identity), true);
});

test("collector publishes a frozen contract observation with immutable evidence", async () => {
  const observation = await candidateObservation();
  assert.equal(observation.disposition.state, "candidate");
  assert.equal(
    observation.components[0].candidate.version,
    "4.1.0-rc10",
  );
  assert.deepEqual(
    observation.components[0].candidate.evidence.map(({ type }) => type),
    [
      "github-release",
      "git-tag",
      "github-release-asset",
      "github-release-asset",
      "github-release-asset",
    ],
  );
  assert.equal(
    observation.components[0].candidate.evidence[1].revision,
    "1111111111111111111111111111111111111111",
  );
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.components[0].candidate), true);
  const java = component(observation, OCULIX_JAVA_COMPONENT_ID);
  assert.equal(java.current.version, "17.0.20");
  assert.equal(java.candidate, null);
  assert.deepEqual(
    java.current.evidence.map(({ type }) => type),
    [
      "temurin-policy",
      "locked-java-runtime",
      "locked-java-artifact",
      "locked-java-artifact",
      "locked-java-artifact",
      "locked-java-artifact",
    ],
  );
  assert.deepEqual(observation.relations, [
    {
      id: "oculix-rc-requires-java-runtime",
      type: "shares-runtime",
      from: "oculix-release-candidate",
      to: OCULIX_JAVA_COMPONENT_ID,
      hard: true,
      constraint: ">=17.0.0 <18.0.0",
    },
  ]);
  assert.doesNotThrow(() =>
    validateDocument(observation, contractOptions),
  );
  assert.doesNotThrow(() =>
    validateProviderSet([observation], contractOptions),
  );
});

test("Java metadata is strict and never selects a Java candidate", async (context) => {
  await context.test("configured major mismatch", async () => {
    let queriedReleases = false;
    const inputs = await collectorInputs({
      listReleases: async () => {
        queriedReleases = true;
        return [];
      },
    });
    await assert.rejects(
      collectOculixRcObservation({
        ...inputs,
        readRepositoryFile: async (path) =>
          path === OCULIX_CONFIG_PATH
            ? (await fixture("config.oculix.toml")).replace(
                "temurin-17",
                "temurin-21",
              )
            : fixture("mise.oculix.lock"),
      }),
      /Java version must resolve temurin-21/,
    );
    assert.equal(queriedReleases, false);
  });
  await context.test("missing platform evidence", async () => {
    const config = await fixture("config.oculix.toml");
    const lock = (await fixture("mise.oculix.lock")).replace(
      /\n\[tools\.java\."platforms\.windows-x64"\][\s\S]*$/u,
      "",
    ) +
      '\n# [tools.java."platforms.windows-x64"]\n' +
      '# checksum = "sha256:4444444444444444444444444444444444444444444444444444444444444444"\n' +
      '# url = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip"\n';
    assert.throws(
      () =>
        parseOculixJavaIdentity(
          config,
          lock,
        ),
      /must lock every supported platform exactly once/,
    );
  });
  await context.test("artifact release build drift", async () => {
    const config = await fixture("config.oculix.toml");
    const lock = (await fixture("mise.oculix.lock")).replace(
      "jdk-17.0.20.1%2B1",
      "jdk-17.0.20.1%2B2",
    );
    assert.throws(
      () => parseOculixJavaIdentity(config, lock),
      /does not bind temurin-17\.0\.20\+101/,
    );
  });
  await context.test("artifact filename build drift", async () => {
    const config = await fixture("config.oculix.toml");
    const lock = (await fixture("mise.oculix.lock")).replace(
      "17.0.20.1_1.tar.gz",
      "17.0.20.1_2.tar.gz",
    );
    assert.throws(
      () => parseOculixJavaIdentity(config, lock),
      /filename does not bind 17\.0\.20\.1\+1/,
    );
  });
  const observation = await candidateObservation();
  assert.equal(
    observation.components.filter(
      ({ id, candidate }) =>
        id === OCULIX_JAVA_COMPONENT_ID && candidate !== null,
    ).length,
    0,
  );
});

test("release and asset input order cannot change canonical evidence", async () => {
  const releases = await jsonFixture("releases.json");
  const reversed = structuredClone(releases).reverse();
  reversed.forEach((release) => release.assets?.reverse());
  const forward = await candidateObservation({
    listReleases: async () => releases,
  });
  const backward = await candidateObservation({
    listReleases: async () => reversed,
  });
  assert.equal(canonicalDocument(forward), canonicalDocument(backward));
  assert.equal(subjectDigest(forward), subjectDigest(backward));
  assert.equal(evidenceDigest(forward), evidenceDigest(backward));
});

test("source errors remain unavailable instead of becoming no-update", async () => {
  const observation = await candidateObservation({
    listReleases: async () => {
      throw new Error("rate limited");
    },
  });
  assert.deepEqual(observation.disposition, {
    state: "unavailable",
    reason_codes: ["OCULIX_RC_SOURCE_UNAVAILABLE"],
  });
  assert.equal(observation.components[0].candidate, null);
  assert.doesNotThrow(() =>
    validateDocument(observation, contractOptions),
  );
});

test("missing tag or required asset evidence fails closed", async (context) => {
  await context.test("tag resolution", async () => {
    const observation = await candidateObservation({
      resolveTagRevision: async () => null,
    });
    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["OCULIX_RC_EVIDENCE_UNAVAILABLE"],
    });
  });
  await context.test("asset digest", async () => {
    const releases = await jsonFixture("releases.json");
    delete releases[0].assets[0].digest;
    const observation = await candidateObservation({
      listReleases: async () => releases,
    });
    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["OCULIX_RC_EVIDENCE_UNAVAILABLE"],
    });
  });
  await context.test("asset origin", async () => {
    const releases = await jsonFixture("releases.json");
    releases[0].assets[0].browser_download_url =
      "https://example.invalid/oculixide.jar";
    const observation = await candidateObservation({
      listReleases: async () => releases,
    });
    assert.deepEqual(observation.disposition, {
      state: "unavailable",
      reason_codes: ["OCULIX_RC_EVIDENCE_UNAVAILABLE"],
    });
  });
});

test("stable and RC selectors remain behaviorally isolated", async () => {
  const reads = [];
  const stableScriptPath = resolve(
    REPOSITORY_ROOT,
    ".github/scripts/toolchain-maintenance",
  );
  const before = await readFile(stableScriptPath, "utf8");
  const inputs = await collectorInputs();
  await collectOculixRcObservation({
    ...inputs,
    readRepositoryFile: async (path) => {
      reads.push(path);
      return inputs.readRepositoryFile(path);
    },
  });
  const after = await readFile(stableScriptPath, "utf8");
  assert.deepEqual(reads.sort(), [
    OCULIX_CONFIG_PATH,
    OCULIX_LOCK_PATH,
  ]);
  assert.equal(after, before);
  assert.match(
    after,
    /\.prerelease == false/u,
    "stable release selection must continue rejecting prereleases",
  );
  const stableSelection = await execFile(
    "bash",
    [
      "-c",
      String.raw`
        source "$1"
        date() {
          case "$*" in
            *"days ago"*) printf '2000000000\n' ;;
            *) printf '1000000000\n' ;;
          esac
        }
        gh() {
          printf 'v5.0.0-rc1\t2026-01-01T00:00:00Z\n'
          printf 'v4.0.1\t2026-01-01T00:00:00Z\n'
        }
        latest_eligible_release "oculix-org/Oculix" "4.0.0"
      `,
      "bash",
      stableScriptPath,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "sbalswa/oculix",
      },
    },
  );
  assert.equal(stableSelection.stdout, "4.0.1");
  const releases = await jsonFixture("releases.json");
  assert.equal(
    selectNewestOculixRc(releases, "4.0.0").version,
    "4.1.0-rc10",
  );
});

test("qualification plan binds candidate, commit, runner, lock platforms, and checks", async () => {
  const observation = await candidateObservation();
  const plan = createOculixRcQualificationPlan({
    observation,
    runner: RUNNER,
  });
  assert.equal(plan.candidate_digest, subjectDigest(observation));
  assert.equal(plan.repository.revision, REPOSITORY.revision);
  assert.deepEqual(plan.runner, RUNNER);
  assert.deepEqual(plan.lock.platforms, OCULIX_LOCK_PLATFORMS);
  assert.deepEqual(plan.checks, OCULIX_QUALIFICATION_CHECKS);
  assert.deepEqual(
    {
      major: plan.java.major,
      resolved_version: plan.java.resolved_version,
      specifier: plan.java.specifier,
    },
    {
      major: "17",
      resolved_version: "17.0.20+101",
      specifier: "temurin-17",
    },
  );
  assert.match(plan.java.identity_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(plan.java.runtime_version, "17.0.20.1+1");
  assert.match(
    plan.java.runtime_identity_digest,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(
    plan.oculix_assets.map(({ platform }) => platform),
    OCULIX_LOCK_PLATFORMS,
  );
  assert.equal(plan.lock.command.includes("--bump"), false);
  assert.equal(plan.workspace.kind, "ephemeral-git-archive");
  assert.equal(Object.isFrozen(plan), true);
});

test("qualification identity changes with any locked Java artifact", async () => {
  const baseline = await candidateObservation();
  const changedLock = (await fixture("mise.oculix.lock")).replace(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const changed = await candidateObservation({
    readRepositoryFile: async (path) =>
      path === OCULIX_LOCK_PATH
        ? changedLock
        : fixture("config.oculix.toml"),
  });
  const baselinePlan = createOculixRcQualificationPlan({
    observation: baseline,
    runner: RUNNER,
  });
  const changedPlan = createOculixRcQualificationPlan({
    observation: changed,
    runner: RUNNER,
  });
  assert.notEqual(subjectDigest(baseline), subjectDigest(changed));
  assert.notEqual(
    baselinePlan.java.identity_digest,
    changedPlan.java.identity_digest,
  );
  assert.notEqual(
    baselinePlan.candidate_digest,
    changedPlan.candidate_digest,
  );
});

test("candidate preparation rewrites and relocks only the ephemeral copy", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "oculix-rc-prepare-"));
  const workspacePath = join(temporaryRoot, "workspace");
  const configPath = join(workspacePath, OCULIX_CONFIG_PATH);
  const lockPath = join(workspacePath, OCULIX_LOCK_PATH);
  const originalConfig = await fixture("config.oculix.toml");
  const originalLock = await fixture("mise.oculix.lock");
  const plan = createOculixRcQualificationPlan({
    observation: await candidateObservation(),
    runner: RUNNER,
  });
  const javaIdentity = plan.java;
  const miseEnvironment = isolatedMiseEnvironment(workspacePath);
  const commands = [];
  try {
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await writeFile(configPath, originalConfig);
    await writeFile(lockPath, originalLock);
    const prepared = await prepareOculixRcCandidate({
      candidateAssets: plan.oculix_assets,
      candidateVersion: "4.1.0-rc10",
      currentVersion: "4.0.0",
      javaIdentity,
      lockCommand: [
        "mise",
        "-E",
        "oculix",
        "lock",
        "--platform",
        OCULIX_LOCK_PLATFORMS.join(","),
        "java",
        "http:oculixide",
      ],
      managedPaths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
      miseEnvironment,
      runCommand: async (command) => {
        commands.push(command);
        await writeFile(
          lockPath,
          generatedCandidateLock(originalLock),
        );
        return {
          stderr: "warning: lock metadata warning\n",
          stdout: "",
        };
      },
      workspacePath,
    });
    assert.deepEqual(prepared.changed_paths, [
      OCULIX_CONFIG_PATH,
      OCULIX_LOCK_PATH,
    ]);
    assert.match(prepared.diff_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(
      prepared.java_identity_digest,
      javaIdentity.identity_digest,
    );
    assert.deepEqual(prepared.warnings, [
      "warning: lock metadata warning",
    ]);
    assert.deepEqual(commands, [
      {
        command: "mise",
        args: [
          "-E",
          "oculix",
          "lock",
          "--platform",
          OCULIX_LOCK_PLATFORMS.join(","),
          "java",
          "http:oculixide",
        ],
        cwd: workspacePath,
        environment: miseEnvironment,
      },
    ]);
    assert.match(await readFile(configPath, "utf8"), /4\.1\.0-rc10/u);
    assert.equal(
      await fixture("config.oculix.toml"),
      originalConfig,
      "the source fixture remains unchanged",
    );
    await writeFile(configPath, originalConfig);
    await writeFile(lockPath, originalLock);
    await assert.rejects(
      prepareOculixRcCandidate({
        candidateAssets: plan.oculix_assets,
        candidateVersion: "4.1.0-rc10",
        currentVersion: "4.0.0",
        javaIdentity,
        lockCommand: [
          "mise",
          "-E",
          "oculix",
          "lock",
          "--platform",
          OCULIX_LOCK_PLATFORMS.join(","),
          "java",
          "http:oculixide",
        ],
        managedPaths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
        miseEnvironment,
        runCommand: async () => {
          await writeFile(
            lockPath,
            generatedCandidateLock(originalLock)
              .replace(
                "temurin-17.0.20+101",
                "temurin-21.0.1+1",
              ),
          );
          return { stderr: "", stdout: "" };
        },
        workspacePath,
      }),
      (error) =>
        error instanceof OculixJavaRuntimeIncompatibilityError &&
        /review-gated Java runtime/u.test(error.message),
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("generated lock evidence must be structural and exact", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "oculix-rc-lock-"));
  const workspacePath = join(temporaryRoot, "workspace");
  const configPath = join(workspacePath, OCULIX_CONFIG_PATH);
  const lockPath = join(workspacePath, OCULIX_LOCK_PATH);
  const originalConfig = await fixture("config.oculix.toml");
  const originalLock = await fixture("mise.oculix.lock");
  const plan = createOculixRcQualificationPlan({
    observation: await candidateObservation(),
    runner: RUNNER,
  });
  const miseEnvironment = isolatedMiseEnvironment(workspacePath);
  async function prepareWith(
    generatedLock,
    candidateAssets = plan.oculix_assets,
  ) {
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await writeFile(configPath, originalConfig);
    await writeFile(lockPath, originalLock);
    return prepareOculixRcCandidate({
      candidateAssets,
      candidateVersion: plan.candidate_version,
      currentVersion: "4.0.0",
      javaIdentity: plan.java,
      lockCommand: plan.lock.command,
      managedPaths: plan.workspace.managed_paths,
      miseEnvironment,
      runCommand: async () => {
        await writeFile(lockPath, generatedLock);
        return { stderr: "", stdout: "" };
      },
      workspacePath,
    });
  }
  try {
    await context.test("comments and substrings are not records", async () => {
      const fakeEvidence =
        `${originalLock}\n` +
        `# version = "${plan.candidate_version}"\n` +
        plan.oculix_assets
          .map(
            ({ digest, platform, url }) =>
              `# [tools."http:oculixide"."platforms.${platform}"]\n` +
              `# checksum = "${digest}"\n# url = "${url}"`,
          )
          .join("\n");
      await assert.rejects(
        prepareWith(fakeEvidence),
        /structurally lock Oculix 4\.1\.0-rc10/,
      );
    });
    await context.test("a URL hidden in another value is rejected", async () => {
      const generated = generatedCandidateLock(originalLock);
      const expectedUrl = plan.oculix_assets.find(
        ({ platform }) => platform === "linux-x64",
      ).url;
      await assert.rejects(
        prepareWith(
          generated.replace(
            `url = "${expectedUrl}"`,
            `note = "${expectedUrl}"`,
          ),
        ),
        /must contain one url/,
      );
    });
    await context.test("realistic URL-only records are accepted", async () => {
      const generated = generatedCandidateLock(originalLock);
      const oculixRecords = generated.slice(
        0,
        generated.indexOf("[[tools.java]]"),
      );
      assert.equal(oculixRecords.includes("checksum ="), false);
      await assert.doesNotReject(prepareWith(generated));
    });
    await context.test("wrong candidate URL is rejected", async () => {
      await assert.rejects(
        prepareWith(
          generatedCandidateLock(originalLock).replace(
            "oculixide-4.1.0-rc10-linux.jar",
            "oculixide-4.1.0-rc10-macos.jar",
          ),
        ),
        /exact immutable candidate asset URL/,
      );
    });
    await context.test("incomplete expected assets cannot bypass checks", async () => {
      await assert.rejects(
        prepareWith(
          generatedCandidateLock(originalLock),
          plan.oculix_assets.slice(1),
        ),
        /requires every candidate asset/,
      );
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("ephemeral workspaces archive the exact clean Git revision", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "oculix-rc-source-"));
  const sourcePath = join(temporaryRoot, "source");
  const trackedPath = join(sourcePath, "tracked.txt");
  const misePath = join(sourcePath, "mise.toml");
  async function git(...args) {
    return execFile("git", args, { cwd: sourcePath });
  }
  try {
    await mkdir(sourcePath);
    await git("init", "--quiet");
    await git("config", "user.name", "Oculix RC test");
    await git("config", "user.email", "oculix-rc@example.invalid");
    // Match repository policy and keep git archive byte-identical to the
    // committed blob. With autocrlf=true, Windows git archive emits CRLF.
    await git("config", "core.autocrlf", "false");
    await writeFile(trackedPath, "claimed revision\n");
    await writeFile(
      misePath,
      '[env]\nARCHIVED_REVISION = "claimed"\n',
    );
    await git("add", "tracked.txt", "mise.toml");
    await git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "first");
    const claimedRevision = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(trackedPath, "newer clean revision\n");
    await writeFile(
      misePath,
      '[env]\nARCHIVED_REVISION = "newer"\n',
    );
    await git("add", "tracked.txt", "mise.toml");
    await git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "second");

    const workspace = await createEphemeralOculixWorkspace({
      repositoryRoot: sourcePath,
      revision: claimedRevision,
    });
    try {
      assert.equal(
        await readFile(join(workspace.path, "tracked.txt"), "utf8"),
        "claimed revision\n",
      );
      assert.deepEqual(
        Object.keys(workspace.mise_environment).sort(),
        [
          "MISE_CONFIG_DIR",
          "MISE_STATE_DIR",
          "MISE_TRUSTED_CONFIG_PATHS",
        ],
      );
      assert.equal(
        workspace.mise_environment.MISE_TRUSTED_CONFIG_PATHS,
        workspace.path,
      );
      // --json avoids shell-specific export syntax (bash KEY=val vs
      // PowerShell ${Env:KEY}='val') that mise env defaults to on Windows.
      const miseEnvironment = await execFile(
        "mise",
        ["-C", workspace.path, "env", "--json"],
        {
          env: {
            ...process.env,
            ...workspace.mise_environment,
            MISE_PARANOID: "1",
          },
        },
      );
      const archivedEnv = JSON.parse(miseEnvironment.stdout);
      assert.equal(archivedEnv.ARCHIVED_REVISION, "claimed");
    } finally {
      await workspace.dispose();
    }

    await context.test("untracked source is rejected", async () => {
      const untrackedPath = join(sourcePath, "untracked.txt");
      await writeFile(untrackedPath, "not committed\n");
      await assert.rejects(
        createEphemeralOculixWorkspace({
          repositoryRoot: sourcePath,
          revision: claimedRevision,
        }),
        /must be clean, including untracked files/,
      );
      await rm(untrackedPath);
    });
    await context.test("dirty tracked source is rejected", async () => {
      await writeFile(trackedPath, "dirty live tree\n");
      await assert.rejects(
        createEphemeralOculixWorkspace({
          repositoryRoot: sourcePath,
          revision: claimedRevision,
        }),
        /must be clean, including untracked files/,
      );
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

function successfulQualification(overrides = {}) {
  const calls = [];
  let disposed = false;
  const promise = candidateObservation().then((observation) =>
    qualifyOculixRc({
      contractOptions,
      createWorkspace: async () => ({
        ephemeral: true,
        mise_environment: isolatedMiseEnvironment(
          "/tmp/oculix-rc-test-workspace",
        ),
        path: "/tmp/oculix-rc-test-workspace",
        async dispose() {
          disposed = true;
        },
      }),
      generatedAt: "2026-10-21T16:10:00Z",
      observation,
      prepareCandidate: async (input) => {
        calls.push({ stage: "prepare", ...input });
        return {
          changed_paths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
          diff_digest: DIFF_DIGEST,
          java_identity_digest: input.javaIdentity.identity_digest,
        };
      },
      repositoryRoot: REPOSITORY_ROOT,
      runCheck: async (input) => {
        calls.push({ stage: "check", ...input });
        return {
          status: "pass",
          warnings: [],
          output: input.check.id,
          java_identity_digest:
            input.plan.java.runtime_identity_digest,
        };
      },
      runner: RUNNER,
      ...overrides,
    }).then((validation) => ({ observation, validation })),
  );
  return {
    calls,
    disposed: () => disposed,
    promise,
  };
}

test("real command warning forms are captured and block qualification", async () => {
  assert.deepEqual(
    classifyOculixWarnings({
      stdout: [
        "warning: compiler warning",
        "::warning file=test.mjs::annotation",
        "mise WARN config files in archived directories require trust",
        "ExperimentalWarning: feature may change",
        "CoMpOuNdWaRnInGs: multiple concerns",
        "ordinary output mentioning warning without punctuation",
      ].join("\n"),
      stderr: [
        "[WARNING] Maven warning",
        "[WARNINGS] plural warning group",
        "npm WARN deprecated dependency",
        "script.py:2: DeprecationWarning: old API",
      ].join("\n"),
    }),
    [
      "warning: compiler warning",
      "::warning file=test.mjs::annotation",
      "mise WARN config files in archived directories require trust",
      "ExperimentalWarning: feature may change",
      "CoMpOuNdWaRnInGs: multiple concerns",
      "[WARNING] Maven warning",
      "[WARNINGS] plural warning group",
      "npm WARN deprecated dependency",
      "script.py:2: DeprecationWarning: old API",
    ],
  );
  const qualification = successfulQualification({
    runCheck: (input) =>
      executeOculixQualificationCheck({
        ...input,
        runCommand: async ({ args }) =>
          args.includes("-XshowSettings:properties")
            ? { stderr: javaRuntimeOutput(), stdout: "" }
            : {
                stderr: "mise WARN command completed with a warning\n",
                stdout: "",
              },
      }),
  });
  const { validation } = await qualification.promise;
  assert.deepEqual(validation.disposition, {
    state: "blocked",
    reason_codes: ["OCULIX_RC_VALIDATION_WARNING"],
  });
  assert.deepEqual(validation.results[0].warnings, [
    "mise WARN command completed with a warning",
  ]);
  const preparationWarning = successfulQualification({
    prepareCandidate: async ({ javaIdentity }) => ({
      changed_paths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
      diff_digest: DIFF_DIGEST,
      java_identity_digest: javaIdentity.identity_digest,
      warnings: ["warning: lock metadata warning"],
    }),
  });
  const { validation: preparationValidation } =
    await preparationWarning.promise;
  assert.deepEqual(preparationValidation.disposition, {
    state: "blocked",
    reason_codes: ["OCULIX_RC_VALIDATION_WARNING"],
  });
});

test("execution observes the actual Java runtime identity", async () => {
  const observation = await candidateObservation();
  const plan = createOculixRcQualificationPlan({
    observation,
    runner: RUNNER,
  });
  const observed = await observeOculixJavaRuntime({
    runCommand: async () => ({
      stderr: javaRuntimeOutput(),
      stdout: "",
    }),
    workspacePath: "/tmp/oculix-runtime-observation",
  });
  assert.equal(observed.runtime_version, plan.java.runtime_version);
  assert.equal(observed.runtime_vendor, plan.java.runtime_vendor);
  assert.equal(
    observed.identity_digest,
    plan.java.runtime_identity_digest,
  );
  let observedEnvironment;
  const executed = await executeOculixQualificationCheck({
    check: plan.checks[0],
    plan,
    runCommand: async ({ args, environment }) => {
      if (args.includes("-XshowSettings:properties")) {
        observedEnvironment = environment;
        return { stderr: javaRuntimeOutput(), stdout: "" };
      }
      return { stderr: "", stdout: "check passed\n" };
    },
    workspacePath: "/tmp/oculix-runtime-observation",
  });
  assert.deepEqual(observedEnvironment, plan.checks[0].environment);
  assert.equal(
    executed.java_identity_digest,
    plan.java.runtime_identity_digest,
  );
});

test("observed Java runtime drift has the stable incompatibility reason", async () => {
  const qualification = successfulQualification({
    runCheck: (input) =>
      executeOculixQualificationCheck({
        ...input,
        runCommand: async ({ args }) =>
          args.includes("-XshowSettings:properties")
            ? {
                stderr: javaRuntimeOutput({
                  version: "17.0.20.1+2",
                }),
                stdout: "",
              }
            : { stderr: "", stdout: "check passed\n" },
      }),
  });
  const { validation } = await qualification.promise;
  assert.deepEqual(validation.disposition, {
    state: "incompatible",
    reason_codes: ["OCULIX_RC_JAVA_RUNTIME_INCOMPATIBLE"],
  });
});

test("qualification mutates only an external ephemeral workspace", async () => {
  const qualification = successfulQualification();
  const { observation, validation } = await qualification.promise;
  assert.equal(validation.disposition.state, "independently-qualified");
  assert.equal(qualification.disposed(), true);
  assert.equal(
    qualification.calls[0].workspacePath,
    "/tmp/oculix-rc-test-workspace",
  );
  assert.deepEqual(
    qualification.calls[0].miseEnvironment,
    isolatedMiseEnvironment("/tmp/oculix-rc-test-workspace"),
  );
  assert.deepEqual(
    qualification.calls
      .filter(({ stage }) => stage === "check")
      .map(({ check }) => check.id),
    ["repository-policy", "oculix-capability"],
  );
  assert.equal(
    qualification.calls
      .filter(({ stage }) => stage === "check")
      .every(
        ({ miseEnvironment }) =>
          miseEnvironment.MISE_TRUSTED_CONFIG_PATHS ===
          "/tmp/oculix-rc-test-workspace",
      ),
    true,
  );
  assert.doesNotThrow(() =>
    validateIndependentQualification(
      observation,
      validation,
      contractOptions,
    ),
  );
  const evidence = validation.results[0].evidence;
  assert.equal(evidence[0].type, "generated-lock-diff");
  assert.equal(evidence[0].digest, DIFF_DIGEST);
  assert.equal(evidence[1].type, "java-runtime-identity");
  assert.deepEqual(
    evidence.slice(2).map(({ revision }) => revision),
    [REPOSITORY.revision, REPOSITORY.revision],
  );
});

test("failed, warning, and unknown checks cannot independently qualify", async (context) => {
  for (const scenario of [
    {
      name: "failure",
      result: { status: "fail", warnings: [], output: "failed" },
    },
    {
      name: "warning",
      result: {
        status: "pass",
        warnings: ["warning annotation"],
        output: "warned",
      },
    },
    {
      name: "unknown",
      result: { status: "unknown", warnings: [], output: "unknown" },
    },
  ]) {
    await context.test(scenario.name, async () => {
      const qualification = successfulQualification({
        runCheck: async ({ check, plan }) => ({
          ...(check.id === "repository-policy"
            ? scenario.result
            : { status: "pass", warnings: [], output: "passed" }),
          java_identity_digest: plan.java.runtime_identity_digest,
        }),
      });
      const { validation } = await qualification.promise;
      assert.equal(validation.disposition.state, "blocked");
      assert.notEqual(
        validation.disposition.state,
        "independently-qualified",
      );
      assert.doesNotThrow(() =>
        validateDocument(validation, contractOptions),
      );
    });
  }
});

test("missing execution Java identity cannot qualify", async () => {
  const qualification = successfulQualification({
    runCheck: async ({ check }) => ({
      status: "pass",
      warnings: [],
      output: check.id,
    }),
  });
  const { validation } = await qualification.promise;
  assert.deepEqual(validation.disposition, {
    state: "unavailable",
    reason_codes: ["OCULIX_RC_VALIDATION_UNAVAILABLE"],
  });
});

test("preparation failures stay blocked and always dispose the workspace", async () => {
  const qualification = successfulQualification({
    prepareCandidate: async () => {
      throw new Error("lock refresh failed");
    },
  });
  const { validation } = await qualification.promise;
  assert.deepEqual(validation.disposition, {
    state: "blocked",
    reason_codes: ["OCULIX_RC_PREPARATION_FAILED"],
  });
  assert.equal(validation.results[0].status, "blocked");
  assert.equal(qualification.disposed(), true);
  assert.doesNotThrow(() =>
    validateDocument(validation, contractOptions),
  );
});

test("Java incompatibility has one stable preparation and execution reason", async (context) => {
  await context.test("preparation", async () => {
    const qualification = successfulQualification({
      prepareCandidate: async () => ({
        changed_paths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
        diff_digest: DIFF_DIGEST,
        java_identity_digest:
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      }),
    });
    const { validation } = await qualification.promise;
    assert.deepEqual(validation.disposition, {
      state: "incompatible",
      reason_codes: ["OCULIX_RC_JAVA_RUNTIME_INCOMPATIBLE"],
    });
  });
  await context.test("execution", async () => {
    const qualification = successfulQualification({
      runCheck: async ({ check, plan }) => ({
        status: "pass",
        warnings: [],
        output: check.id,
        java_compatible: check.id !== "repository-policy",
        java_identity_digest: plan.java.runtime_identity_digest,
      }),
    });
    const { validation } = await qualification.promise;
    assert.deepEqual(validation.disposition, {
      state: "incompatible",
      reason_codes: ["OCULIX_RC_JAVA_RUNTIME_INCOMPATIBLE"],
    });
    assert.equal(validation.results[0].status, "fail");
    assert.doesNotThrow(() =>
      validateDocument(validation, contractOptions),
    );
  });
});

test("root or in-tree workspaces are rejected before preparation", async () => {
  let prepared = false;
  const qualification = successfulQualification({
    createWorkspace: async () => ({
      ephemeral: true,
      path: REPOSITORY_ROOT,
      async dispose() {},
    }),
    prepareCandidate: async () => {
      prepared = true;
    },
  });
  const { validation } = await qualification.promise;
  assert.equal(prepared, false);
  assert.deepEqual(validation.disposition, {
    state: "unavailable",
    reason_codes: ["OCULIX_RC_WORKSPACE_UNAVAILABLE"],
  });
});

test("candidate or generated diff changes validation evidence identity", async () => {
  const first = successfulQualification();
  const { validation: baseline } = await first.promise;
  const second = successfulQualification({
    prepareCandidate: async ({ javaIdentity }) => ({
      changed_paths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
      diff_digest:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      java_identity_digest: javaIdentity.identity_digest,
    }),
  });
  const { validation: changedDiff } = await second.promise;
  assert.notEqual(evidenceDigest(baseline), evidenceDigest(changedDiff));
  assert.notEqual(contentDigest(baseline), contentDigest(changedDiff));
});
