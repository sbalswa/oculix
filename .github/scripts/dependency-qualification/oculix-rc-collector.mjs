import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import {
  subjectDigest,
  validateIndependentQualification,
} from "./contract.mjs";

const execFile = promisify(execFileCallback);

const RC_PATTERN =
  /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc([1-9][0-9]*)$/u;
const STABLE_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const TEMURIN_SPECIFIER_PATTERN = /^temurin-([1-9][0-9]*)$/u;
const TEMURIN_RESOLVED_PATTERN =
  /^temurin-([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+([1-9][0-9]*)$/u;
const TEMURIN_VENDOR = "Eclipse Adoptium";
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const WARNING_PATTERNS = Object.freeze([
  /^warn(?:ing|ings)?(?:\s|:)/iu,
  /^\[warn(?:ing|ings)?\]/iu,
  /^##\[warn(?:ing|ings)?\]/iu,
  /^::warning(?:\s|:|$)/iu,
  /^npm\s+warn(?:ing)?\b/iu,
  /(?:^|\s)mise\s+warn(?:ing|ings)?\b/iu,
  /\b[a-z]*warnings?\s*:/iu,
]);
const RESULT_STATUSES = new Set([
  "pass",
  "fail",
  "blocked",
  "unknown",
  "not-selected",
  "not-validated",
]);

export const OCULIX_RC_PROVIDER_ID = "oculix-rc";
export const OCULIX_RC_COMPONENT_ID = "oculix-release-candidate";
export const OCULIX_JAVA_COMPONENT_ID = "oculix-java-runtime";
export const OCULIX_CONFIG_PATH = "mise/config.oculix.toml";
export const OCULIX_LOCK_PATH = "mise/mise.oculix.lock";
export const OCULIX_MANAGED_PATHS = Object.freeze([
  OCULIX_CONFIG_PATH,
  OCULIX_LOCK_PATH,
]);
export const OCULIX_LOCK_PLATFORMS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "macos-arm64",
  "windows-x64",
]);
export const OCULIX_CAPABILITIES = Object.freeze([
  "oculix-ubuntu-chromium",
]);
export const OCULIX_QUALIFICATION_CHECKS = deepFreeze([
  {
    id: "repository-policy",
    capability_id: "oculix-ubuntu-chromium",
    command: ["mise", "run", "ci"],
    environment: {},
  },
  {
    id: "oculix-capability",
    capability_id: "oculix-ubuntu-chromium",
    command: [
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1280x1024x24",
      "mise",
      "-E",
      "oculix,web-e2e",
      "run",
      "e2e:oculix:web-calculator",
    ],
    environment: {
      E2E_BROWSER: "chromium",
      E2E_OS: "ubuntu",
      MISE_LOCKED: "1",
      OCULIX_CHROMIUM_DISABLE_SANDBOX: "1",
    },
  },
]);

export class OculixJavaRuntimeIncompatibilityError extends Error {}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => {
        const leftJson = JSON.stringify(left);
        const rightJson = JSON.stringify(right);
        if (leftJson < rightJson) {
          return -1;
        }
        if (leftJson > rightJson) {
          return 1;
        }
        return 0;
      });
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  const payload =
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
}

function requireRevision(value, name) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function requireTimestamp(value, name) {
  requireString(value, name);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u
      .exec(value);
  if (match === null) {
    throw new Error(`${name} must be an RFC 3339 UTC timestamp`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    throw new Error(`${name} must be a real RFC 3339 UTC timestamp`);
  }
  return value;
}

function versionParts(match) {
  return match.slice(1).map((part) => BigInt(part));
}

export function parseStableOculixVersion(version) {
  const match = STABLE_PATTERN.exec(version);
  if (match === null) {
    throw new Error(
      `Stable Oculix version must match N.N.N exactly: ${version}`,
    );
  }
  const [major, minor, patch] = versionParts(match);
  return deepFreeze({
    major,
    minor,
    patch,
    version,
  });
}

export function parseOculixRcTag(tag) {
  if (typeof tag !== "string") {
    return null;
  }
  const match = RC_PATTERN.exec(tag);
  if (match === null) {
    return null;
  }
  const [major, minor, patch, rc] = versionParts(match);
  return deepFreeze({
    major,
    minor,
    patch,
    rc,
    tag,
    version: `${major}.${minor}.${patch}-rc${rc}`,
  });
}

function compareParts(left, right, keys) {
  for (const key of keys) {
    if (left[key] < right[key]) {
      return -1;
    }
    if (left[key] > right[key]) {
      return 1;
    }
  }
  return 0;
}

export function compareOculixRcVersions(left, right) {
  const parsedLeft =
    typeof left === "string" ? parseOculixRcTag(left) : left;
  const parsedRight =
    typeof right === "string" ? parseOculixRcTag(right) : right;
  if (parsedLeft === null || parsedRight === null) {
    throw new Error("RC comparison requires strict Oculix RC versions");
  }
  return compareParts(
    parsedLeft,
    parsedRight,
    ["major", "minor", "patch", "rc"],
  );
}

function rcIsNewerThanStable(rc, stable) {
  return compareParts(rc, stable, ["major", "minor", "patch"]) > 0;
}

function releaseIdentity(release) {
  const id = release?.id;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    String(id).length === 0
  ) {
    throw new Error("GitHub release id is missing");
  }
  return String(id);
}

export function selectNewestOculixRc(releases, stableVersion) {
  if (!Array.isArray(releases)) {
    throw new Error("GitHub releases response must be an array");
  }
  const stable = parseStableOculixVersion(stableVersion);
  const eligible = releases
    .filter((release) => release?.draft === false)
    .filter((release) => release?.prerelease === true)
    .map((release) => ({
      parsed: parseOculixRcTag(release.tag_name),
      release,
    }))
    .filter(({ parsed }) => parsed !== null)
    .filter(({ parsed }) => rcIsNewerThanStable(parsed, stable))
    .sort((left, right) => {
      const versionOrder = compareOculixRcVersions(
        right.parsed,
        left.parsed,
      );
      if (versionOrder !== 0) {
        return versionOrder;
      }
      if (left.parsed.tag < right.parsed.tag) {
        return -1;
      }
      if (left.parsed.tag > right.parsed.tag) {
        return 1;
      }
      return 0;
    });

  if (eligible.length === 0) {
    return null;
  }
  if (
    eligible.length > 1 &&
    compareOculixRcVersions(
      eligible[0].parsed,
      eligible[1].parsed,
    ) === 0
  ) {
    throw new Error(
      `Multiple releases claim newest Oculix RC ${eligible[0].parsed.version}`,
    );
  }
  return deepFreeze({
    release: structuredClone(eligible[0].release),
    ...eligible[0].parsed,
  });
}

function pinnedVersionFromConfig(contents) {
  const text = String(contents);
  const matches = [
    ...text.matchAll(/^version = "([^"]+)"$/gmu),
  ].map((match) => match[1]);
  if (matches.length !== 1) {
    throw new Error(
      `${OCULIX_CONFIG_PATH} must contain exactly one Oculix version`,
    );
  }
  return matches[0];
}

