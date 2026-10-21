import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  canonicalDocument,
  contentDigest,
  evidenceDigest,
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";
import {
  OCULIX_CONFIG_PATH,
  OCULIX_LOCK_PATH,
  OCULIX_LOCK_PLATFORMS,
  OCULIX_QUALIFICATION_CHECKS,
  collectOculixRcObservation,
  compareOculixRcVersions,
  createOculixRcQualificationPlan,
  parseOculixRcTag,
  parseStableOculixVersion,
  prepareOculixRcCandidate,
  qualifyOculixRc,
  selectNewestOculixRc,
} from "./oculix-rc-collector.mjs";

const FIXTURE_ROOT = new URL(
  "../../../tests/dependency-qualification/fixtures/oculix-rc/",
  import.meta.url,
);
const CAPABILITY_PATH = new URL(
  "../../../tests/e2e/capabilities.json",
  import.meta.url,
);
const REPOSITORY_ROOT = resolve(
  new URL("../../..", import.meta.url).pathname,
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
        : (await fixture("mise.oculix.lock")).replace(
            'version = "4.0.0"',
            'version = "4.1.0"',
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
  assert.doesNotThrow(() =>
    validateDocument(observation, contractOptions),
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
});

test("collection is read-only and stable selection stays prerelease-exclusive", async () => {
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
  assert.equal(plan.workspace.kind, "ephemeral-copy");
  assert.equal(Object.isFrozen(plan), true);
});

test("candidate preparation rewrites and relocks only the ephemeral copy", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "oculix-rc-prepare-"));
  const workspacePath = join(temporaryRoot, "workspace");
  const configPath = join(workspacePath, OCULIX_CONFIG_PATH);
  const lockPath = join(workspacePath, OCULIX_LOCK_PATH);
  const originalConfig = await fixture("config.oculix.toml");
  const originalLock = await fixture("mise.oculix.lock");
  const commands = [];
  try {
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await writeFile(configPath, originalConfig);
    await writeFile(lockPath, originalLock);
    const prepared = await prepareOculixRcCandidate({
      candidateVersion: "4.1.0-rc10",
      currentVersion: "4.0.0",
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
      runCommand: async (command) => {
        commands.push(command);
        await writeFile(
          lockPath,
          originalLock.replace(
            'version = "4.0.0"',
            'version = "4.1.0-rc10"',
          ),
        );
        return { stderr: "", stdout: "" };
      },
      workspacePath,
    });
    assert.deepEqual(prepared.changed_paths, [
      OCULIX_CONFIG_PATH,
      OCULIX_LOCK_PATH,
    ]);
    assert.match(prepared.diff_digest, /^sha256:[0-9a-f]{64}$/u);
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
      },
    ]);
    assert.match(await readFile(configPath, "utf8"), /4\.1\.0-rc10/u);
    assert.equal(
      await fixture("config.oculix.toml"),
      originalConfig,
      "the source fixture remains unchanged",
    );
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
        };
      },
      repositoryRoot: REPOSITORY_ROOT,
      runCheck: async (input) => {
        calls.push({ stage: "check", ...input });
        return {
          status: "pass",
          warnings: [],
          output: input.check.id,
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
    qualification.calls
      .filter(({ stage }) => stage === "check")
      .map(({ check }) => check.id),
    ["repository-policy", "oculix-capability"],
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
  assert.deepEqual(
    evidence.slice(1).map(({ revision }) => revision),
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
        runCheck: async ({ check }) =>
          check.id === "repository-policy"
            ? scenario.result
            : { status: "pass", warnings: [], output: "passed" },
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
    prepareCandidate: async () => ({
      changed_paths: [OCULIX_CONFIG_PATH, OCULIX_LOCK_PATH],
      diff_digest:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }),
  });
  const { validation: changedDiff } = await second.promise;
  assert.notEqual(evidenceDigest(baseline), evidenceDigest(changedDiff));
  assert.notEqual(contentDigest(baseline), contentDigest(changedDiff));
});
