import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildNodeIndependentValidation,
  collectNodeObservation,
  NODE_CAPABILITY_IDS,
  planNodeIndependentValidation,
} from "./node-collector.mjs";
import {
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const FIXTURES = resolve(
  REPOSITORY_ROOT,
  "tests/dependency-qualification/fixtures/node",
);
const CAPABILITY_PATH = resolve(
  REPOSITORY_ROOT,
  "tests/e2e/capabilities.json",
);
const REPOSITORY = {
  name: "sbalswa/oculix",
  revision: "d460a7e8ce751eb772d1b3120e5508bbecaa7bff",
};
const GENERATED_AT = "2026-10-21T17:00:00Z";

async function fixture(name) {
  return readFile(resolve(FIXTURES, name), "utf8");
}

function releaseMetadata(
  index,
  checksums = new Map(),
  {
    indexUrl = "https://node.example.test/releases/index.json",
    releaseBaseUrl = "https://node.example.test/dist",
  } = {},
) {
  return {
    calls: [],
    indexUrl,
    async listReleases() {
      this.calls.push(["listReleases"]);
      return index;
    },
    async readChecksums(version) {
      this.calls.push(["readChecksums", version]);
      if (!checksums.has(version)) {
        throw new Error(`unexpected checksum request for ${version}`);
      }
      return checksums.get(version);
    },
    releaseBaseUrl,
  };
}

async function collectWith(source, options = {}) {
  return collectNodeObservation({
    capabilityCatalogPath: CAPABILITY_PATH,
    configPath: "config.web-e2e.toml",
    generatedAt: GENERATED_AT,
    lockPath: "mise.web-e2e.lock",
    releaseMetadata: source,
    repository: REPOSITORY,
    repositoryRoot: FIXTURES,
    ...options,
  });
}

async function contractOptions() {
  const catalog = await readCapabilityCatalog(CAPABILITY_PATH);
  return {
    capabilityIds: catalog.ids,
    capabilityCatalogDigest: catalog.digest,
  };
}

function component(document, id) {
  return document.components.find((entry) => entry.id === id);
}

test("reports requested and resolved Node versions separately when current",
  async () => {
    const source = releaseMetadata(await fixture("releases.current.json"));
    const observation = await collectWith(source);

    assert.equal(observation.disposition.state, "current");
    assert.deepEqual(observation.disposition.reason_codes, ["NO_CANDIDATE"]);
    assert.equal(component(observation, "node-release-channel").current.version,
      "24");
    assert.equal(component(observation, "node-runtime").current.version,
      "24.22.0");
    assert.equal(component(observation, "node-runtime").candidate, null);
    assert.deepEqual(source.calls, [["listReleases"]]);
    assert.equal(validateDocument(observation, await contractOptions()),
      observation);
  });

test("selects one deterministic same-channel candidate with platform evidence",
  async () => {
    const index = await fixture("releases.candidate.json");
    const checksums = await fixture("SHASUMS256-v24.23.0.txt");
    const firstSource = releaseMetadata(
      index,
      new Map([["24.23.0", checksums]]),
    );
    const first = await collectWith(firstSource);

    const reorderedIndex = JSON.stringify(
      JSON.parse(index).reverse().map((release) => ({
        files: [...release.files].reverse(),
        lts: release.lts,
        date: release.date,
        version: release.version,
      })),
    );
    const reorderedChecksums = checksums
      .trim()
      .split("\n")
      .reverse()
      .join("\n");
    const second = await collectWith(
      releaseMetadata(
        reorderedIndex,
        new Map([["24.23.0", reorderedChecksums]]),
      ),
    );

    assert.deepEqual(second, first);
    assert.equal(first.disposition.state, "candidate");
    assert.equal(component(first, "node-runtime").candidate.version,
      "24.23.0");
    assert.deepEqual(firstSource.calls, [
      ["listReleases"],
      ["readChecksums", "24.23.0"],
    ]);

    const currentArtifacts = component(first, "node-runtime")
      .current.evidence
      .filter(({ type }) => type === "locked-release-artifact");
    const candidateArtifacts = component(first, "node-runtime")
      .candidate.evidence
      .filter(({ type }) => type === "upstream-release-artifact");
    assert.deepEqual(
      currentArtifacts.map(({ revision }) => revision),
      [
        "v24.22.0:linux-arm64",
        "v24.22.0:linux-x64",
        "v24.22.0:macos-arm64",
        "v24.22.0:windows-arm64",
        "v24.22.0:windows-x64",
      ],
    );
    assert.deepEqual(
      candidateArtifacts.map(({ revision }) => revision),
      [
        "v24.23.0:linux-arm64",
        "v24.23.0:linux-x64",
        "v24.23.0:macos-arm64",
        "v24.23.0:windows-arm64",
        "v24.23.0:windows-x64",
      ],
    );
    assert.deepEqual(
      component(first, "node-runtime").affected_capabilities,
      NODE_CAPABILITY_IDS,
    );
    assert.equal(validateDocument(first, await contractOptions()), first);
  });

test("malformed release metadata fails closed as unavailable", async () => {
  const observation = await collectWith(
    releaseMetadata(await fixture("releases.malformed.json")),
  );

  assert.equal(observation.disposition.state, "unavailable");
  assert.deepEqual(observation.disposition.reason_codes,
    ["RELEASE_METADATA_MALFORMED"]);
  assert.equal(component(observation, "node-runtime").candidate, null);
  assert.equal(validateDocument(observation, await contractOptions()),
    observation);
  });

test("empty, duplicate, conflicting, and unsafe release records are unavailable",
  async () => {
    const candidate = JSON.parse(await fixture("releases.candidate.json"))[1];
    const malformedIndexes = [
      [],
      [candidate, structuredClone(candidate)],
      [
        candidate,
        {
          ...structuredClone(candidate),
          date: "2026-10-20",
          files: candidate.files.slice(1),
        },
      ],
      [{
        ...structuredClone(candidate),
        version: "v24.9007199254740992.0",
      }],
    ];

    for (const index of malformedIndexes) {
      const observation = await collectWith(
        releaseMetadata(JSON.stringify(index)),
      );
      assert.equal(observation.disposition.state, "unavailable");
      assert.deepEqual(observation.disposition.reason_codes,
        ["RELEASE_METADATA_MALFORMED"]);
      assert.equal(component(observation, "node-runtime").candidate, null);
    }
  });

test("release source failures remain unavailable", async () => {
  const source = {
    indexUrl: "https://node.example.test/releases/index.json",
    async listReleases() {
      throw new Error("simulated release source outage");
    },
    async readChecksums() {
      assert.fail("checksums must not be requested");
    },
    releaseBaseUrl: "https://node.example.test/dist",
  };
  const observation = await collectWith(source);

  assert.equal(observation.disposition.state, "unavailable");
  assert.deepEqual(observation.disposition.reason_codes,
    ["RELEASE_SOURCE_UNAVAILABLE"]);
  assert.equal(component(observation, "node-runtime").candidate, null);
  assert.equal(validateDocument(observation, await contractOptions()),
    observation);
  });

test("missing candidate artifact checksums fail closed", async () => {
  const checksums = (await fixture("SHASUMS256-v24.23.0.txt"))
    .split("\n")
    .filter((line) => !line.includes("win-x64.zip"))
    .join("\n");
  const observation = await collectWith(
    releaseMetadata(
      await fixture("releases.candidate.json"),
      new Map([["24.23.0", checksums]]),
    ),
  );

  assert.equal(observation.disposition.state, "unavailable");
  assert.deepEqual(observation.disposition.reason_codes,
    ["RELEASE_METADATA_MALFORMED"]);
  assert.equal(component(observation, "node-runtime").candidate, null);
  });

test("lock platform labels must match unique effective artifacts",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-platform-lock-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const config = await fixture("config.web-e2e.toml");
    const lock = await fixture("mise.web-e2e.lock");
    const source = releaseMetadata(await fixture("releases.current.json"));
    await writeFile(join(directory, "config.toml"), config);

    const mismatched = lock.replace(
      'platforms.windows-x64"',
      'platforms.windows-amd64"',
    );
    await writeFile(join(directory, "mismatched.lock"), mismatched);
    await assert.rejects(
      collectNodeObservation({
        capabilityCatalogPath: CAPABILITY_PATH,
        configPath: "config.toml",
        generatedAt: GENERATED_AT,
        lockPath: "mismatched.lock",
        releaseMetadata: source,
        repository: REPOSITORY,
        repositoryRoot: directory,
      }),
      /platform windows-amd64 does not match artifact windows-x64/,
    );

    const linuxX64Block = lock.match(
      /\[tools\.node\."platforms\.linux-x64"\][\s\S]*?url = "[^"]+"\n/u,
    )[0];
    await writeFile(
      join(directory, "duplicate.lock"),
      `${lock.trimEnd()}\n\n${linuxX64Block}`,
    );
    await assert.rejects(
      collectNodeObservation({
        capabilityCatalogPath: CAPABILITY_PATH,
        configPath: "config.toml",
        generatedAt: GENERATED_AT,
        lockPath: "duplicate.lock",
        releaseMetadata: source,
        repository: REPOSITORY,
        repositoryRoot: directory,
      }),
      /duplicate effective Node artifacts/,
    );
  });