function currentVersionFromConfig(contents) {
  const version = pinnedVersionFromConfig(contents);
  parseStableOculixVersion(version);
  return version;
}

function stripTomlComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function relevantLockSection(header) {
  if (header === '[[tools."http:oculixide"]]') {
    return { kind: "oculix-tool" };
  }
  if (header === "[[tools.java]]") {
    return { kind: "java-tool" };
  }
  const oculixPlatform =
    /^\[tools\."http:oculixide"\."platforms\.([a-z0-9-]+)"\]$/u
      .exec(header);
  if (oculixPlatform !== null) {
    return {
      kind: "oculix-platform",
      platform: oculixPlatform[1],
    };
  }
  const javaPlatform =
    /^\[tools\.java\."platforms\.([a-z0-9-]+)"\]$/u.exec(header);
  if (javaPlatform !== null) {
    return {
      kind: "java-platform",
      platform: javaPlatform[1],
    };
  }
  return null;
}

function parseLockSections(contents) {
  const sections = [];
  let current = null;
  for (const [index, rawLine] of String(contents).split(/\r?\n/u).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[")) {
      const identity = relevantLockSection(line);
      current =
        identity === null
          ? null
          : {
              ...identity,
              assignments: new Map(),
              line: index + 1,
            };
      if (current !== null) {
        sections.push(current);
      }
      continue;
    }
    if (current === null) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (assignment === null) {
      throw new Error(
        `${OCULIX_LOCK_PATH}:${index + 1} is not a structural assignment`,
      );
    }
    const [, key, value] = assignment;
    if (current.assignments.has(key)) {
      throw new Error(
        `${OCULIX_LOCK_PATH}:${index + 1} duplicates ${key}`,
      );
    }
    current.assignments.set(key, value);
  }
  return sections;
}

function requireLockSection(sections, kind, platform) {
  const matches = sections.filter(
    (section) =>
      section.kind === kind &&
      (platform === undefined || section.platform === platform),
  );
  const context =
    platform === undefined ? kind : `${kind} ${platform}`;
  if (matches.length !== 1) {
    throw new Error(
      `${OCULIX_LOCK_PATH} must contain exactly one ${context} record`,
    );
  }
  return matches[0];
}

function parseTomlValue(section, key, context) {
  const source = section.assignments.get(key);
  if (source === undefined) {
    throw new Error(`${context} must contain one ${key}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${context} contains invalid ${key}`);
  }
}

function parseTomlString(section, key, context) {
  const value = parseTomlValue(section, key, context);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} contains invalid ${key}`);
  }
  return value;
}

function parseStringArray(section, key, context) {
  const values = parseTomlValue(section, key, context);
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${context} contains invalid ${key}`);
  }
  return values;
}

function parseOculixToolRecord(sections, expectedVersion) {
  const section = requireLockSection(sections, "oculix-tool");
  const context = `${OCULIX_LOCK_PATH} Oculix`;
  const version = parseTomlString(section, "version", context);
  const backend = parseTomlString(section, "backend", context);
  const specifiers = parseStringArray(section, "specifiers", context);
  if (
    version !== expectedVersion ||
    backend !== "http:oculixide" ||
    specifiers.length !== 1 ||
    specifiers[0] !== expectedVersion
  ) {
    throw new Error(
      `${OCULIX_LOCK_PATH} must structurally lock Oculix ${expectedVersion}`,
    );
  }
  return { backend, specifiers, version };
}

function assertCurrentLock(lockContents, currentVersion) {
  parseOculixToolRecord(parseLockSections(lockContents), currentVersion);
}

function configuredTemurinPolicy(configContents) {
  const matches = [
    ...String(configContents).matchAll(
      /^\s*java\s*=\s*"([^"]+)"\s*(?:#.*)?$/gmu,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `${OCULIX_CONFIG_PATH} must contain exactly one Java specifier`,
    );
  }
  const specifier = matches[0][1];
  const parsed = TEMURIN_SPECIFIER_PATTERN.exec(specifier);
  if (parsed === null) {
    throw new Error(
      `${OCULIX_CONFIG_PATH} Java must be a review-gated temurin-N major`,
    );
  }
  const majorNumber = Number(parsed[1]);
  if (!Number.isSafeInteger(majorNumber)) {
    throw new Error(
      `${OCULIX_CONFIG_PATH} Java major must be a safe integer`,
    );
  }
  return {
    major: parsed[1],
    specifier,
  };
}

function javaMajorConstraint(major) {
  return `>=${major}.0.0 <${Number(major) + 1}.0.0`;
}

function javaPlatformToken(platform) {
  return {
    "linux-arm64": "aarch64_linux_hotspot",
    "linux-x64": "x64_linux_hotspot",
    "macos-arm64": "aarch64_mac_hotspot",
    "windows-x64": "x64_windows_hotspot",
  }[platform];
}

function javaPlatformExtension(platform) {
  return platform === "windows-x64" ? "zip" : "tar.gz";
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function resolvedTemurinVersion(releaseVersion, build) {
  const parts = releaseVersion.split(".");
  if (parts.length === 3) {
    return `${releaseVersion}+${build}`;
  }
  if (parts.length === 4) {
    return `${parts.slice(0, 3).join(".")}+${parts[3]}${build.padStart(2, "0")}`;
  }
  throw new Error("Temurin release version must have three or four parts");
}

function parseTemurinArtifactUrl(url, platform, lockedVersion, major) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${OCULIX_LOCK_PATH} Java ${platform} URL is invalid`);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch {
    throw new Error(`${OCULIX_LOCK_PATH} Java ${platform} URL is invalid`);
  }
  const prefix =
    `/adoptium/temurin${major}-binaries/releases/download/`;
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    !pathname.startsWith(prefix)
  ) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} URL does not bind Temurin ${major}`,
    );
  }
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator === -1) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} URL lacks an artifact`,
    );
  }
  const release = remainder.slice(0, separator);
  const filename = remainder.slice(separator + 1);
  const releaseMatch =
    /^jdk-([1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?)\+([1-9][0-9]*)$/u
      .exec(release);
  if (releaseMatch === null) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} URL has an invalid release`,
    );
  }
  const [, releaseVersion, build] = releaseMatch;
  const runtimeVersion = `${releaseVersion}+${build}`;
  if (
    `temurin-${resolvedTemurinVersion(releaseVersion, build)}` !==
    lockedVersion
  ) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} URL does not bind ${lockedVersion}`,
    );
  }
  const expectedFilename = new RegExp(
    `^OpenJDK${escapeRegularExpression(major)}U-jdk_` +
      `${escapeRegularExpression(javaPlatformToken(platform))}_` +
      `${escapeRegularExpression(releaseVersion)}_` +
      `${escapeRegularExpression(build)}\\.` +
      `${escapeRegularExpression(javaPlatformExtension(platform))}$`,
    "u",
  );
  if (!expectedFilename.test(filename)) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} filename does not bind ${runtimeVersion}`,
    );
  }
  return runtimeVersion;
}

