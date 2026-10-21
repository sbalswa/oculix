import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  readCapabilityCatalog,
  subjectDigest,
  validateDocument,
  validateIndependentQualification,
} from "./contract.mjs";

export const NODE_PROVIDER_ID = "node";
export const NODE_CONFIG_PATH = "mise/config.web-e2e.toml";
export const NODE_LOCK_PATH = "mise/mise.web-e2e.lock";
export const NODE_RELEASE_INDEX_URL = "https://nodejs.org/dist/index.json";
export const NODE_CAPABILITY_IDS = Object.freeze([
  "cypress-ubuntu-chrome",
  "oculix-ubuntu-chromium",
  "playwright-ubuntu-chromium",
  "selenium-ubuntu-chromium",
]);

const NODE_RELEASE_BASE_URL = "https://nodejs.org/dist";
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PLATFORM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const REPOSITORY_REVISION_PATTERN = /^[0-9a-f]{40}$/u;

class NodeReleaseMetadataError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value) {
  return `sha256:${sha256(value)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableDigest(value) {
  return prefixedSha256(JSON.stringify(stableValue(value)));
}

function metadataError(message) {
  throw new NodeReleaseMetadataError(message);
}

function parseSemver(value, context) {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${context} must be a stable semantic version`);
  }
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left, left);
  const rightParts = parseSemver(right, right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function parseRequestedChannel(config) {
  const lines = config.split(/\r?\n/u);
  let inTools = false;
  const values = [];
  for (const line of lines) {
    if (/^\s*\[tools\]\s*(?:#.*)?$/u.test(line)) {
      inTools = true;
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      inTools = false;
      continue;
    }
    if (!inTools) {
      continue;
    }
    const match =
      /^\s*node\s*=\s*(["'])([^"']+)\1\s*(?:#.*)?$/u.exec(line);
    if (match !== null) {
      values.push(match[2]);
    }
  }
  if (values.length !== 1 || !/^[1-9]\d*$/u.test(values[0])) {
    throw new Error(
      `${NODE_CONFIG_PATH} must contain one numeric Node release channel`,
    );
  }
  return values[0];
}

function parseTomlString(block, key, context) {
  const expression = new RegExp(
    `^\\s*${key}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?$`,
    "mu",
  );
  const match = expression.exec(block);
  if (match === null) {
    throw new Error(`${context} must contain ${key}`);
  }
  return match[1];
}

function parseSpecifierArray(block) {
  const match = /^\s*specifiers\s*=\s*(\[[^\n]+\])\s*(?:#.*)?$/mu.exec(
    block,
  );
  if (match === null) {
    throw new Error(`${NODE_LOCK_PATH} must contain Node specifiers`);
  }
  let specifiers;
  try {
    specifiers = JSON.parse(match[1]);
  } catch {
    throw new Error(`${NODE_LOCK_PATH} contains invalid Node specifiers`);
  }
  if (
    !Array.isArray(specifiers) ||
    specifiers.length === 0 ||
    specifiers.some((specifier) => typeof specifier !== "string")
  ) {
    throw new Error(`${NODE_LOCK_PATH} contains invalid Node specifiers`);
  }
  return specifiers;
}

function releaseToken(filename) {
  let match = /^node-v\d+\.\d+\.\d+-(linux)-(arm64|x64)\.tar\.gz$/u.exec(
    filename,
  );
  if (match !== null) {
    return `${match[1]}-${match[2]}`;
  }
  match = /^node-v\d+\.\d+\.\d+-darwin-(arm64|x64)\.tar\.gz$/u.exec(
    filename,
  );
  if (match !== null) {
    return `osx-${match[1]}-tar`;
  }
  match = /^node-v\d+\.\d+\.\d+-win-(arm64|x64)\.zip$/u.exec(filename);
  if (match !== null) {
    return `win-${match[1]}-zip`;
  }
  throw new Error(
    `${NODE_LOCK_PATH} contains an unsupported Node artifact ${filename}`,
  );
}

function parseLock(lock, requestedChannel) {
  const toolHeader = "[[tools.node]]";
  const starts = [];
  let offset = lock.indexOf(toolHeader);
  while (offset !== -1) {
    starts.push(offset);
    offset = lock.indexOf(toolHeader, offset + toolHeader.length);
  }
  if (starts.length !== 1) {
    throw new Error(`${NODE_LOCK_PATH} must contain one Node tool record`);
  }

  const toolStart = starts[0] + toolHeader.length;
  const nextHeader = lock.indexOf("\n[", toolStart);
  const toolBlock = lock.slice(
    toolStart,
    nextHeader === -1 ? lock.length : nextHeader,
  );
  const version = parseTomlString(toolBlock, "version", NODE_LOCK_PATH);
  parseSemver(version, `${NODE_LOCK_PATH} Node version`);
  const backend = parseTomlString(toolBlock, "backend", NODE_LOCK_PATH);
  if (backend !== "core:node") {
    throw new Error(`${NODE_LOCK_PATH} Node backend must be core:node`);
  }
  const specifiers = parseSpecifierArray(toolBlock);
  if (!specifiers.includes(requestedChannel)) {
    throw new Error(
      `${NODE_LOCK_PATH} does not resolve requested channel ${requestedChannel}`,
    );
  }
  if (String(parseSemver(version, version)[0]) !== requestedChannel) {
    throw new Error(
      `${NODE_LOCK_PATH} resolved version is outside channel ${requestedChannel}`,
    );
  }

  const platforms = [];
  const platformExpression =
    /^\[tools\.node\."platforms\.([a-z0-9-]+)"\]\s*$/gmu;
  const matches = [...lock.matchAll(platformExpression)];
  for (const [index, match] of matches.entries()) {
    const platform = match[1];
    if (!PLATFORM_PATTERN.test(platform)) {
      throw new Error(`${NODE_LOCK_PATH} contains invalid platform ${platform}`);
    }
    const blockStart = match.index + match[0].length;
    const blockEnd =
      index + 1 < matches.length ? matches[index + 1].index : lock.length;
    const block = lock.slice(blockStart, blockEnd);
    const checksum = parseTomlString(block, "checksum", platform);
    if (!checksum.startsWith("sha256:") ||
        !SHA256_PATTERN.test(checksum.slice("sha256:".length))) {
      throw new Error(`${NODE_LOCK_PATH} contains invalid ${platform} checksum`);
    }
    const url = parseTomlString(block, "url", platform);
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`${NODE_LOCK_PATH} contains invalid ${platform} URL`);
    }
    const filename = parsedUrl.pathname.split("/").at(-1);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "nodejs.org" ||
      !parsedUrl.pathname.includes(`/dist/v${version}/`) ||
      !filename.includes(`node-v${version}-`)
    ) {
      throw new Error(
        `${NODE_LOCK_PATH} ${platform} URL does not bind Node ${version}`,
      );
    }
    platforms.push({
      checksum,
      filename,
      platform,
      releaseToken: releaseToken(filename),
      url,
    });
  }
  if (platforms.length === 0) {
    throw new Error(`${NODE_LOCK_PATH} must contain Node platform records`);
  }
  platforms.sort((left, right) => left.platform.localeCompare(right.platform));
  if (new Set(platforms.map(({ platform }) => platform)).size !==
      platforms.length) {
    throw new Error(`${NODE_LOCK_PATH} contains duplicate Node platforms`);
  }
  return { platforms, version };
}

function parseReleaseDate(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    metadataError("Node release date is malformed");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== value) {
    metadataError("Node release date is malformed");
  }
  return value;
}