test("platform headers accept comments but reject unsupported syntax and case",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-platform-headers-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const config = await fixture("config.web-e2e.toml");
    const lock = await fixture("mise.web-e2e.lock");
    await writeFile(join(directory, "config.toml"), config);

    const commented = lock.replace(
      /^(\[tools\.node\."platforms\.[^"]+"\])$/gmu,
      "$1 # supported lock target",
    );
    await writeFile(join(directory, "commented.lock"), commented);
    const observation = await collectNodeObservation({
      capabilityCatalogPath: CAPABILITY_PATH,
      configPath: "config.toml",
      generatedAt: GENERATED_AT,
      lockPath: "commented.lock",
      releaseMetadata: releaseMetadata(
        await fixture("releases.current.json"),
      ),
      repository: REPOSITORY,
      repositoryRoot: directory,
    });
    assert.equal(
      component(observation, "node-runtime").current.evidence.filter(
        ({ type }) => type === "locked-release-artifact",
      ).length,
      5,
    );

    const invalidLocks = [
      lock.replace(
        'platforms.windows-x64"',
        'platforms.Windows-X64"',
      ),
      lock.replace(
        '[tools.node."platforms.windows-x64"]',
        "[tools.node.platforms.windows-x64]",
      ),
      lock.replace(
        '[tools.node."platforms.windows-x64"]',
        '[tools . node . "platforms.windows-x64"]',
      ),
      lock.replace(
        '[tools.node."platforms.windows-x64"]',
        '[tools.nod."platforms.windows-x64"]',
      ),
      lock.replace(
        '[tools.node."platforms.windows-x64"]',
        '[tools.node."platforms.windows-x64"',
      ),
    ];
    for (const [index, invalid] of invalidLocks.entries()) {
      const path = `invalid-${index}.lock`;
      await writeFile(join(directory, path), invalid);
      await assert.rejects(
        collectNodeObservation({
          capabilityCatalogPath: CAPABILITY_PATH,
          configPath: "config.toml",
          generatedAt: GENERATED_AT,
          lockPath: path,
          releaseMetadata: releaseMetadata(
            await fixture("releases.current.json"),
          ),
          repository: REPOSITORY,
          repositoryRoot: directory,
        }),
        /unsupported Node header|malformed header/,
      );
    }
  });