function parseLockedJavaPlatform(
  section,
  platform,
  lockedVersion,
  major,
) {
  const checksum = parseTomlString(
    section,
    "checksum",
    `${OCULIX_LOCK_PATH} Java ${platform}`,
  );
  if (!SHA256_PATTERN.test(checksum)) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java ${platform} checksum must be SHA-256`,
    );
  }
  const url = parseTomlString(
    section,
    "url",
    `${OCULIX_LOCK_PATH} Java ${platform}`,
  );
  const runtimeVersion = parseTemurinArtifactUrl(
    url,
    platform,
    lockedVersion,
    major,
  );
  return { checksum, platform, runtime_version: runtimeVersion, url };
}

function javaIdentityProjection(identity) {
  return {
    backend: identity.backend,
    major: identity.major,
    platforms: identity.platforms,
    resolved_version: identity.resolved_version,
    runtime_identity_digest: identity.runtime_identity_digest,
    runtime_version: identity.runtime_version,
    runtime_vendor: identity.runtime_vendor,
    solver_version: identity.solver_version,
    specifier: identity.specifier,
  };
}

function javaRuntimeIdentityProjection(identity) {
  return {
    runtime_version: identity.runtime_version,
    runtime_vendor: identity.runtime_vendor,
  };
}

export function parseOculixJavaIdentity(configContents, lockContents) {
  const policy = configuredTemurinPolicy(configContents);
  const sections = parseLockSections(lockContents);
  const toolSection = requireLockSection(sections, "java-tool");
  const lockedVersion = parseTomlString(
    toolSection,
    "version",
    `${OCULIX_LOCK_PATH} Java`,
  );
  const versionMatch = TEMURIN_RESOLVED_PATTERN.exec(lockedVersion);
  if (versionMatch === null || versionMatch[1] !== policy.major) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java version must resolve ${policy.specifier}`,
    );
  }
  const backend = parseTomlString(
    toolSection,
    "backend",
    `${OCULIX_LOCK_PATH} Java`,
  );
  if (backend !== "core:java") {
    throw new Error(`${OCULIX_LOCK_PATH} Java backend must be core:java`);
  }
  const specifiers = parseStringArray(
    toolSection,
    "specifiers",
    `${OCULIX_LOCK_PATH} Java`,
  );
  if (specifiers.length !== 1 || specifiers[0] !== policy.specifier) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java specifier must equal ${policy.specifier}`,
    );
  }

  const platformSections = sections.filter(
    ({ kind }) => kind === "java-platform",
  );
  const platforms = platformSections.map((section) => {
    const { platform } = section;
    if (!OCULIX_LOCK_PLATFORMS.includes(platform)) {
      throw new Error(
        `${OCULIX_LOCK_PATH} contains unsupported Java platform ${platform}`,
      );
    }
    return parseLockedJavaPlatform(
      section,
      platform,
      lockedVersion,
      policy.major,
    );
  }).sort((left, right) => left.platform.localeCompare(right.platform));
  const actualPlatforms = platforms.map(({ platform }) => platform);
  if (
    new Set(actualPlatforms).size !== OCULIX_LOCK_PLATFORMS.length ||
    JSON.stringify(actualPlatforms) !==
      JSON.stringify([...OCULIX_LOCK_PLATFORMS].sort())
  ) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java must lock every supported platform exactly once`,
    );
  }
  const runtimeVersions = new Set(
    platforms.map(({ runtime_version: runtimeVersion }) => runtimeVersion),
  );
  if (runtimeVersions.size !== 1) {
    throw new Error(
      `${OCULIX_LOCK_PATH} Java artifacts must bind one exact runtime build`,
    );
  }
  const runtimeVersion = [...runtimeVersions][0];
  const runtimeIdentity = {
    runtime_version: runtimeVersion,
    runtime_vendor: TEMURIN_VENDOR,
  };
  const identity = {
    backend,
    major: policy.major,
    platforms,
    resolved_version: lockedVersion.slice("temurin-".length),
    runtime_identity_digest: sha256(runtimeIdentity),
    runtime_version: runtimeVersion,
    runtime_vendor: TEMURIN_VENDOR,
    solver_version: versionMatch.slice(1, 4).join("."),
    specifier: policy.specifier,
  };
  return deepFreeze({
    ...identity,
    identity_digest: sha256(javaIdentityProjection(identity)),
  });
}

function repositoryEvidence(path, contents, revision, observedAt) {
  return {
    type: "repository-file",
    locator: path,
    revision,
    digest: sha256(contents),
    observed_at: observedAt,
  };
}

function javaRuntimeEvidence(identity, observedAt) {
  return [
    {
      type: "temurin-policy",
      locator: OCULIX_CONFIG_PATH,
      revision: identity.specifier,
      digest: sha256({
        major: identity.major,
        specifier: identity.specifier,
      }),
      observed_at: observedAt,
    },
    {
      type: "locked-java-runtime",
      locator: OCULIX_LOCK_PATH,
      revision: `temurin-${identity.resolved_version}`,
      digest: identity.identity_digest,
      observed_at: observedAt,
    },
    ...identity.platforms.map((platform) => ({
      type: "locked-java-artifact",
      locator: platform.url,
      revision: `temurin-${identity.resolved_version}:${platform.platform}`,
      digest: platform.checksum,
      observed_at: observedAt,
    })),
  ];
}

function assetNames(version) {
  return new Map(
    ["linux", "macos", "windows"].map((platform) => [
      platform,
      `oculixide-${version}-${platform}.jar`,
    ]),
  );
}

function selectedAssets(release, version) {
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub release assets are missing");
  }
  const expected = assetNames(version);
  const expectedNames = new Set(expected.values());
  const byName = new Map();
  for (const asset of release.assets) {
    if (expectedNames.has(asset?.name)) {
      if (byName.has(asset.name)) {
        throw new Error(`GitHub release duplicates asset ${asset.name}`);
      }
      byName.set(asset.name, asset);
    }
  }
  const assets = [];
  for (const name of [...expected.values()].sort()) {
    const asset = byName.get(name);
    if (asset === undefined) {
      throw new Error(`GitHub release is missing required asset ${name}`);
    }
    const id = releaseIdentity(asset);
    requireString(asset.browser_download_url, `${name} download URL`);
    if (
      typeof asset.digest !== "string" ||
      !SHA256_PATTERN.test(asset.digest)
    ) {
      throw new Error(`${name} must have an immutable SHA-256 digest`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`${name} must have a non-negative asset size`);
    }
    const expectedUrl =
      "https://github.com/oculix-org/Oculix/releases/download/" +
      `${release.tag_name}/${name}`;
    if (asset.browser_download_url !== expectedUrl) {
      throw new Error(`${name} download URL does not bind its release`);
    }
    assets.push({
      digest: asset.digest,
      id,
      locator: asset.browser_download_url,
      name,
      size: asset.size,
    });
  }
  return assets;
}

function oculixAssetPlatformName(version, platform) {
  const releasePlatform = {
    "linux-arm64": "linux",
    "linux-x64": "linux",
    "macos-arm64": "macos",
    "windows-x64": "windows",
  }[platform];
  return `oculixide-${version}-${releasePlatform}.jar`;
}