function parseReleaseIndex(raw) {
  let releases = raw;
  if (typeof raw === "string") {
    try {
      releases = JSON.parse(raw);
    } catch {
      metadataError("Node release index is not valid JSON");
    }
  }
  if (!Array.isArray(releases)) {
    metadataError("Node release index must be an array");
  }
  return releases.map((release) => {
    if (release === null || typeof release !== "object" ||
        Array.isArray(release)) {
      metadataError("Node release index contains a non-object record");
    }
    if (typeof release.version !== "string" ||
        !release.version.startsWith("v")) {
      metadataError("Node release version is malformed");
    }
    const version = release.version.slice(1);
    try {
      parseSemver(version, release.version);
    } catch {
      metadataError("Node release version is malformed");
    }
    if (
      !Array.isArray(release.files) ||
      release.files.some((file) => typeof file !== "string" || file === "") ||
      new Set(release.files).size !== release.files.length
    ) {
      metadataError(`Node ${release.version} files are malformed`);
    }
    if (
      release.lts !== undefined &&
      typeof release.lts !== "boolean" &&
      typeof release.lts !== "string"
    ) {
      metadataError(`Node ${release.version} LTS metadata is malformed`);
    }
    return {
      date: parseReleaseDate(release.date),
      files: [...release.files].sort(),
      lts: release.lts ?? false,
      version,
    };
  });
}