test("lock artifact URLs require the exact canonical Node pathname",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-artifact-path-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await Promise.all([
      writeFile(
        join(directory, "config.toml"),
        await fixture("config.web-e2e.toml"),
      ),
      writeFile(
        join(directory, "noncanonical.lock"),
        (await fixture("mise.web-e2e.lock")).replace(
          "https://nodejs.org/dist/v24.22.0/" +
            "node-v24.22.0-linux-arm64.tar.gz",
          "https://nodejs.org/mirror/dist/v24.22.0/" +
            "node-v24.22.0-linux-arm64.tar.gz",
        ),
      ),
    ]);

    await assert.rejects(
      collectNodeObservation({
        capabilityCatalogPath: CAPABILITY_PATH,
        configPath: "config.toml",
        generatedAt: GENERATED_AT,
        lockPath: "noncanonical.lock",
        releaseMetadata: releaseMetadata(
          await fixture("releases.current.json"),
        ),
        repository: REPOSITORY,
        repositoryRoot: directory,
      }),
      /URL does not bind Node 24\.22\.0/,
    );
  });

test("duplicate or conflicting keys fail in tool and platform blocks",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-duplicate-keys-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const lock = await fixture("mise.web-e2e.lock");
    await writeFile(
      join(directory, "config.toml"),
      await fixture("config.web-e2e.toml"),
    );
    const invalidLocks = [
      lock.replace(
        'version = "24.22.0"',
        'version = "24.22.0"\nversion = "24.22.0"',
      ),
      lock.replace(
        'version = "24.22.0"',
        'version = "24.22.0"\nversion = "24.21.0"',
      ),
      lock.replace(
        "checksum = " +
          '"sha256:f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3"',
        "checksum = " +
          '"sha256:f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3"' +
          "\nchecksum = " +
          '"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      ),
      lock.replace(
        'url = "https://nodejs.org/dist/v24.22.0/' +
          'node-v24.22.0-win-x64.zip"',
        'url = "https://nodejs.org/dist/v24.22.0/' +
          'node-v24.22.0-win-x64.zip"\n' +
          'url = "https://nodejs.org/dist/v24.22.0/' +
          'node-v24.22.0-win-arm64.zip"',
      ),
    ];

    for (const [index, invalid] of invalidLocks.entries()) {
      const path = `duplicate-${index}.lock`;
      await writeFile(join(directory, path), invalid);
      await assert.rejects(
        collectNodeObservation({
          capabilityCatalogPath: CAPABILITY_PATH,
          configPath: "config.toml",
          generatedAt: GENERATED_AT,
          lockPath: path,
          releaseMetadata: releaseMetadata(
            await fixture("releases.current.json"),
          ),
          repository: REPOSITORY,
          repositoryRoot: directory,
        }),
        /duplicate key (version|checksum|url)/,
      );
    }
  });

