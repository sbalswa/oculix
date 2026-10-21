import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateCatalog } from "./plan-e2e.mjs";

const execFile = promisify(execFileCallback);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../../tests/e2e/capabilities.json",
);

export const EXIT_DRIFT = 1;
export const EXIT_CONFIGURATION = 2;
export const EXIT_API = 3;
export const DESCRIPTION_LIMIT = 100;
export const LABEL_NAME_LIMIT = 50;
export const MANAGED_PREFIX = "ci:e2e:";
const LABEL_COMPONENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const COLORS = {
  exact: "1d76db",
  full: "b60205",
  smoke: "0e8a16",
  tool: "5319e7",
};

export class ConfigurationError extends Error {}

export class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class ReconciliationError extends Error {}

function compareNames(left, right) {
  return left.name.localeCompare(right.name, "en");
}

function normalizeColor(color) {
  return String(color ?? "").toLowerCase();
}

function countCharacters(value) {
  return [...value].length;
}

function assertDescription(description, name) {
  if (countCharacters(description) > DESCRIPTION_LIMIT) {
    throw new ConfigurationError(
      `Description for ${name} exceeds ${DESCRIPTION_LIMIT} characters`,
    );
  }
}

function costSummary(capabilities) {
  return [
    ...new Set(capabilities.map((capability) => capability.cost_class)),
  ].sort().join(", ");
}

function capabilityCount(capabilities) {
  const count = capabilities.length;
  return `${count} ${count === 1 ? "capability" : "capabilities"}`;
}

function desiredLabel(name, color, description) {
  if (!name.startsWith(MANAGED_PREFIX)) {
    throw new ConfigurationError(
      `Managed label must start with ${MANAGED_PREFIX}: ${name}`,
    );
  }
  if (!/^[0-9a-f]{6}$/u.test(color)) {
    throw new ConfigurationError(`Invalid color for ${name}: ${color}`);
  }
  if (countCharacters(name) > LABEL_NAME_LIMIT) {
    throw new ConfigurationError(
      `Label name exceeds ${LABEL_NAME_LIMIT} characters: ${name}`,
    );
  }
  assertDescription(description, name);
  return { name, color, description };
}

function assertCapability(capability, index) {
  const prefix = `capabilities[${index}]`;
  if (
    capability === null ||
    typeof capability !== "object" ||
    Array.isArray(capability)
  ) {
    throw new ConfigurationError(`${prefix} must be an object`);
  }
  for (const key of [
    "browser",
    "cost_class",
    "id",
    "os",
    "selector",
    "stability",
    "tool",
  ]) {
    if (typeof capability[key] !== "string" || capability[key] === "") {
      throw new ConfigurationError(`${prefix}.${key} must be nonempty`);
    }
  }
  if (typeof capability.smoke !== "boolean") {
    throw new ConfigurationError(`${prefix}.smoke must be a boolean`);
  }
  for (const key of ["browser", "os", "tool"]) {
    if (!LABEL_COMPONENT_PATTERN.test(capability[key])) {
      throw new ConfigurationError(
        `${prefix}.${key} must be lowercase kebab-case`,
      );
    }
  }
  if (!["experimental", "stable"].includes(capability.stability)) {
    throw new ConfigurationError(
      `${prefix}.stability must be stable or experimental`,
    );
  }
  if (
    !["expensive", "specialized", "standard"].includes(
      capability.cost_class,
    )
  ) {
    throw new ConfigurationError(`${prefix}.cost_class is invalid`);
  }
  const expectedSelector =
    `${MANAGED_PREFIX}${capability.tool}:` +
    `${capability.os}:${capability.browser}`;
  if (capability.selector !== expectedSelector) {
    throw new ConfigurationError(
      `${prefix}.selector must equal ${expectedSelector}`,
    );
  }
}

