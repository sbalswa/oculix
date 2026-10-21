import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildNodeIndependentValidation,
  collectNodeObservation,
  NODE_CAPABILITY_IDS,
  nodeValidationEvidence,
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

function releaseMetadata(index, checksums = new Map()) {
  return {
    calls: [],
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

test("release source failures remain unavailable", async () => {
  const source = {
    async listReleases() {
      throw new Error("simulated release source outage");
    },
    async readChecksums() {
      assert.fail("checksums must not be requested");
    },
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

test("ephemeral validation plans bind candidate, runner, commands, and commit",
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

    const timestamps = {
      startedAt: "2026-10-21T17:01:00Z",
      completedAt: "2026-10-21T17:02:00Z",
    };
    const evidence = nodeValidationEvidence(plan, observation, timestamps);
    for (const mutation of [
      (copy) => { copy.runner = "macos-latest"; },
      (copy) => {
        copy.commands[1].argv[copy.commands[1].argv.length - 1] =
          "e2e:cypress";
      },
      (copy) => { copy.repository.revision = "1".repeat(40); },
      (copy) => { copy.candidate_digest = "2".repeat(64); },
    ]) {
      const changed = structuredClone(plan);
      mutation(changed);
      if (
        changed.repository.revision === plan.repository.revision &&
        changed.candidate_digest === plan.candidate_digest
      ) {
        assert.notEqual(
          nodeValidationEvidence(changed, observation, timestamps).digest,
          evidence.digest,
        );
      } else {
        assert.throws(
          () => nodeValidationEvidence(changed, observation, timestamps),
          /does not bind the Node observation/,
        );
      }
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