test("repository-file evidence rejects symlinks escaping repositoryRoot",
  async (context) => {
    const outside = await mkdtemp(join(tmpdir(), "node-outside-"));
    context.after(() => rm(outside, { force: true, recursive: true }));
    const config = await fixture("config.web-e2e.toml");
    const lock = await fixture("mise.web-e2e.lock");
    await Promise.all([
      writeFile(join(outside, "config.toml"), config),
      writeFile(join(outside, "runtime.lock"), lock),
    ]);

    for (const escaped of ["config", "lock"]) {
      const directory = await mkdtemp(join(tmpdir(), `node-${escaped}-link-`));
      context.after(() => rm(directory, { force: true, recursive: true }));
      const configPath = escaped === "config" ? "config-link.toml" : "config.toml";
      const lockPath = escaped === "lock" ? "lock-link.toml" : "runtime.lock";
      if (escaped === "config") {
        await symlink(join(outside, "config.toml"), join(directory, configPath));
        await writeFile(join(directory, lockPath), lock);
      } else {
        await writeFile(join(directory, configPath), config);
        await symlink(join(outside, "runtime.lock"), join(directory, lockPath));
      }

      await assert.rejects(
        collectNodeObservation({
          capabilityCatalogPath: CAPABILITY_PATH,
          configPath,
          generatedAt: GENERATED_AT,
          lockPath,
          releaseMetadata: releaseMetadata(
            await fixture("releases.current.json"),
          ),
          repository: REPOSITORY,
          repositoryRoot: directory,
        }),
        /escapes repositoryRoot through a symlink/,
      );
    }
  });