export function deriveDesiredLabels(catalog) {
  try {
    validateCatalog(catalog);
  } catch (error) {
    throw new ConfigurationError(error.message);
  }
  catalog.capabilities.forEach(assertCapability);

  const stable = catalog.capabilities.filter(
    (capability) => capability.stability === "stable",
  );
  if (stable.length === 0) {
    throw new ConfigurationError(
      "Capability catalog must contain a stable capability",
    );
  }
  const selectors = stable.map((capability) => capability.selector);
  if (new Set(selectors).size !== selectors.length) {
    throw new ConfigurationError(
      "Stable capability selectors must be unique",
    );
  }

  const labels = stable.map((capability) =>
    desiredLabel(
      capability.selector,
      COLORS.exact,
      `Stable ${capability.tool} on ${capability.os}/` +
        `${capability.browser}; 1 capability; ` +
        `cost: ${capability.cost_class}.`,
    ),
  );
  const smoke = stable.filter((capability) => capability.smoke);
  if (smoke.length === 0) {
    throw new ConfigurationError(
      "Capability catalog must contain a stable smoke capability",
    );
  }
  labels.push(
    desiredLabel(
      `${MANAGED_PREFIX}smoke`,
      COLORS.smoke,
      `Stable smoke preset; ${capabilityCount(smoke)}; ` +
        `cost: ${costSummary(smoke)}.`,
    ),
    desiredLabel(
      `${MANAGED_PREFIX}all`,
      COLORS.full,
      `All stable E2E; ${capabilityCount(stable)}; ` +
        `cost: ${costSummary(stable)}.`,
    ),
  );

  const tools = [...new Set(stable.map((capability) => capability.tool))]
    .sort();
  for (const tool of tools) {
    const capabilities = stable.filter(
      (capability) => capability.tool === tool,
    );
    labels.push(
      desiredLabel(
        `${MANAGED_PREFIX}${tool}:all`,
        COLORS.tool,
        `All stable ${tool} E2E; ${capabilityCount(capabilities)}; ` +
          `cost: ${costSummary(capabilities)}.`,
      ),
    );
  }
  return labels.sort(compareNames);
}

function normalizedName(name) {
  return name.toLowerCase();
}

function isManaged(label) {
  return normalizedName(label.name).startsWith(MANAGED_PREFIX);
}

function managedSnapshot(labels) {
  return JSON.stringify(
    labels
      .filter(isManaged)
      .map((label) => ({
        name: label.name,
        color: normalizeColor(label.color),
        description: label.description ?? "",
      }))
      .toSorted(compareNames),
  );
}

export function diffLabels(actualLabels, desiredLabels) {
  const actualManaged = actualLabels
    .filter(isManaged)
    .toSorted(compareNames);
  const actualByName = new Map(
    actualManaged.map((label) => [normalizedName(label.name), label]),
  );
  const desiredByName = new Map(
    desiredLabels.map((label) => [normalizedName(label.name), label]),
  );
  if (desiredByName.size !== desiredLabels.length) {
    throw new ConfigurationError("Desired label names must be unique");
  }

  const create = [];
  const update = [];
  const unchanged = [];
  for (const desired of desiredLabels.toSorted(compareNames)) {
    const actual = actualByName.get(normalizedName(desired.name));
    if (actual === undefined) {
      create.push(desired);
      continue;
    }
    const fields = [];
    if (actual.name !== desired.name) {
      fields.push("name");
    }
    if (normalizeColor(actual.color) !== desired.color) {
      fields.push("color");
    }
    if ((actual.description ?? "") !== desired.description) {
      fields.push("description");
    }
    if (fields.length === 0) {
      unchanged.push(desired);
    } else {
      update.push({ actual, desired, fields });
    }
  }
  const stale = actualManaged.filter(
    (label) => !desiredByName.has(normalizedName(label.name)),
  );
  return { create, update, stale, unchanged };
}

export function hasDrift(diff) {
  return (
    diff.create.length > 0 ||
    diff.update.length > 0 ||
    diff.stale.length > 0
  );
}