function candidateLockAssets(component) {
  const assetEvidence = component.candidate.evidence.filter(
    ({ type }) => type === "github-release-asset",
  );
  return OCULIX_LOCK_PLATFORMS.map((platform) => {
    const name = oculixAssetPlatformName(
      component.candidate.version,
      platform,
    );
    const matches = assetEvidence.filter(({ locator }) =>
      locator.endsWith(`/${name}`),
    );
    if (matches.length !== 1 || !SHA256_PATTERN.test(matches[0].digest)) {
      throw new Error(
        `Oculix RC evidence must bind exactly one ${name} asset`,
      );
    }
    let url;
    try {
      url = new URL(matches[0].locator);
    } catch {
      throw new Error(`Oculix RC ${name} asset URL is invalid`);
    }
    const pathMatch =
      /^\/oculix-org\/Oculix\/releases\/download\/([^/]+)\/([^/]+)$/u
        .exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      pathMatch === null ||
      pathMatch[2] !== name ||
      parseOculixRcTag(pathMatch[1])?.version !==
        component.candidate.version
    ) {
      throw new Error(
        `Oculix RC ${name} asset URL does not bind the candidate`,
      );
    }
    return {
      digest: matches[0].digest,
      platform,
      url: matches[0].locator,
    };
  });
}

function validateGeneratedOculixLock(
  lockContents,
  candidateVersion,
  candidateAssets,
) {
  const expectedAssetPlatforms = Array.isArray(candidateAssets)
    ? candidateAssets.map(({ platform }) => platform).sort()
    : [];
  if (
    new Set(expectedAssetPlatforms).size !==
      OCULIX_LOCK_PLATFORMS.length ||
    JSON.stringify(expectedAssetPlatforms) !==
      JSON.stringify([...OCULIX_LOCK_PLATFORMS].sort()) ||
    candidateAssets.some(
      ({ digest, url }) =>
        !SHA256_PATTERN.test(digest) ||
        typeof url !== "string" ||
        url.length === 0,
    )
  ) {
    throw new Error(
      "Generated Oculix lock validation requires every candidate asset",
    );
  }
  const sections = parseLockSections(lockContents);
  parseOculixToolRecord(sections, candidateVersion);
  const platformSections = sections.filter(
    ({ kind }) => kind === "oculix-platform",
  );
  const actualPlatforms = platformSections
    .map(({ platform }) => platform)
    .sort();
  if (
    new Set(actualPlatforms).size !== OCULIX_LOCK_PLATFORMS.length ||
    JSON.stringify(actualPlatforms) !==
      JSON.stringify([...OCULIX_LOCK_PLATFORMS].sort())
  ) {
    throw new Error(
      `${OCULIX_LOCK_PATH} must structurally lock every Oculix platform exactly once`,
    );
  }
  for (const expected of candidateAssets) {
    const section = requireLockSection(
      sections,
      "oculix-platform",
      expected.platform,
    );
    const context =
      `${OCULIX_LOCK_PATH} Oculix ${expected.platform}`;
    const url = parseTomlString(section, "url", context);
    if (url !== expected.url) {
      throw new Error(
        `${context} must bind the exact immutable candidate asset URL`,
      );
    }
  }
}

async function candidateEvidence(
  selection,
  { observedAt, resolveTagRevision },
) {
  const { release, tag, version } = selection;
  const releaseId = releaseIdentity(release);
  requireString(release.html_url, "GitHub release URL");
  const expectedReleaseUrl =
    `https://github.com/oculix-org/Oculix/releases/tag/${tag}`;
  if (release.html_url !== expectedReleaseUrl) {
    throw new Error("GitHub release URL does not bind the Oculix RC tag");
  }
  requireTimestamp(release.published_at, "GitHub release published_at");
  const tagRevision = requireRevision(
    await resolveTagRevision(tag, release),
    "Resolved Oculix tag revision",
  );
  const assets = selectedAssets(release, version);
  const releaseProjection = {
    assets,
    draft: release.draft,
    id: releaseId,
    prerelease: release.prerelease,
    published_at: release.published_at,
    tag,
    url: release.html_url,
  };

  return [
    {
      type: "github-release",
      locator: release.html_url,
      revision: `release-${releaseId}`,
      digest: sha256(releaseProjection),
      observed_at: observedAt,
    },
    {
      type: "git-tag",
      locator: `${release.html_url}^{}`,
      revision: tagRevision,
      digest: sha256({ tag, tagRevision }),
      observed_at: observedAt,
    },
    ...assets.map((asset) => ({
      type: "github-release-asset",
      locator: asset.locator,
      revision: `asset-${asset.id}`,
      digest: asset.digest,
      observed_at: observedAt,
    })),
  ];
}

function observationBase({
  capabilityCatalog,
  current,
  generatedAt,
  javaIdentity,
  repository,
}) {
  return {
    schema_version: 1,
    kind: "observation",
    generated_at: generatedAt,
    repository,
    capability_catalog: capabilityCatalog,
    provider_id: OCULIX_RC_PROVIDER_ID,
    disposition: {
      state: "current",
      reason_codes: [],
    },
    components: [
      {
        id: OCULIX_RC_COMPONENT_ID,
        lane: "oculix-rc",
        ecosystem: "mise",
        current,
        candidate: null,
        eventual_managed_paths: [OCULIX_CONFIG_PATH],
        affected_capabilities: [...OCULIX_CAPABILITIES],
      },
      {
        id: OCULIX_JAVA_COMPONENT_ID,
        lane: "oculix-rc",
        ecosystem: "mise",
        current: {
          version: javaIdentity.solver_version,
          evidence: javaRuntimeEvidence(javaIdentity, generatedAt),
        },
        candidate: null,
        eventual_managed_paths: [OCULIX_LOCK_PATH],
        affected_capabilities: [...OCULIX_CAPABILITIES],
      },
    ],
    relations: [
      {
        id: "oculix-rc-requires-java-runtime",
        type: "shares-runtime",
        from: OCULIX_RC_COMPONENT_ID,
        to: OCULIX_JAVA_COMPONENT_ID,
        hard: true,
        constraint: javaMajorConstraint(javaIdentity.major),
      },
    ],
  };
}