test("configurable repository paths and release locators remain evidence",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-locators-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await mkdir(join(directory, "policy"), { recursive: true });
    await mkdir(join(directory, "locks"), { recursive: true });
    await Promise.all([
      writeFile(
        join(directory, "policy/runtime.toml"),
        await fixture("config.web-e2e.toml"),
      ),
      writeFile(
        join(directory, "locks/runtime.lock"),
        await fixture("mise.web-e2e.lock"),
      ),
    ]);
    const indexUrl = "https://metadata.example.test/node/releases.json";
    const releaseBaseUrl = "https://artifacts.example.test/node";
    const observation = await collectNodeObservation({
      capabilityCatalogPath: CAPABILITY_PATH,
      configPath: "policy/runtime.toml",
      generatedAt: GENERATED_AT,
      lockPath: "locks/runtime.lock",
      releaseMetadata: releaseMetadata(
        await fixture("releases.candidate.json"),
        new Map([[
          "24.23.0",
          await fixture("SHASUMS256-v24.23.0.txt"),
        ]]),
        { indexUrl, releaseBaseUrl },
      ),
      repository: REPOSITORY,
      repositoryRoot: directory,
    });

    const channel = component(observation, "node-release-channel");
    const runtime = component(observation, "node-runtime");
    assert.equal(channel.current.evidence[0].locator, "policy/runtime.toml");
    assert.deepEqual(channel.eventual_managed_paths, ["policy/runtime.toml"]);
    assert.equal(runtime.current.evidence[0].locator, "locks/runtime.lock");
    assert.deepEqual(runtime.eventual_managed_paths, ["locks/runtime.lock"]);
    assert.equal(
      runtime.candidate.evidence.find(
        ({ type }) => type === "upstream-release-index",
      ).locator,
      indexUrl,
    );
    assert.equal(
      runtime.candidate.evidence.find(
        ({ type }) => type === "upstream-release-checksums",
      ).locator,
      `${releaseBaseUrl}/v24.23.0/SHASUMS256.txt`,
    );
    assert.ok(
      runtime.candidate.evidence
        .filter(({ type }) => type === "upstream-release-artifact")
        .every(({ locator }) => locator.startsWith(
          `${releaseBaseUrl}/v24.23.0/`,
        )),
    );
  });

test("collection never mutates config, lockfiles, or unrelated files",
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "node-collector-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const config = await fixture("config.web-e2e.toml");
    const lock = await fixture("mise.web-e2e.lock");
    const sentinel = "unrelated state must remain byte-identical\n";
    await Promise.all([
      writeFile(join(directory, "config.web-e2e.toml"), config),
      writeFile(join(directory, "mise.web-e2e.lock"), lock),
      writeFile(join(directory, "sentinel.txt"), sentinel),
    ]);

    await collectNodeObservation({
      capabilityCatalogPath: CAPABILITY_PATH,
      configPath: "config.web-e2e.toml",
      generatedAt: GENERATED_AT,
      lockPath: "mise.web-e2e.lock",
      releaseMetadata: releaseMetadata(
        await fixture("releases.candidate.json"),
        new Map([[
          "24.23.0",
          await fixture("SHASUMS256-v24.23.0.txt"),
        ]]),
      ),
      repository: REPOSITORY,
      repositoryRoot: directory,
    });

    assert.equal(await readFile(join(directory, "config.web-e2e.toml"), "utf8"),
      config);
    assert.equal(await readFile(join(directory, "mise.web-e2e.lock"), "utf8"),
      lock);
    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"),
      sentinel);
  });