export function formatDiff(diff, { mode = "dry-run", prune = false } = {}) {
  const lines = [`E2E label synchronization (${mode}):`];
  for (const label of diff.create) {
    lines.push(`  create ${label.name}`);
  }
  for (const entry of diff.update) {
    lines.push(
      `  update ${entry.actual.name} (${entry.fields.join(", ")})`,
    );
  }
  for (const label of diff.stale) {
    const action = mode === "apply" && prune ? "delete" : "stale";
    lines.push(`  ${action} ${label.name}`);
  }
  if (!hasDrift(diff)) {
    lines.push("  no drift");
  }
  lines.push(
    `Summary: create=${diff.create.length} ` +
      `update=${diff.update.length} stale=${diff.stale.length} ` +
      `unchanged=${diff.unchanged.length}`,
  );
  if (diff.stale.length > 0 && !(mode === "apply" && prune)) {
    lines.push("Stale managed labels are retained without --apply --prune.");
  }
  return `${lines.join("\n")}\n`;
}

function responseMessage(body, status) {
  if (
    body !== null &&
    typeof body === "object" &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return `HTTP ${status}`;
}

export class GitHubLabelsClient {
  constructor({
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetchImplementation = globalThis.fetch,
  }) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      throw new ConfigurationError(
        `Repository must use owner/name syntax: ${repository}`,
      );
    }
    if (typeof fetchImplementation !== "function") {
      throw new ConfigurationError("A Fetch implementation is required");
    }
    this.repository = repository;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/u, "");
    this.fetchImplementation = fetchImplementation;
  }

  async request(path, { method = "GET", body } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await this.fetchImplementation(
        `${this.apiUrl}${path}`,
        {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new GitHubApiError(
        `GitHub API request failed: ${error.message}`,
      );
    }
    let responseBody = null;
    if (response.status !== 204) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = null;
      }
    }
    if (!response.ok) {
      throw new GitHubApiError(
        `GitHub API ${method} ${path} failed: ` +
          responseMessage(responseBody, response.status),
        response.status,
      );
    }
    return responseBody;
  }

  async listLabels() {
    const labels = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `/repos/${this.repository}/labels?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new GitHubApiError(
          "GitHub labels response was not an array",
        );
      }
      labels.push(...batch);
      if (batch.length < 100) {
        return labels;
      }
    }
  }

  async createLabel(label) {
    await this.request(`/repos/${this.repository}/labels`, {
      method: "POST",
      body: label,
    });
  }

  async updateLabel(currentName, label) {
    await this.request(
      `/repos/${this.repository}/labels/` +
        encodeURIComponent(currentName),
      {
        method: "PATCH",
        body: {
          new_name: label.name,
          color: label.color,
          description: label.description,
        },
      },
    );
  }

  async deleteLabel(name) {
    await this.request(
      `/repos/${this.repository}/labels/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }
}

export async function synchronizeLabels({
  client,
  desiredLabels,
  mode = "dry-run",
  prune = false,
  output = process.stdout,
}) {
  if (!["apply", "check", "dry-run"].includes(mode)) {
    throw new ConfigurationError(`Unknown synchronization mode: ${mode}`);
  }
  if (prune && mode !== "apply") {
    throw new ConfigurationError("--prune requires --apply");
  }

  const previewLabels = await client.listLabels();
  const preview = diffLabels(previewLabels, desiredLabels);
  output.write(formatDiff(preview, { mode, prune }));
  if (mode !== "apply") {
    return { drift: hasDrift(preview), preview };
  }

  // Refetch immediately before mutation so an earlier preview cannot apply
  // operations against stale repository label state.
  const currentLabels = await client.listLabels();
  if (managedSnapshot(currentLabels) !== managedSnapshot(previewLabels)) {
    throw new ReconciliationError(
      "Managed GitHub labels changed after preview; rerun synchronization",
    );
  }
  const current = diffLabels(currentLabels, desiredLabels);
  for (const label of current.create) {
    await client.createLabel(label);
  }
  for (const entry of current.update) {
    await client.updateLabel(entry.actual.name, entry.desired);
  }
  if (prune) {
    for (const label of current.stale) {
      await client.deleteLabel(label.name);
    }
  }

  const verified = diffLabels(await client.listLabels(), desiredLabels);
  const failed =
    verified.create.length > 0 ||
    verified.update.length > 0 ||
    (prune && verified.stale.length > 0);
  if (failed) {
    throw new ReconciliationError(
      "GitHub labels still differ after synchronization",
    );
  }
  output.write(
    `Applied E2E labels: created=${current.create.length} ` +
      `updated=${current.update.length} ` +
      `deleted=${prune ? current.stale.length : 0}.\n`,
  );
  return { drift: hasDrift(verified), preview, applied: current, verified };
}