export async function collectOculixRcObservation({
  capabilityCatalog,
  generatedAt,
  listReleases,
  readRepositoryFile,
  repository,
  resolveTagRevision,
}) {
  requireTimestamp(generatedAt, "generatedAt");
  requireString(repository?.name, "repository.name");
  requireRevision(repository?.revision, "repository.revision");
  if (typeof readRepositoryFile !== "function") {
    throw new Error("readRepositoryFile must be a function");
  }
  if (typeof listReleases !== "function") {
    throw new Error("listReleases must be a function");
  }
  if (typeof resolveTagRevision !== "function") {
    throw new Error("resolveTagRevision must be a function");
  }

  const [configContents, lockContents] = await Promise.all(
    OCULIX_MANAGED_PATHS.map((path) => readRepositoryFile(path)),
  );
  const currentVersion = currentVersionFromConfig(configContents);
  assertCurrentLock(lockContents, currentVersion);
  const javaIdentity = parseOculixJavaIdentity(
    configContents,
    lockContents,
  );
  const document = observationBase({
    capabilityCatalog,
    generatedAt,
    javaIdentity,
    repository: structuredClone(repository),
    current: {
      version: currentVersion,
      evidence: [
        repositoryEvidence(
          OCULIX_CONFIG_PATH,
          configContents,
          repository.revision,
          generatedAt,
        ),
      ],
    },
  });

  let selection;
  try {
    selection = selectNewestOculixRc(
      await listReleases(),
      currentVersion,
    );
  } catch {
    document.disposition = {
      state: "unavailable",
      reason_codes: ["OCULIX_RC_SOURCE_UNAVAILABLE"],
    };
    return deepFreeze(document);
  }
  if (selection === null) {
    return deepFreeze(document);
  }

  try {
    document.components[0].candidate = {
      version: selection.version,
      evidence: await candidateEvidence(selection, {
        observedAt: generatedAt,
        resolveTagRevision,
      }),
    };
  } catch {
    document.disposition = {
      state: "unavailable",
      reason_codes: ["OCULIX_RC_EVIDENCE_UNAVAILABLE"],
    };
    return deepFreeze(document);
  }
  document.disposition = {
    state: "candidate",
    reason_codes: ["CANDIDATE_AVAILABLE"],
  };
  return deepFreeze(document);
}

export const discoverOculixRc = collectOculixRcObservation;

function javaComponent(observation) {
  const component = observation.components.find(
    ({ id }) => id === OCULIX_JAVA_COMPONENT_ID,
  );
  if (component === undefined || component.candidate !== null) {
    throw new Error(
      "Oculix RC observation must contain one current-only Java runtime",
    );
  }
  return component;
}

function javaIdentityFromObservation(observation) {
  const component = javaComponent(observation);
  const policyEvidence = component.current.evidence.filter(
    ({ type }) => type === "temurin-policy",
  );
  const runtimeEvidence = component.current.evidence.filter(
    ({ type }) => type === "locked-java-runtime",
  );
  if (policyEvidence.length !== 1 || runtimeEvidence.length !== 1) {
    throw new Error(
      "Oculix RC observation must contain one Java policy and runtime",
    );
  }
  const [policy] = policyEvidence;
  const [runtime] = runtimeEvidence;
  const relation = observation.relations.find(
    ({ id }) => id === "oculix-rc-requires-java-runtime",
  );
  const specifierMatch = TEMURIN_SPECIFIER_PATTERN.exec(policy.revision);
  const resolvedVersion =
    runtime.revision.startsWith("temurin-")
      ? runtime.revision.slice("temurin-".length)
      : "";
  const resolvedMatch = TEMURIN_RESOLVED_PATTERN.exec(
    `temurin-${resolvedVersion}`,
  );
  if (
    specifierMatch === null ||
    resolvedMatch === null ||
    resolvedMatch[1] !== specifierMatch[1]
  ) {
    throw new Error(
      "Oculix RC observation does not bind a strict Temurin runtime",
    );
  }
  const artifactEvidence = component.current.evidence.filter(
    ({ type }) => type === "locked-java-artifact",
  );
  const platforms = artifactEvidence.map((evidence) => {
    const separator = evidence.revision.lastIndexOf(":");
    const expectedPrefix = `${runtime.revision}:`;
    const platform = evidence.revision.startsWith(expectedPrefix)
      ? evidence.revision.slice(separator + 1)
      : "";
    if (
      !OCULIX_LOCK_PLATFORMS.includes(platform) ||
      !SHA256_PATTERN.test(evidence.digest)
    ) {
      throw new Error(
        "Oculix RC observation contains invalid Java artifact evidence",
      );
    }
    return {
      checksum: evidence.digest,
      platform,
      runtime_version: parseTemurinArtifactUrl(
        evidence.locator,
        platform,
        `temurin-${resolvedVersion}`,
        specifierMatch[1],
      ),
      url: evidence.locator,
    };
  })
    .sort((left, right) => left.platform.localeCompare(right.platform));
  const expectedPlatforms = [...OCULIX_LOCK_PLATFORMS].sort();
  const actualPlatforms = platforms.map(({ platform }) => platform);
  const runtimeVersions = new Set(
    platforms.map(({ runtime_version: runtimeVersion }) => runtimeVersion),
  );
  if (
    relation?.type !== "shares-runtime" ||
    relation.from !== OCULIX_RC_COMPONENT_ID ||
    relation.to !== OCULIX_JAVA_COMPONENT_ID ||
    relation.hard !== true ||
    relation.constraint !== javaMajorConstraint(specifierMatch[1]) ||
    JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms) ||
    runtimeVersions.size !== 1 ||
    component.current.version !== resolvedMatch.slice(1, 4).join(".") ||
    policy.digest !==
      sha256({
        major: specifierMatch[1],
        specifier: policy.revision,
      })
  ) {
    throw new Error(
      "Oculix RC observation does not bind its configured Java runtime",
    );
  }
  const runtimeVersion = [...runtimeVersions][0];
  const runtimeIdentity = {
    runtime_version: runtimeVersion,
    runtime_vendor: TEMURIN_VENDOR,
  };
  const identity = {
    backend: "core:java",
    major: specifierMatch[1],
    platforms,
    resolved_version: resolvedVersion,
    runtime_identity_digest: sha256(runtimeIdentity),
    runtime_version: runtimeVersion,
    runtime_vendor: TEMURIN_VENDOR,
    solver_version: component.current.version,
    specifier: policy.revision,
  };
  const identityDigest = sha256(javaIdentityProjection(identity));
  if (identityDigest !== runtime.digest) {
    throw new Error("Oculix RC Java runtime identity digest is inconsistent");
  }
  return deepFreeze({
    ...identity,
    component_id: component.id,
    identity_digest: identityDigest,
  });
}

function candidateComponent(observation) {
  if (
    observation?.kind !== "observation" ||
    observation.provider_id !== OCULIX_RC_PROVIDER_ID ||
    observation.disposition?.state !== "candidate"
  ) {
    throw new Error("Oculix RC qualification requires a candidate observation");
  }
  const candidates = observation.components.filter(
    (component) => component.candidate !== null,
  );
  if (candidates.length !== 1 || candidates[0].id !== OCULIX_RC_COMPONENT_ID) {
    throw new Error("Oculix RC observation must contain one candidate component");
  }
  return candidates[0];
}

function requireRunner(runner) {
  for (const key of ["name", "os", "arch"]) {
    requireString(runner?.[key], `runner.${key}`);
  }
  return {
    name: runner.name,
    os: runner.os,
    arch: runner.arch,
  };
}