test("qualification rejects every forged prescribed-plan field",
  async () => {
    const observation = await collectWith(
      releaseMetadata(
        await fixture("releases.candidate.json"),
        new Map([[
          "24.23.0",
          await fixture("SHASUMS256-v24.23.0.txt"),
        ]]),
      ),
    );
    const plan = await planNodeIndependentValidation(observation, {
      capabilityCatalogPath: CAPABILITY_PATH,
      capabilityId: "selenium-ubuntu-chromium",
      repositoryRoot: REPOSITORY_ROOT,
    });

    assert.equal(plan.candidate_digest, subjectDigest(observation));
    assert.equal(plan.repository.revision, REPOSITORY.revision);
    assert.equal(plan.runner, "ubuntu-latest");
    assert.deepEqual(plan.environment, {
      MISE_LOCKED: "0",
      MISE_NODE_VERSION: "24.23.0",
    });
    assert.deepEqual(plan.commands[0].argv, [
      "mise",
      "exec",
      "node@24.23.0",
      "--",
      "mise",
      "run",
      "ci",
    ]);
    assert.deepEqual(plan.commands[1].argv.slice(-4), [
      "-E",
      "web-e2e",
      "run",
      "e2e:selenium",
    ]);
    assert.equal(plan.git_state_guard.require_unchanged, true);

    const execution = {
      plan,
      status: "pass",
      warnings: [],
      startedAt: "2026-10-21T17:01:00Z",
      completedAt: "2026-10-21T17:02:00Z",
    };
    for (const mutation of [
      (copy) => { copy.unexpected = undefined; },
      (copy) => { copy.runner = "macos-latest"; },
      (copy) => { copy.candidate.tool = "node@24.22.0"; },
      (copy) => { copy.candidate.version = "24.22.0"; },
      (copy) => { copy.candidate.mode = "repository-relock"; },
      (copy) => {
        copy.commands[1].argv[copy.commands[1].argv.length - 1] =
          "e2e:cypress";
      },
      (copy) => { copy.environment.MISE_NODE_VERSION = "24.22.0"; },
      (copy) => { copy.environment.EXTRA = "forged"; },
      (copy) => { copy.git_state_guard.require_unchanged = false; },
      (copy) => { copy.git_state_guard.argv = ["git", "status", "--short"]; },
      (copy) => { copy.repository.revision = "1".repeat(40); },
      (copy) => { copy.candidate_digest = "2".repeat(64); },
    ]) {
      const forged = structuredClone(execution);
      mutation(forged.plan);
      await assert.rejects(
        buildNodeIndependentValidation(observation, [forged], {
          capabilityCatalogPath: CAPABILITY_PATH,
          generatedAt: "2026-10-21T17:20:00Z",
          repositoryRoot: REPOSITORY_ROOT,
        }),
        /does not match the prescribed plan/,
      );
    }
  });

test("complete mocked executions produce contract-valid independent evidence",
  async () => {
    const observation = await collectWith(
      releaseMetadata(
        await fixture("releases.candidate.json"),
        new Map([[
          "24.23.0",
          await fixture("SHASUMS256-v24.23.0.txt"),
        ]]),
      ),
    );
    const executions = await Promise.all(
      NODE_CAPABILITY_IDS.map(async (capabilityId, index) => ({
        plan: await planNodeIndependentValidation(observation, {
          capabilityCatalogPath: CAPABILITY_PATH,
          capabilityId,
          repositoryRoot: REPOSITORY_ROOT,
        }),
        status: "pass",
        warnings: [],
        startedAt: `2026-10-21T17:0${index}:00Z`,
        completedAt: `2026-10-21T17:1${index}:00Z`,
      })),
    );
    const validation = await buildNodeIndependentValidation(
      observation,
      executions,
      {
        capabilityCatalogPath: CAPABILITY_PATH,
        generatedAt: "2026-10-21T17:20:00Z",
        repositoryRoot: REPOSITORY_ROOT,
      },
    );
    const options = await contractOptions();

    assert.equal(validation.disposition.state, "independently-qualified");
    assert.deepEqual(
      validation.results.map(({ capability_id: id }) => id).sort(),
      [...NODE_CAPABILITY_IDS].sort(),
    );
    assert.equal(validateIndependentQualification(
      observation,
      validation,
      options,
    ), validation);
  });

test("current observations cannot be planned for independent validation",
  async () => {
    const observation = await collectWith(
      releaseMetadata(await fixture("releases.current.json")),
    );
    await assert.rejects(
      planNodeIndependentValidation(observation, {
        capabilityCatalogPath: CAPABILITY_PATH,
        capabilityId: "selenium-ubuntu-chromium",
        repositoryRoot: REPOSITORY_ROOT,
      }),
      /requires a candidate observation/,
    );
  });