function candidateArtifact(platform, currentVersion, candidateVersion) {
  const filename = platform.filename.replace(
    `node-v${currentVersion}-`,
    `node-v${candidateVersion}-`,
  );
  const url = platform.url
    .replace(`/v${currentVersion}/`, `/v${candidateVersion}/`)
    .replace(
      `node-v${currentVersion}-`,
      `node-v${candidateVersion}-`,
    );
  return { ...platform, filename, url };
}

function parseChecksums(raw, version) {
  if (typeof raw !== "string") {
    metadataError(`Node v${version} checksums must be text`);
  }
  const checksums = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    const match = /^([0-9a-f]{64})\s+(\S+)$/u.exec(line);
    if (match === null || checksums.has(match[2])) {
      metadataError(`Node v${version} checksums are malformed`);
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0) {
    metadataError(`Node v${version} checksums are empty`);
  }
  return checksums;
}

function selectCandidate(releases, requestedChannel, currentVersion, platforms,
  generatedAt) {
  const expectedTokens = new Set(
    platforms.map(({ releaseToken: token }) => token),
  );
  return releases
    .filter((release) =>
      String(parseSemver(release.version, release.version)[0]) ===
        requestedChannel &&
      compareSemver(release.version, currentVersion) > 0 &&
      release.date <= generatedAt.slice(0, 10) &&
      [...expectedTokens].every((token) => release.files.includes(token)),
    )
    .sort((left, right) => compareSemver(right.version, left.version))[0] ??
    null;
}

function repositoryFileEvidence(path, content, revision, observedAt) {
  return {
    type: "repository-file",
    locator: path,
    revision,
    digest: prefixedSha256(content),
    observed_at: observedAt,
  };
}

function lockedArtifactEvidence(platform, version, observedAt) {
  return {
    type: "locked-release-artifact",
    locator: platform.url,
    revision: `v${version}:${platform.platform}`,
    digest: platform.checksum,
    observed_at: observedAt,
  };
}

function buildComponents({
  candidate,
  candidateEvidence,
  config,
  generatedAt,
  lock,
  repository,
  requestedChannel,
  resolved,
}) {
  return [
    {
      id: "node-release-channel",
      lane: "node",
      ecosystem: "mise",
      current: {
        version: requestedChannel,
        evidence: [
          repositoryFileEvidence(
            NODE_CONFIG_PATH,
            config,
            repository.revision,
            generatedAt,
          ),
        ],
      },
      candidate: null,
      eventual_managed_paths: [NODE_CONFIG_PATH],
      affected_capabilities: [...NODE_CAPABILITY_IDS],
    },
    {
      id: "node-runtime",
      lane: "node",
      ecosystem: "mise",
      current: {
        version: resolved.version,
        evidence: [
          repositoryFileEvidence(
            NODE_LOCK_PATH,
            lock,
            repository.revision,
            generatedAt,
          ),
          ...resolved.platforms.map((platform) =>
            lockedArtifactEvidence(platform, resolved.version, generatedAt),
          ),
        ],
      },
      candidate:
        candidate === null
          ? null
          : {
              version: candidate.version,
              evidence: candidateEvidence,
            },
      eventual_managed_paths: [NODE_LOCK_PATH],
      affected_capabilities: [...NODE_CAPABILITY_IDS],
    },
  ];
}