export function parseArguments(argv) {
  const options = {
    catalogPath: DEFAULT_CATALOG_PATH,
    mode: "dry-run",
    prune: false,
    repository: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (options.mode === "check") {
        throw new ConfigurationError("--apply and --check are exclusive");
      }
      options.mode = "apply";
    } else if (argument === "--check") {
      if (options.mode === "apply") {
        throw new ConfigurationError("--apply and --check are exclusive");
      }
      options.mode = "check";
    } else if (argument === "--prune") {
      options.prune = true;
    } else if (argument === "--catalog" || argument === "--repository") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigurationError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--catalog") {
        options.catalogPath = resolve(value);
      } else {
        options.repository = value;
      }
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new ConfigurationError(`Unknown argument: ${argument}`);
    }
  }
  if (options.prune && options.mode !== "apply") {
    throw new ConfigurationError("--prune requires --apply");
  }
  return options;
}

function usage() {
  return [
    "Usage: mise run github:e2e-labels -- [options]",
    "",
    "Options:",
    "  --check              Exit 1 when managed labels drift",
    "  --apply              Create and update managed labels",
    "  --prune              Delete stale labels; requires --apply",
    "  --repository OWNER/REPO",
    "  --catalog PATH",
    "  --help",
    "",
  ].join("\n");
}

async function readCatalog(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(
      `Could not read capability catalog: ${error.message}`,
    );
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ConfigurationError(
      `Could not parse capability catalog: ${error.message}`,
    );
  }
}

async function commandOutput(command, args) {
  try {
    const result = await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function resolveRepository(environment) {
  if (environment.GITHUB_REPOSITORY) {
    return environment.GITHUB_REPOSITORY;
  }
  const repository = await commandOutput(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  );
  if (repository) {
    return repository;
  }
  throw new ConfigurationError(
    "Set GITHUB_REPOSITORY or authenticate the gh CLI in a repository",
  );
}

async function resolveToken(environment, required) {
  const environmentToken =
    environment.GH_TOKEN ?? environment.GITHUB_TOKEN;
  if (environmentToken) {
    return environmentToken;
  }
  const token = await commandOutput("gh", ["auth", "token"]);
  if (token) {
    return token;
  }
  if (required) {
    throw new ConfigurationError(
      "Applying labels requires GH_TOKEN, GITHUB_TOKEN, or gh authentication",
    );
  }
  return undefined;
}

export async function runCli({
  argv = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  catalog,
  client,
} = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      output.write(usage());
      return 0;
    }
    const desiredLabels = deriveDesiredLabels(
      catalog ?? await readCatalog(options.catalogPath),
    );
    let labelsClient = client;
    if (labelsClient === undefined) {
      const repository =
        options.repository ?? await resolveRepository(environment);
      const token = await resolveToken(
        environment,
        options.mode === "apply",
      );
      labelsClient = new GitHubLabelsClient({
        repository,
        token,
        apiUrl:
          environment.GITHUB_API_URL ?? "https://api.github.com",
      });
    }
    const result = await synchronizeLabels({
      client: labelsClient,
      desiredLabels,
      mode: options.mode,
      prune: options.prune,
      output,
    });
    if (options.mode === "check" && result.drift) {
      return EXIT_DRIFT;
    }
    return 0;
  } catch (error) {
    errorOutput.write(`${error.message}\n`);
    if (
      error instanceof GitHubApiError ||
      error instanceof ReconciliationError
    ) {
      return EXIT_API;
    }
    return EXIT_CONFIGURATION;
  }
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  process.exitCode = await runCli();
}
