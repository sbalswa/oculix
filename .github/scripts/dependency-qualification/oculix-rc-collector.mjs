import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
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
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
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

function assertCurrentLock(lockContents, currentVersion) {
  const text = String(lockContents);
  const escaped = currentVersion.replaceAll(".", String.raw`\.`);
  const matches = text.match(
    new RegExp(`^version = "${escaped}"$`, "gmu"),
  );
  if (matches?.length !== 1) {
    throw new Error(
      `${OCULIX_LOCK_PATH} must lock Oculix ${currentVersion} exactly once`,
    );
  }
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
        eventual_managed_paths: [...OCULIX_MANAGED_PATHS],
        affected_capabilities: [...OCULIX_CAPABILITIES],
      },
    ],
    relations: [],
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
  const document = observationBase({
    capabilityCatalog,
    generatedAt,
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
        repositoryEvidence(
          OCULIX_LOCK_PATH,
          lockContents,
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
  const normalizedRunner = requireRunner(runner);
  return deepFreeze({
    schema_version: 1,
    provider_id: observation.provider_id,
    candidate_digest: subjectDigest(observation),
    candidate_version: component.candidate.version,
    repository: structuredClone(observation.repository),
    runner: normalizedRunner,
    workspace: {
      kind: "ephemeral-copy",
      source_revision: observation.repository.revision,
      managed_paths: [...component.eventual_managed_paths],
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
}) {
  requireRevision(revision, "revision");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "oculix-rc-qualification-"),
  );
  const workspacePath = join(temporaryRoot, "repository");
  try {
    await cp(resolve(repositoryRoot), workspacePath, {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  return {
    ephemeral: true,
    path: workspacePath,
    async dispose() {
      await rm(temporaryRoot, { force: true, recursive: true });
    },
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

export async function prepareOculixRcCandidate({
  candidateVersion,
  currentVersion,
  lockCommand,
  managedPaths,
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
  await runCommand({
    command: lockCommand[0],
    args: lockCommand.slice(1),
    cwd: workspacePath,
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
  if (
    !lockText.includes(`version = "${candidateVersion}"`) ||
    OCULIX_LOCK_PLATFORMS.some(
      (platform) => !lockText.includes(`"platforms.${platform}"`),
    )
  ) {
    throw new Error(
      "Generated Oculix lock does not bind the candidate on every platform",
    );
  }
  return deepFreeze({
    changed_paths: entries.map(({ path }) => path),
    diff_digest: sha256(diffProjection(entries)),
  });
}

async function executePlannedCheck({
  check,
  runCommand = runOculixQualificationCommand,
  workspacePath,
}) {
  try {
    const result = await runCommand({
      command: check.command[0],
      args: check.command.slice(1),
      cwd: workspacePath,
      environment: check.environment,
    });
    return {
      status: "pass",
      warnings: [],
      output_digest: sha256({
        stderr: result?.stderr ?? "",
        stdout: result?.stdout ?? "",
      }),
    };
  } catch (error) {
    return {
      status: "fail",
      warnings: [],
      output_digest: sha256(String(error?.message ?? error)),
    };
  }
}

function validateCheckResult(result, checkId) {
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
  return {
    outputDigest,
    status: result.status,
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
              locator: component.eventual_managed_paths.join(","),
              revision: plan.repository.revision,
              digest: diffDigest,
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
  runCheck = executePlannedCheck,
  runner,
}) {
  requireTimestamp(generatedAt, "generatedAt");
  const plan = createOculixRcQualificationPlan({ observation, runner });
  const component = candidateComponent(observation);
  let workspace;
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
    let preparation;
    try {
      preparation = await prepareCandidate({
        candidateVersion: component.candidate.version,
        currentVersion: component.current.version,
        lockCommand: plan.lock.command,
        managedPaths: plan.workspace.managed_paths,
        workspacePath: workspace.path,
      });
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
          state: "blocked",
          reason_codes: ["OCULIX_RC_PREPARATION_FAILED"],
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
            plan,
            workspacePath: workspace.path,
          }),
          check.id,
        );
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