function buildObservation({
  capabilityCatalog,
  candidate,
  candidateEvidence,
  config,
  disposition,
  generatedAt,
  lock,
  repository,
  requestedChannel,
  resolved,
}) {
  const document = {
    schema_version: 1,
    kind: "observation",
    generated_at: generatedAt,
    repository,
    capability_catalog: {
      schema_version: capabilityCatalog.schemaVersion,
      digest: capabilityCatalog.digest,
    },
    provider_id: NODE_PROVIDER_ID,
    disposition,
    components: buildComponents({
      candidate,
      candidateEvidence,
      config,
      generatedAt,
      lock,
      repository,
      requestedChannel,
      resolved,
    }),
    relations: [
      {
        id: "node-runtime-follows-release-channel",
        type: "requires",
        from: "node-runtime",
        to: "node-release-channel",
        hard: true,
        constraint: "node-runtime major must equal node-release-channel",
      },
    ],
  };
  return validateDocument(document, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
}

function normalizeRepository(repository) {
  const value = repository ?? {
    name: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA,
  };
  if (
    value === null ||
    typeof value !== "object" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.name ?? "") ||
    !REPOSITORY_REVISION_PATTERN.test(value.revision ?? "")
  ) {
    throw new Error(
      "repository must contain an owner/repository name and full commit SHA",
    );
  }
  return { name: value.name, revision: value.revision };
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Node release source returned HTTP ${response.status}`);
  }
  return response.text();
}

export function createNodeReleaseMetadataSource({
  fetchImpl = globalThis.fetch,
  indexUrl = NODE_RELEASE_INDEX_URL,
  releaseBaseUrl = NODE_RELEASE_BASE_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function");
  }
  return {
    indexUrl,
    listReleases: () => fetchText(fetchImpl, indexUrl),
    readChecksums: (version) =>
      fetchText(
        fetchImpl,
        `${releaseBaseUrl}/v${version}/SHASUMS256.txt`,
      ),
  };
}

export async function collectNodeObservation({
  capabilityCatalogPath = "tests/e2e/capabilities.json",
  configPath = NODE_CONFIG_PATH,
  generatedAt = new Date().toISOString(),
  lockPath = NODE_LOCK_PATH,
  releaseMetadata = createNodeReleaseMetadataSource(),
  repository,
  repositoryRoot = process.cwd(),
} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const [config, lock, capabilityCatalog] = await Promise.all([
    readFile(resolve(repositoryRoot, configPath), "utf8"),
    readFile(resolve(repositoryRoot, lockPath), "utf8"),
    readCapabilityCatalog(resolve(repositoryRoot, capabilityCatalogPath)),
  ]);
  for (const capabilityId of NODE_CAPABILITY_IDS) {
    if (!capabilityCatalog.ids.has(capabilityId)) {
      throw new Error(`capability catalog is missing ${capabilityId}`);
    }
  }
  const requestedChannel = parseRequestedChannel(config);
  const resolved = parseLock(lock, requestedChannel);

  let releases;
  try {
    releases = parseReleaseIndex(await releaseMetadata.listReleases());
  } catch (error) {
    return buildObservation({
      capabilityCatalog,
      candidate: null,
      candidateEvidence: null,
      config,
      disposition: {
        state: "unavailable",
        reason_codes: [
          error instanceof NodeReleaseMetadataError
            ? "RELEASE_METADATA_MALFORMED"
            : "RELEASE_SOURCE_UNAVAILABLE",
        ],
      },
      generatedAt,
      lock,
      repository: normalizedRepository,
      requestedChannel,
      resolved,
    });
  }

  const candidate = selectCandidate(
    releases,
    requestedChannel,
    resolved.version,
    resolved.platforms,
    generatedAt,
  );
  if (candidate === null) {
    return buildObservation({
      capabilityCatalog,
      candidate: null,
      candidateEvidence: null,
      config,
      disposition: {
        state: "current",
        reason_codes: ["NO_CANDIDATE"],
      },
      generatedAt,
      lock,
      repository: normalizedRepository,
      requestedChannel,
      resolved,
    });
  }

  let checksums;
  try {
    checksums = parseChecksums(
      await releaseMetadata.readChecksums(candidate.version),
      candidate.version,
    );
  } catch (error) {
    return buildObservation({
      capabilityCatalog,
      candidate: null,
      candidateEvidence: null,
      config,
      disposition: {
        state: "unavailable",
        reason_codes: [
          error instanceof NodeReleaseMetadataError
            ? "RELEASE_METADATA_MALFORMED"
            : "RELEASE_SOURCE_UNAVAILABLE",
        ],
      },
      generatedAt,
      lock,
      repository: normalizedRepository,
      requestedChannel,
      resolved,
    });
  }

  const artifacts = resolved.platforms.map((platform) =>
    candidateArtifact(platform, resolved.version, candidate.version),
  );
  const missing = artifacts.filter(({ filename }) => !checksums.has(filename));
  if (missing.length > 0) {
    return buildObservation({
      capabilityCatalog,
      candidate: null,
      candidateEvidence: null,
      config,
      disposition: {
        state: "unavailable",
        reason_codes: ["RELEASE_METADATA_MALFORMED"],
      },
      generatedAt,
      lock,
      repository: normalizedRepository,
      requestedChannel,
      resolved,
    });
  }

  const releaseEvidence = {
    type: "upstream-release",
    locator: `${NODE_RELEASE_BASE_URL}/v${candidate.version}/`,
    revision: `v${candidate.version}`,
    digest: stableDigest({
      date: candidate.date,
      files: candidate.files,
      lts: candidate.lts,
      version: `v${candidate.version}`,
    }),
    observed_at: generatedAt,
  };
  const artifactEvidence = artifacts.map((artifact) => ({
    type: "upstream-release-artifact",
    locator: artifact.url,
    revision: `v${candidate.version}:${artifact.platform}`,
    digest: `sha256:${checksums.get(artifact.filename)}`,
    observed_at: generatedAt,
  }));

  return buildObservation({
    capabilityCatalog,
    candidate,
    candidateEvidence: [releaseEvidence, ...artifactEvidence],
    config,
    disposition: {
      state: "candidate",
      reason_codes: ["CANDIDATE_AVAILABLE"],
    },
    generatedAt,
    lock,
    repository: normalizedRepository,
    requestedChannel,
    resolved,
  });
}

function nodeRuntimeCandidate(observation) {
  const component = observation.components.find(
    ({ id }) => id === "node-runtime",
  );
  if (component?.candidate === null || component?.candidate === undefined) {
    throw new Error("Node observation does not contain a runtime candidate");
  }
  return component;
}

function validationPlanDigest(plan) {
  return stableDigest(plan);
}

function assertValidationPlan(plan, observation) {
  if (
    plan?.kind !== "node-independent-validation-plan" ||
    plan.provider_id !== NODE_PROVIDER_ID ||
    plan.candidate_digest !== subjectDigest(observation) ||
    plan.repository?.name !== observation.repository.name ||
    plan.repository?.revision !== observation.repository.revision
  ) {
    throw new Error("validation plan does not bind the Node observation");
  }
}

export async function planNodeIndependentValidation(
  observation,
  {
    capabilityCatalogPath = "tests/e2e/capabilities.json",
    capabilityId,
    repositoryRoot = process.cwd(),
  } = {},
) {
  const catalogPath = resolve(repositoryRoot, capabilityCatalogPath);
  const [capabilityCatalog, catalogDocument] = await Promise.all([
    readCapabilityCatalog(catalogPath),
    readFile(catalogPath, "utf8").then(JSON.parse),
  ]);
  validateDocument(observation, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  if (observation.disposition.state !== "candidate") {
    throw new Error("independent validation requires a candidate observation");
  }
  const component = nodeRuntimeCandidate(observation);
  if (!component.affected_capabilities.includes(capabilityId)) {
    throw new Error(`Node candidate does not affect ${capabilityId}`);
  }
  const capability = catalogDocument.capabilities.find(
    ({ id }) => id === capabilityId,
  );
  if (capability === undefined) {
    throw new Error(`capability catalog does not contain ${capabilityId}`);
  }
  const candidateVersion = component.candidate.version;
  const environment = {
    MISE_LOCKED: "0",
    MISE_NODE_VERSION: candidateVersion,
  };
  const tool = `node@${candidateVersion}`;
  return {
    schema_version: 1,
    kind: "node-independent-validation-plan",
    provider_id: NODE_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    repository: { ...observation.repository },
    capability_id: capability.id,
    runner: capability.runner,
    candidate: {
      tool,
      version: candidateVersion,
      mode: "mise-exec-override",
    },
    environment,
    commands: [
      {
        id: "repository-policy",
        argv: ["mise", "exec", tool, "--", "mise", "run", "ci"],
      },
      {
        id: "lane-capability",
        argv: [
          "mise",
          "-E",
          capability.environment,
          "exec",
          tool,
          "--",
          "mise",
          "-E",
          capability.environment,
          "run",
          capability.task,
        ],
      },
    ],
    git_state_guard: {
      argv: [
        "git",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      require_unchanged: true,
    },
  };
}

export function nodeValidationEvidence(
  plan,
  observation,
  { completedAt, startedAt },
) {
  assertValidationPlan(plan, observation);
  return {
    type: "independent-validation-plan",
    locator: `${plan.runner}:${plan.capability_id}`,
    revision: plan.repository.revision,
    digest: validationPlanDigest(plan),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

export async function buildNodeIndependentValidation(
  observation,
  executions,
  {
    capabilityCatalogPath = "tests/e2e/capabilities.json",
    generatedAt = new Date().toISOString(),
    repositoryRoot = process.cwd(),
  } = {},
) {
  const capabilityCatalog = await readCapabilityCatalog(
    resolve(repositoryRoot, capabilityCatalogPath),
  );
  validateDocument(observation, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  if (!Array.isArray(executions) || executions.length === 0) {
    throw new Error("executions must be a nonempty array");
  }
  const results = executions.map((execution) => {
    assertValidationPlan(execution.plan, observation);
    return {
      capability_id: execution.plan.capability_id,
      status: execution.status,
      warnings: [...(execution.warnings ?? [])],
      evidence: [
        nodeValidationEvidence(execution.plan, observation, {
          completedAt: execution.completedAt,
          startedAt: execution.startedAt,
        }),
      ],
    };
  });
  const qualified = results.every(
    ({ status, warnings }) => status === "pass" && warnings.length === 0,
  );
  const validation = {
    schema_version: 1,
    kind: "validation",
    generated_at: generatedAt,
    repository: { ...observation.repository },
    capability_catalog: { ...observation.capability_catalog },
    provider_id: NODE_PROVIDER_ID,
    candidate_digest: subjectDigest(observation),
    disposition: {
      state: qualified ? "independently-qualified" : "blocked",
      reason_codes: qualified ? [] : ["INDEPENDENT_VALIDATION_FAILED"],
    },
    results,
  };
  validateDocument(validation, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  if (qualified) {
    validateIndependentQualification(observation, validation, {
      capabilityIds: capabilityCatalog.ids,
      capabilityCatalogDigest: capabilityCatalog.digest,
    });
  }
  return validation;
}
