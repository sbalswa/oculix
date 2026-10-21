import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

function compareLexically(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function parseSemver(value, context) {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${context} must be a stable semantic version`);
  }
  const components = match.slice(1).map(Number);
  if (components.some((component) => !Number.isSafeInteger(component))) {
    throw new Error(`${context} contains an unsafe numeric component`);
  }
  return components;
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

function parseRequestedChannel(config, configRepositoryPath) {
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
      `${configRepositoryPath} must contain one numeric Node release channel`,
    );
  }
  if (!Number.isSafeInteger(Number(values[0]))) {
    throw new Error(
      `${configRepositoryPath} contains an unsafe Node release channel`,
    );
  }
  return values[0];
}

function scanTomlHeaders(lock, lockRepositoryPath) {
  const headers = [];
  let lineStart = 0;
  while (lineStart < lock.length) {
    const newline = lock.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? lock.length : newline;
    const line = lock.slice(lineStart, lineEnd).replace(/\r$/u, "");
    if (line.trimStart().startsWith("[")) {
      const match =
        /^\s*(\[\[[^\]]+\]\]|\[[^\]]+\])\s*(?:#.*)?$/u.exec(line);
      if (match === null) {
        throw new Error(`${lockRepositoryPath} contains a malformed header`);
      }
      const token = match[1];
      const array = token.startsWith("[[");
      const body = token.slice(array ? 2 : 1, array ? -2 : -1);
      const compactBody = body.replace(/\s+/gu, "").toLowerCase();
      const nodeLike =
        compactBody.startsWith("tools.node") ||
        compactBody.includes("platforms.");
      let kind = "other";
      let platform = null;
      if (array && body === "tools.node") {
        kind = "node-tool";
      } else if (!array) {
        const platformMatch =
          /^tools\.node\."platforms\.([a-z0-9-]+)"$/u.exec(body);
        if (platformMatch !== null) {
          kind = "node-platform";
          platform = platformMatch[1];
        } else if (nodeLike) {
          throw new Error(
            `${lockRepositoryPath} contains an unsupported Node header ` +
              token,
          );
        }
      } else if (nodeLike) {
        throw new Error(
          `${lockRepositoryPath} contains an unsupported Node header ${token}`,
        );
      }
      headers.push({
        contentStart: newline === -1 ? lock.length : newline + 1,
        kind,
        platform,
        start: lineStart,
      });
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  return headers.map((header, index) => ({
    ...header,
    contentEnd:
      index + 1 < headers.length ? headers[index + 1].start : lock.length,
  }));
}

function parseTomlBlock(block, context, allowedKeys) {
  const entries = new Map();
  for (const line of block.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null) {
      throw new Error(`${context} contains a malformed entry`);
    }
    const [, key, value] = match;
    if (!allowedKeys.has(key)) {
      throw new Error(`${context} contains unsupported key ${key}`);
    }
    if (entries.has(key)) {
      throw new Error(`${context} contains duplicate key ${key}`);
    }
    entries.set(key, value);
  }
  return entries;
}

function parseTomlString(entries, key, context) {
  const value = entries.get(key);
  const match =
    typeof value === "string"
      ? /^"([^"]+)"\s*(?:#.*)?$/u.exec(value)
      : null;
  if (match === null) {
    throw new Error(`${context} must contain ${key}`);
  }
  return match[1];
}

function parseSpecifierArray(entries, lockRepositoryPath) {
  const value = entries.get("specifiers");
  const match =
    typeof value === "string"
      ? /^(\[[^\n]+\])\s*(?:#.*)?$/u.exec(value)
      : null;
  if (match === null) {
    throw new Error(`${lockRepositoryPath} must contain Node specifiers`);
  }
  let specifiers;
  try {
    specifiers = JSON.parse(match[1]);
  } catch {
    throw new Error(`${lockRepositoryPath} contains invalid Node specifiers`);
  }
  if (
    !Array.isArray(specifiers) ||
    specifiers.length === 0 ||
    specifiers.some((specifier) => typeof specifier !== "string")
  ) {
    throw new Error(`${lockRepositoryPath} contains invalid Node specifiers`);
  }
  return specifiers;
}

function artifactIdentity(filename, lockRepositoryPath) {
  let match = /^node-v\d+\.\d+\.\d+-(linux)-(arm64|x64)\.tar\.gz$/u.exec(
    filename,
  );
  if (match !== null) {
    return {
      platform: `${match[1]}-${match[2]}`,
      releaseToken: `${match[1]}-${match[2]}`,
    };
  }
  match = /^node-v\d+\.\d+\.\d+-darwin-(arm64|x64)\.tar\.gz$/u.exec(
    filename,
  );
  if (match !== null) {
    return {
      platform: `macos-${match[1]}`,
      releaseToken: `osx-${match[1]}-tar`,
    };
  }
  match = /^node-v\d+\.\d+\.\d+-win-(arm64|x64)\.zip$/u.exec(filename);
  if (match !== null) {
    return {
      platform: `windows-${match[1]}`,
      releaseToken: `win-${match[1]}-zip`,
    };
  }
  throw new Error(
    `${lockRepositoryPath} contains an unsupported Node artifact ${filename}`,
  );
}

function parseLock(lock, requestedChannel, lockRepositoryPath) {
  const headers = scanTomlHeaders(lock, lockRepositoryPath);
  const toolHeaders = headers.filter(({ kind }) => kind === "node-tool");
  if (toolHeaders.length !== 1) {
    throw new Error(
      `${lockRepositoryPath} must contain one Node tool record`,
    );
  }

  const toolHeader = toolHeaders[0];
  const toolEntries = parseTomlBlock(
    lock.slice(toolHeader.contentStart, toolHeader.contentEnd),
    `${lockRepositoryPath} Node tool record`,
    new Set(["version", "backend", "specifiers"]),
  );
  const version = parseTomlString(
    toolEntries,
    "version",
    lockRepositoryPath,
  );
  parseSemver(version, `${lockRepositoryPath} Node version`);
  const backend = parseTomlString(
    toolEntries,
    "backend",
    lockRepositoryPath,
  );
  if (backend !== "core:node") {
    throw new Error(`${lockRepositoryPath} Node backend must be core:node`);
  }
  const specifiers = parseSpecifierArray(toolEntries, lockRepositoryPath);
  if (!specifiers.includes(requestedChannel)) {
    throw new Error(
      `${lockRepositoryPath} does not resolve requested channel ` +
        requestedChannel,
    );
  }
  if (String(parseSemver(version, version)[0]) !== requestedChannel) {
    throw new Error(
      `${lockRepositoryPath} resolved version is outside channel ` +
        requestedChannel,
    );
  }

  const platforms = [];
  const platformHeaders = headers.filter(
    ({ kind }) => kind === "node-platform",
  );
  for (const header of platformHeaders) {
    const platform = header.platform;
    if (!PLATFORM_PATTERN.test(platform)) {
      throw new Error(
        `${lockRepositoryPath} contains invalid platform ${platform}`,
      );
    }
    const entries = parseTomlBlock(
      lock.slice(header.contentStart, header.contentEnd),
      `${lockRepositoryPath} platform ${platform}`,
      new Set(["checksum", "url"]),
    );
    const checksum = parseTomlString(entries, "checksum", platform);
    if (!checksum.startsWith("sha256:") ||
        !SHA256_PATTERN.test(checksum.slice("sha256:".length))) {
      throw new Error(
        `${lockRepositoryPath} contains invalid ${platform} checksum`,
      );
    }
    const url = parseTomlString(entries, "url", platform);
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(
        `${lockRepositoryPath} contains invalid ${platform} URL`,
      );
    }
    const filename = parsedUrl.pathname.split("/").at(-1);
    const canonicalUrl =
      `https://nodejs.org/dist/v${version}/${filename}`;
    if (
      url !== canonicalUrl ||
      parsedUrl.origin !== "https://nodejs.org" ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      parsedUrl.pathname !== `/dist/v${version}/${filename}` ||
      !filename.startsWith(`node-v${version}-`) ||
      parsedUrl.search !== "" ||
      parsedUrl.hash !== ""
    ) {
      throw new Error(
        `${lockRepositoryPath} ${platform} URL does not bind Node ${version}`,
      );
    }
    const identity = artifactIdentity(filename, lockRepositoryPath);
    if (identity.platform !== platform) {
      throw new Error(
        `${lockRepositoryPath} platform ${platform} does not match ` +
          `artifact ${identity.platform}`,
      );
    }
    platforms.push({
      checksum,
      filename,
      platform,
      releaseToken: identity.releaseToken,
      url,
    });
  }
  if (platforms.length === 0) {
    throw new Error(
      `${lockRepositoryPath} must contain Node platform records`,
    );
  }
  platforms.sort((left, right) =>
    compareLexically(left.platform, right.platform),
  );
  if (new Set(platforms.map(({ filename }) => filename)).size !==
      platforms.length) {
    throw new Error(
      `${lockRepositoryPath} contains duplicate effective Node artifacts`,
    );
  }
  if (new Set(platforms.map(({ platform }) => platform)).size !==
      platforms.length) {
    throw new Error(
      `${lockRepositoryPath} contains duplicate Node platforms`,
    );
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
  if (releases.length === 0) {
    metadataError("Node release index must not be empty");
  }
  const seenVersions = new Set();
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
    if (seenVersions.has(version)) {
      metadataError(`Node release index duplicates v${version}`);
    }
    seenVersions.add(version);
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

function normalizeBaseUrl(value, context) {
  let locator;
  try {
    locator = new URL(value);
  } catch {
    metadataError(`${context} is not a valid URL`);
  }
  if (
    !["http:", "https:"].includes(locator.protocol) ||
    locator.search !== "" ||
    locator.hash !== ""
  ) {
    metadataError(`${context} must be an HTTP(S) base URL`);
  }
  return locator.href.replace(/\/+$/u, "");
}

function normalizeIndexUrl(value) {
  let locator;
  try {
    locator = new URL(value);
  } catch {
    metadataError("Node release index locator is not a valid URL");
  }
  if (!["http:", "https:"].includes(locator.protocol)) {
    metadataError("Node release index locator must be HTTP(S)");
  }
  return locator.href;
}

function normalizeReleaseSource(releaseMetadata) {
  if (
    releaseMetadata === null ||
    typeof releaseMetadata !== "object" ||
    typeof releaseMetadata.listReleases !== "function" ||
    typeof releaseMetadata.readChecksums !== "function"
  ) {
    metadataError("Node release metadata source is malformed");
  }
  return {
    indexUrl: normalizeIndexUrl(releaseMetadata.indexUrl),
    listReleases: releaseMetadata.listReleases.bind(releaseMetadata),
    readChecksums: releaseMetadata.readChecksums.bind(releaseMetadata),
    releaseBaseUrl: normalizeBaseUrl(
      releaseMetadata.releaseBaseUrl,
      "Node release base locator",
    ),
  };
}

function candidateArtifact(
  platform,
  currentVersion,
  candidateVersion,
  releaseBaseUrl,
) {
  const filename = platform.filename.replace(
    `node-v${currentVersion}-`,
    `node-v${candidateVersion}-`,
  );
  const url = `${releaseBaseUrl}/v${candidateVersion}/${filename}`;
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
    .sort((left, right) => {
      const precedence = compareSemver(right.version, left.version);
      return precedence === 0
        ? compareLexically(left.version, right.version)
        : precedence;
    })[0] ??
    null;
}

function pathInside(root, target) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function repositoryFileLocation(repositoryRoot, configuredPath, name) {
  if (typeof configuredPath !== "string" || configuredPath === "") {
    throw new Error(`${name} must be a nonempty path`);
  }
  const root = resolve(repositoryRoot);
  const absolutePath = resolve(root, configuredPath);
  if (!pathInside(root, absolutePath) || absolutePath === root) {
    throw new Error(`${name} must resolve inside the repository`);
  }
  const [realRoot, realFile] = await Promise.all([
    realpath(root),
    realpath(absolutePath),
  ]);
  if (!pathInside(realRoot, realFile) || realFile === realRoot) {
    throw new Error(`${name} escapes repositoryRoot through a symlink`);
  }
  const repositoryPath = relative(root, absolutePath).split(sep).join("/");
  return { readPath: realFile, repositoryPath };
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
  configRepositoryPath,
  generatedAt,
  lock,
  lockRepositoryPath,
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
            configRepositoryPath,
            config,
            repository.revision,
            generatedAt,
          ),
        ],
      },
      candidate: null,
      eventual_managed_paths: [configRepositoryPath],
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
            lockRepositoryPath,
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
      eventual_managed_paths: [lockRepositoryPath],
      affected_capabilities: [...NODE_CAPABILITY_IDS],
    },
  ];
}