export function createOculixRcQualificationPlan({
  observation,
  runner,
}) {
  const component = candidateComponent(observation);
  const java = javaIdentityFromObservation(observation);
  const oculixAssets = candidateLockAssets(component);
  const normalizedRunner = requireRunner(runner);
  return deepFreeze({
    schema_version: 1,
    provider_id: observation.provider_id,
    candidate_digest: subjectDigest(observation),
    candidate_version: component.candidate.version,
    java: structuredClone(java),
    oculix_assets: structuredClone(oculixAssets),
    repository: structuredClone(observation.repository),
    runner: normalizedRunner,
    workspace: {
      kind: "ephemeral-git-archive",
      source_revision: observation.repository.revision,
      managed_paths: [...OCULIX_MANAGED_PATHS],
    },
    lock: {
      platforms: [...OCULIX_LOCK_PLATFORMS],
      command: [
        "mise",
        "-E",
        "oculix",
        "lock",
        "--platform",
        OCULIX_LOCK_PLATFORMS.join(","),
        "java",
        "http:oculixide",
      ],
    },
    checks: structuredClone(OCULIX_QUALIFICATION_CHECKS),
  });
}

function outsideRepository(repositoryRoot, workspacePath) {
  const root = resolve(repositoryRoot);
  const workspace = resolve(workspacePath);
  const relation = relative(root, workspace);
  return (
    workspace !== root &&
    relation !== "" &&
    (relation.startsWith("..") || isAbsolute(relation))
  );
}

export async function createEphemeralOculixWorkspace({
  repositoryRoot,
  revision,
  runCommand = runOculixQualificationCommand,
}) {
  requireRevision(revision, "revision");
  const root = resolve(repositoryRoot);
  const status = await runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: root,
  });
  if (`${status?.stdout ?? ""}${status?.stderr ?? ""}`.trim().length > 0) {
    throw new Error(
      "Qualification source repository must be clean, including untracked files",
    );
  }
  const resolvedRevision = await runCommand({
    command: "git",
    args: ["rev-parse", "--verify", `${revision}^{commit}`],
    cwd: root,
  });
  if ((resolvedRevision?.stdout ?? "").trim() !== revision) {
    throw new Error("Qualification revision does not resolve exactly");
  }
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "oculix-rc-qualification-"),
  );
  const workspacePath = join(temporaryRoot, "repository");
  const archivePath = join(temporaryRoot, "repository.tar");
  const miseConfigPath = join(temporaryRoot, "mise-config");
  const miseStatePath = join(temporaryRoot, "mise-state");
  try {
    await runCommand({
      command: "git",
      args: [
        // `git archive` applies the effective end-of-line attributes, so the
        // archive stops being the exact revision on any host that rewrites them.
        // Two independent settings do that, and both are covered by tests:
        //   core.autocrlf=true  -- set system-wide on GitHub's windows-latest
        //   core.eol=crlf       -- applies when the source marks files as text
        //                          without pinning `eol` itself
        // Pinned here rather than relied upon from the source repository's
        // .gitattributes, because qualification digests and the before/after byte
        // comparison in applyOculixCandidate must not depend on the config of
        // whatever machine happens to run them.
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        revision,
      ],
      cwd: root,
    });
    await mkdir(workspacePath);
    await Promise.all([
      mkdir(miseConfigPath),
      mkdir(miseStatePath),
    ]);
    await runCommand({
      command: "tar",
      args: ["-xf", archivePath, "-C", workspacePath],
      cwd: temporaryRoot,
    });
    await rm(archivePath);
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  return {
    ephemeral: true,
    mise_environment: deepFreeze({
      MISE_CONFIG_DIR: miseConfigPath,
      MISE_STATE_DIR: miseStatePath,
      MISE_TRUSTED_CONFIG_PATHS: workspacePath,
    }),
    path: workspacePath,
    async dispose() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
  };
}

function requireWorkspaceMiseEnvironment(workspace) {
  const environment = workspace?.mise_environment;
  for (const key of [
    "MISE_CONFIG_DIR",
    "MISE_STATE_DIR",
    "MISE_TRUSTED_CONFIG_PATHS",
  ]) {
    requireString(environment?.[key], `workspace.mise_environment.${key}`);
  }
  if (
    resolve(environment.MISE_TRUSTED_CONFIG_PATHS) !==
    resolve(workspace.path) ||
    !outsideRepository(workspace.path, environment.MISE_CONFIG_DIR) ||
    !outsideRepository(workspace.path, environment.MISE_STATE_DIR)
  ) {
    throw new Error(
      "Qualification mise trust and state must be isolated to the archived workspace",
    );
  }
  return {
    MISE_CONFIG_DIR: environment.MISE_CONFIG_DIR,
    MISE_STATE_DIR: environment.MISE_STATE_DIR,
    MISE_TRUSTED_CONFIG_PATHS: environment.MISE_TRUSTED_CONFIG_PATHS,
  };
}

export async function runOculixQualificationCommand({
  args,
  command,
  cwd,
  environment = {},
}) {
  const result = await execFile(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

export function classifyOculixWarnings({ stderr = "", stdout = "" }) {
  const warnings = [];
  const seen = new Set();
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const normalized = line.trim();
    if (
      normalized.length > 0 &&
      WARNING_PATTERNS.some((pattern) => pattern.test(normalized)) &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);
      warnings.push(normalized);
    }
  }
  return warnings;
}

function commandOutput(result) {
  return {
    stderr:
      typeof result?.stderr === "string" ? result.stderr : "",
    stdout:
      typeof result?.stdout === "string" ? result.stdout : "",
  };
}

function parseRuntimeProperty(output, property) {
  const escaped = escapeRegularExpression(property);
  const matches = [
    ...output.matchAll(
      new RegExp(`^\\s*${escaped}\\s*=\\s*(\\S.*?)\\s*$`, "gmu"),
    ),
  ].map((match) => match[1]);
  if (matches.length !== 1) {
    throw new Error(`Java runtime output must contain one ${property}`);
  }
  return matches[0];
}

export async function observeOculixJavaRuntime({
  environment = {},
  runCommand = runOculixQualificationCommand,
  workspacePath,
}) {
  const result = await runCommand({
    command: "mise",
    args: [
      "-E",
      "oculix",
      "exec",
      "--",
      "java",
      "-XshowSettings:properties",
      "-version",
    ],
    cwd: workspacePath,
    environment,
  });
  const output = commandOutput(result);
  const combined = `${output.stdout}\n${output.stderr}`;
  const identity = {
    runtime_version: parseRuntimeProperty(
      combined,
      "java.runtime.version",
    ),
    runtime_vendor: parseRuntimeProperty(combined, "java.vendor"),
  };
  return deepFreeze({
    ...identity,
    identity_digest: sha256(javaRuntimeIdentityProjection(identity)),
    output_digest: sha256(output),
    warnings: classifyOculixWarnings(output),
  });
}

function replaceOculixVersion(configContents, currentVersion, candidateVersion) {
  const occurrences = configContents.split(currentVersion).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `${OCULIX_CONFIG_PATH} does not contain current Oculix ${currentVersion}`,
    );
  }
  const updated = configContents.replaceAll(currentVersion, candidateVersion);
  if (
    pinnedVersionFromConfig(updated) !== candidateVersion ||
    parseOculixRcTag(candidateVersion)?.version !== candidateVersion
  ) {
    throw new Error("Candidate Oculix config did not preserve one version pin");
  }
  return updated;
}

function diffProjection(entries) {
  return entries.map(({ after, before, path }) => ({
    after: sha256(after),
    before: sha256(before),
    path,
  }));
}

function requirePreparedJavaIdentity(
  configContents,
  lockContents,
  expectedIdentity,
  message,
) {
  let actual;
  try {
    actual = parseOculixJavaIdentity(configContents, lockContents);
  } catch (error) {
    throw new OculixJavaRuntimeIncompatibilityError(
      `${message}: ${error.message}`,
    );
  }
  if (actual.identity_digest !== expectedIdentity.identity_digest) {
    throw new OculixJavaRuntimeIncompatibilityError(message);
  }
  return actual;
}

export async function prepareOculixRcCandidate({
  candidateAssets,
  candidateVersion,
  currentVersion,
  javaIdentity,
  lockCommand,
  managedPaths,
  miseEnvironment = {},
  runCommand = runOculixQualificationCommand,
  workspacePath,
}) {
  const before = new Map(
    await Promise.all(
      managedPaths.map(async (path) => [
        path,
        await readFile(join(workspacePath, path)),
      ]),
    ),
  );
  requirePreparedJavaIdentity(
    before.get(OCULIX_CONFIG_PATH),
    before.get(OCULIX_LOCK_PATH),
    javaIdentity,
    "Ephemeral workspace Java does not match the collected identity",
  );
  const configPath = join(workspacePath, OCULIX_CONFIG_PATH);
  const configContents = before.get(OCULIX_CONFIG_PATH).toString("utf8");
  await writeFile(
    configPath,
    replaceOculixVersion(
      configContents,
      currentVersion,
      candidateVersion,
    ),
  );
  const lockResult = await runCommand({
    command: lockCommand[0],
    args: lockCommand.slice(1),
    cwd: workspacePath,
    environment: miseEnvironment,
  });
  const after = new Map(
    await Promise.all(
      managedPaths.map(async (path) => [
        path,
        await readFile(join(workspacePath, path)),
      ]),
    ),
  );
  const entries = managedPaths
    .map((path) => ({
      after: after.get(path),
      before: before.get(path),
      path,
    }))
    .filter(({ after: next, before: previous }) => !next.equals(previous));
  if (
    !entries.some(({ path }) => path === OCULIX_CONFIG_PATH) ||
    !entries.some(({ path }) => path === OCULIX_LOCK_PATH)
  ) {
    throw new Error(
      "Oculix candidate preparation must change config and generated lock",
    );
  }
  const lockText = after.get(OCULIX_LOCK_PATH).toString("utf8");
  validateGeneratedOculixLock(
    lockText,
    candidateVersion,
    candidateAssets,
  );
  const afterJava = requirePreparedJavaIdentity(
    after.get(OCULIX_CONFIG_PATH),
    after.get(OCULIX_LOCK_PATH),
    javaIdentity,
    "Oculix candidate preparation changed the review-gated Java runtime",
  );
  return deepFreeze({
    changed_paths: entries.map(({ path }) => path),
    diff_digest: sha256(diffProjection(entries)),
    java_identity_digest: afterJava.identity_digest,
    warnings: classifyOculixWarnings(commandOutput(lockResult)),
  });
}

export async function executeOculixQualificationCheck({
  check,
  miseEnvironment = {},
  observeJavaRuntime = observeOculixJavaRuntime,
  plan,
  runCommand = runOculixQualificationCommand,
  workspacePath,
}) {
  const environment = {
    ...check.environment,
    ...miseEnvironment,
  };
  const runtime = await observeJavaRuntime({
    environment,
    plan,
    runCommand,
    workspacePath,
  });
  try {
    const result = await runCommand({
      command: check.command[0],
      args: check.command.slice(1),
      cwd: workspacePath,
      environment,
    });
    const output = commandOutput(result);
    return {
      status: "pass",
      warnings: [
        ...new Set([
          ...runtime.warnings,
          ...classifyOculixWarnings(output),
        ]),
      ],
      output_digest: sha256({
        command: output,
        runtime_output_digest: runtime.output_digest,
      }),
      java_identity_digest: runtime.identity_digest,
    };
  } catch (error) {
    const output = commandOutput(error);
    return {
      status: "fail",
      warnings: [
        ...new Set([
          ...runtime.warnings,
          ...classifyOculixWarnings(output),
        ]),
      ],
      output_digest: sha256({
        command: output,
        error: String(error?.message ?? error),
        runtime_output_digest: runtime.output_digest,
      }),
      java_identity_digest: runtime.identity_digest,
    };
  }
}

function validateCheckResult(
  result,
  checkId,
  expectedRuntimeIdentityDigest,
) {
  if (!RESULT_STATUSES.has(result?.status)) {
    throw new Error(`${checkId} returned an invalid result status`);
  }
  if (
    !Array.isArray(result.warnings) ||
    result.warnings.some(
      (warning) => typeof warning !== "string" || warning.length === 0,
    )
  ) {
    throw new Error(`${checkId} warnings must be nonempty strings`);
  }
  const outputDigest =
    result.output_digest === undefined
      ? sha256(result.output ?? "")
      : result.output_digest;
  if (!SHA256_PATTERN.test(outputDigest)) {
    throw new Error(`${checkId} output digest must be SHA-256`);
  }
  const reportedJavaIdentity = result.java_identity_digest;
  if (
    typeof reportedJavaIdentity !== "string" ||
    !SHA256_PATTERN.test(reportedJavaIdentity)
  ) {
    throw new Error(
      `${checkId} must report the observed Java identity digest`,
    );
  }
  const javaCompatible =
    result.java_compatible !== false &&
    reportedJavaIdentity === expectedRuntimeIdentityDigest;
  return {
    javaCompatible,
    javaIdentityDigest: reportedJavaIdentity,
    outputDigest,
    status: javaCompatible ? result.status : "fail",
    warnings: [...result.warnings],
  };
}

function resultStatus(statuses) {
  for (const status of [
    "fail",
    "blocked",
    "unknown",
    "not-validated",
    "not-selected",
  ]) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  return "pass";
}

function executionEvidence({
  check,
  checkResult,
  diffDigest,
  plan,
}) {
  return {
    type: "qualification-check",
    locator:
      `runner://${encodeURIComponent(plan.runner.name)}/` +
      `${encodeURIComponent(check.id)}`,
    revision: plan.repository.revision,
    digest: sha256({
      candidate_digest: plan.candidate_digest,
      check,
      diff_digest: diffDigest,
      expected_java: plan.java,
      java_compatible: checkResult.javaCompatible,
      java_identity_digest: checkResult.javaIdentityDigest,
      output_digest: checkResult.outputDigest,
      repository: plan.repository,
      runner: plan.runner,
      status: checkResult.status,
      warnings: checkResult.warnings,
    }),
  };
}

function errorEvidence({ error, plan, stage }) {
  return {
    type: "qualification-error",
    locator:
      `runner://${encodeURIComponent(plan.runner.name)}/` +
      `${encodeURIComponent(stage)}`,
    revision: plan.repository.revision,
    digest: sha256({
      candidate_digest: plan.candidate_digest,
      error: String(error?.message ?? error),
      expected_java: plan.java,
      repository: plan.repository,
      runner: plan.runner,
      stage,
    }),
  };
}