function buildObservation({
  capabilityCatalog,
  candidate,
  candidateEvidence,
  config,
  configRepositoryPath,
  disposition,
  generatedAt,
  lock,
  lockRepositoryPath,
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
      configRepositoryPath,
      generatedAt,
      lock,
      lockRepositoryPath,
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
  const normalizedIndexUrl = normalizeIndexUrl(indexUrl);
  const normalizedReleaseBaseUrl = normalizeBaseUrl(
    releaseBaseUrl,
    "Node release base locator",
  );
  return {
    indexUrl: normalizedIndexUrl,
    listReleases: () => fetchText(fetchImpl, normalizedIndexUrl),
    readChecksums: (version) =>
      fetchText(
        fetchImpl,
        `${normalizedReleaseBaseUrl}/v${version}/SHASUMS256.txt`,
      ),
    releaseBaseUrl: normalizedReleaseBaseUrl,
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
  const [configLocation, lockLocation] = await Promise.all([
    repositoryFileLocation(repositoryRoot, configPath, "configPath"),
    repositoryFileLocation(repositoryRoot, lockPath, "lockPath"),
  ]);
  const [config, lock, capabilityCatalog] = await Promise.all([
    readFile(configLocation.readPath, "utf8"),
    readFile(lockLocation.readPath, "utf8"),
    readCapabilityCatalog(resolve(repositoryRoot, capabilityCatalogPath)),
  ]);
  for (const capabilityId of NODE_CAPABILITY_IDS) {
    if (!capabilityCatalog.ids.has(capabilityId)) {
      throw new Error(`capability catalog is missing ${capabilityId}`);
    }
  }
  const requestedChannel = parseRequestedChannel(
    config,
    configLocation.repositoryPath,
  );
  const resolved = parseLock(
    lock,
    requestedChannel,
    lockLocation.repositoryPath,
  );
  const observationInput = {
    capabilityCatalog,
    config,
    configRepositoryPath: configLocation.repositoryPath,
    generatedAt,
    lock,
    lockRepositoryPath: lockLocation.repositoryPath,
    repository: normalizedRepository,
    requestedChannel,
    resolved,
  };

  let releases;
  let source;
  try {
    source = normalizeReleaseSource(releaseMetadata);
    releases = parseReleaseIndex(await source.listReleases());
  } catch (error) {
    return buildObservation({
      ...observationInput,
      candidate: null,
      candidateEvidence: null,
      disposition: {
        state: "unavailable",
        reason_codes: [
          error instanceof NodeReleaseMetadataError
            ? "RELEASE_METADATA_MALFORMED"
            : "RELEASE_SOURCE_UNAVAILABLE",
        ],
      },
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
      ...observationInput,
      candidate: null,
      candidateEvidence: null,
      disposition: {
        state: "current",
        reason_codes: ["NO_CANDIDATE"],
      },
    });
  }

  let checksums;
  try {
    checksums = parseChecksums(
      await source.readChecksums(candidate.version),
      candidate.version,
    );
  } catch (error) {
    return buildObservation({
      ...observationInput,
      candidate: null,
      candidateEvidence: null,
      disposition: {
        state: "unavailable",
        reason_codes: [
          error instanceof NodeReleaseMetadataError
            ? "RELEASE_METADATA_MALFORMED"
            : "RELEASE_SOURCE_UNAVAILABLE",
        ],
      },
    });
  }

  const artifacts = resolved.platforms.map((platform) =>
    candidateArtifact(
      platform,
      resolved.version,
      candidate.version,
      source.releaseBaseUrl,
    ),
  );
  const missing = artifacts.filter(({ filename }) => !checksums.has(filename));
  if (missing.length > 0) {
    return buildObservation({
      ...observationInput,
      candidate: null,
      candidateEvidence: null,
      disposition: {
        state: "unavailable",
        reason_codes: ["RELEASE_METADATA_MALFORMED"],
      },
    });
  }

  const releaseIndexEvidence = {
    type: "upstream-release-index",
    locator: source.indexUrl,
    revision: `v${candidate.version}`,
    digest: stableDigest({
      date: candidate.date,
      files: candidate.files,
      lts: candidate.lts,
      version: `v${candidate.version}`,
    }),
    observed_at: generatedAt,
  };
  const checksumsEvidence = {
    type: "upstream-release-checksums",
    locator:
      `${source.releaseBaseUrl}/v${candidate.version}/SHASUMS256.txt`,
    revision: `v${candidate.version}`,
    digest: stableDigest(
      [...checksums.entries()]
        .sort(([left], [right]) => compareLexically(left, right)),
    ),
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
    ...observationInput,
    candidate,
    candidateEvidence: [
      releaseIndexEvidence,
      checksumsEvidence,
      ...artifactEvidence,
    ],
    disposition: {
      state: "candidate",
      reason_codes: ["CANDIDATE_AVAILABLE"],
    },
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

function assertExactValidationPlan(plan, expected) {
  if (!isDeepStrictEqual(plan, expected)) {
    throw new Error("validation plan does not match the prescribed plan");
  }
}

function prescribedValidationPlan(observation, capability) {
  const component = nodeRuntimeCandidate(observation);
  if (!component.affected_capabilities.includes(capability.id)) {
    throw new Error(`Node candidate does not affect ${capability.id}`);
  }
  const candidateVersion = component.candidate.version;
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
    environment: {
      MISE_LOCKED: "0",
      MISE_NODE_VERSION: candidateVersion,
    },
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
  const capability = catalogDocument.capabilities.find(
    ({ id }) => id === capabilityId,
  );
  if (capability === undefined) {
    throw new Error(`capability catalog does not contain ${capabilityId}`);
  }
  return prescribedValidationPlan(observation, capability);
}

function nodeValidationEvidence(
  plan,
  { completedAt, startedAt },
) {
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
  const catalogPath = resolve(repositoryRoot, capabilityCatalogPath);
  const [capabilityCatalog, catalogDocument] = await Promise.all([
    readCapabilityCatalog(catalogPath),
    readFile(catalogPath, "utf8").then(JSON.parse),
  ]);
  validateDocument(observation, {
    capabilityIds: capabilityCatalog.ids,
    capabilityCatalogDigest: capabilityCatalog.digest,
  });
  if (!Array.isArray(executions) || executions.length === 0) {
    throw new Error("executions must be a nonempty array");
  }
  const results = executions.map((execution) => {
    const capability = catalogDocument.capabilities.find(
      ({ id }) => id === execution.plan?.capability_id,
    );
    if (capability === undefined) {
      throw new Error(
        `capability catalog does not contain ` +
          `${execution.plan?.capability_id}`,
      );
    }
    const expectedPlan = prescribedValidationPlan(observation, capability);
    assertExactValidationPlan(execution.plan, expectedPlan);
    return {
      capability_id: expectedPlan.capability_id,
      status: execution.status,
      warnings: [...(execution.warnings ?? [])],
      evidence: [
        nodeValidationEvidence(expectedPlan, {
          completedAt: execution.completedAt,
          startedAt: execution.startedAt,
        }),
      ],
    };
  }).sort((left, right) =>
    compareLexically(left.capability_id, right.capability_id),
  );
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