function validationDocument({
  checkResults,
  diffDigest,
  disposition,
  error,
  generatedAt,
  observation,
  plan,
  stage,
}) {
  const component = candidateComponent(observation);
  const results = component.affected_capabilities.map((capabilityId) => {
    const relevant = checkResults.filter(
      ({ check }) => check.capability_id === capabilityId,
    );
    const evidence =
      relevant.length === 0
        ? [errorEvidence({ error, plan, stage })]
        : [
            {
              type: "generated-lock-diff",
              locator: plan.workspace.managed_paths.join(","),
              revision: plan.repository.revision,
              digest: diffDigest,
            },
            {
              type: "java-runtime-identity",
              locator:
                `${OCULIX_LOCK_PATH}#temurin-` +
                plan.java.resolved_version,
              revision: plan.repository.revision,
              digest: plan.java.identity_digest,
            },
            ...relevant.map(({ check, result }) =>
              executionEvidence({
                check,
                checkResult: result,
                diffDigest,
                plan,
              }),
            ),
          ];
    return {
      capability_id: capabilityId,
      status:
        relevant.length === 0
          ? disposition.state === "blocked"
            ? "blocked"
            : "unknown"
          : resultStatus(relevant.map(({ result }) => result.status)),
      warnings: [
        ...new Set(relevant.flatMap(({ result }) => result.warnings)),
      ].sort(),
      evidence,
    };
  });
  return {
    schema_version: 1,
    kind: "validation",
    generated_at: generatedAt,
    repository: structuredClone(observation.repository),
    capability_catalog: structuredClone(observation.capability_catalog),
    provider_id: observation.provider_id,
    candidate_digest: plan.candidate_digest,
    disposition,
    results,
  };
}

function qualificationDisposition(checkResults) {
  if (
    checkResults.some(({ result }) => result.javaCompatible === false)
  ) {
    return {
      state: "incompatible",
      reason_codes: ["OCULIX_RC_JAVA_RUNTIME_INCOMPATIBLE"],
    };
  }
  if (
    checkResults.some(({ result }) => result.status !== "pass")
  ) {
    return {
      state: "blocked",
      reason_codes: ["OCULIX_RC_VALIDATION_FAILED"],
    };
  }
  if (
    checkResults.some(({ result }) => result.warnings.length > 0)
  ) {
    return {
      state: "blocked",
      reason_codes: ["OCULIX_RC_VALIDATION_WARNING"],
    };
  }
  return {
    state: "independently-qualified",
    reason_codes: [],
  };
}

export async function qualifyOculixRc({
  contractOptions,
  createWorkspace = createEphemeralOculixWorkspace,
  generatedAt,
  observation,
  prepareCandidate = prepareOculixRcCandidate,
  repositoryRoot,
  runCheck = executeOculixQualificationCheck,
  runner,
}) {
  requireTimestamp(generatedAt, "generatedAt");
  const plan = createOculixRcQualificationPlan({ observation, runner });
  const component = candidateComponent(observation);
  let workspace;
  let miseEnvironment;
  let document;
  try {
    workspace = await createWorkspace({
      repositoryRoot,
      revision: observation.repository.revision,
    });
    if (
      workspace?.ephemeral !== true ||
      typeof workspace.path !== "string" ||
      typeof workspace.dispose !== "function" ||
      !outsideRepository(repositoryRoot, workspace.path)
    ) {
      throw new Error(
        "Qualification workspace must be ephemeral and outside the repository",
      );
    }
    miseEnvironment = requireWorkspaceMiseEnvironment(workspace);
    let preparation;
    try {
      preparation = await prepareCandidate({
        candidateAssets: plan.oculix_assets,
        candidateVersion: component.candidate.version,
        currentVersion: component.current.version,
        javaIdentity: plan.java,
        lockCommand: plan.lock.command,
        managedPaths: plan.workspace.managed_paths,
        miseEnvironment,
        workspacePath: workspace.path,
      });
      if (preparation.java_identity_digest !== plan.java.identity_digest) {
        throw new OculixJavaRuntimeIncompatibilityError(
          "Candidate preparation reported a different Java runtime",
        );
      }
      if (
        preparation.warnings !== undefined &&
        (!Array.isArray(preparation.warnings) ||
          preparation.warnings.some(
            (warning) =>
              typeof warning !== "string" || warning.length === 0,
          ))
      ) {
        throw new Error(
          "Candidate preparation warnings must be nonempty strings",
        );
      }
      if (
        !SHA256_PATTERN.test(preparation?.diff_digest) ||
        JSON.stringify([...preparation.changed_paths].sort()) !==
          JSON.stringify([...plan.workspace.managed_paths].sort())
      ) {
        throw new Error(
          "Candidate preparation must return the complete managed diff",
        );
      }
    } catch (error) {
      document = validationDocument({
        checkResults: [],
        diffDigest: sha256("preparation-failed"),
        disposition: {
          state:
            error instanceof OculixJavaRuntimeIncompatibilityError
              ? "incompatible"
              : "blocked",
          reason_codes: [
            error instanceof OculixJavaRuntimeIncompatibilityError
              ? "OCULIX_RC_JAVA_RUNTIME_INCOMPATIBLE"
              : "OCULIX_RC_PREPARATION_FAILED",
          ],
        },
        error,
        generatedAt,
        observation,
        plan,
        stage: "candidate-preparation",
      });
      return deepFreeze(document);
    }

    const checkResults = [];
    for (const check of plan.checks) {
      try {
        const result = validateCheckResult(
          await runCheck({
            candidateDigest: plan.candidate_digest,
            check,
            diffDigest: preparation.diff_digest,
            miseEnvironment,
            plan,
            workspacePath: workspace.path,
          }),
          check.id,
          plan.java.runtime_identity_digest,
        );
        result.warnings = [
          ...new Set([
            ...(preparation.warnings ?? []),
            ...result.warnings,
          ]),
        ].sort();
        checkResults.push({ check, result });
      } catch (error) {
        document = validationDocument({
          checkResults: [],
          diffDigest: preparation.diff_digest,
          disposition: {
            state: "unavailable",
            reason_codes: ["OCULIX_RC_VALIDATION_UNAVAILABLE"],
          },
          error,
          generatedAt,
          observation,
          plan,
          stage: check.id,
        });
        return deepFreeze(document);
      }
    }
    document = validationDocument({
      checkResults,
      diffDigest: preparation.diff_digest,
      disposition: qualificationDisposition(checkResults),
      generatedAt,
      observation,
      plan,
    });
    if (document.disposition.state === "independently-qualified") {
      validateIndependentQualification(
        observation,
        document,
        contractOptions,
      );
    }
    return deepFreeze(document);
  } catch (error) {
    document = validationDocument({
      checkResults: [],
      diffDigest: sha256("workspace-unavailable"),
      disposition: {
        state: "unavailable",
        reason_codes: ["OCULIX_RC_WORKSPACE_UNAVAILABLE"],
      },
      error,
      generatedAt,
      observation,
      plan,
      stage: "ephemeral-workspace",
    });
    return deepFreeze(document);
  } finally {
    if (workspace?.dispose !== undefined) {
      await workspace.dispose();
    }
  }
}
