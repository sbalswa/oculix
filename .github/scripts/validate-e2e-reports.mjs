import { glob, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function parseJsonArray(name, value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new Error(`${name} must be a JSON array of nonempty strings`);
  }
  return parsed;
}

function repositoryPattern(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      `Required path must be repository-relative: ${pattern}`,
    );
  }
  return normalized;
}

async function matchingFiles(pattern, repositoryRoot) {
  const normalized = repositoryPattern(pattern);
  if (!/[*?[\]{}]/u.test(normalized)) {
    return [normalized];
  }
  const matches = [];
  for await (const match of glob(normalized, {
    cwd: repositoryRoot,
    exclude: ["**/node_modules/**"],
  })) {
    matches.push(match.replaceAll("\\", "/"));
  }
  if (matches.length === 0) {
    throw new Error(`Required path pattern matched no files: ${pattern}`);
  }
  return matches;
}

async function readNonemptyFile(path, repositoryRoot) {
  const normalized = repositoryPattern(path);
  const absolutePath = resolve(repositoryRoot, normalized);
  const repositoryPath = relative(repositoryRoot, absolutePath);
  if (
    repositoryPath === "" ||
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Required path escapes the repository: ${path}`);
  }
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Required file is missing: ${normalized}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Required file must be nonempty: ${normalized}`);
  }
  return {
    content: await readFile(absolutePath, "utf8"),
    path: normalized,
  };
}

async function validateRequiredFiles(patterns, repositoryRoot) {
  const validated = new Set();
  for (const pattern of patterns) {
    for (const path of await matchingFiles(pattern, repositoryRoot)) {
      const file = await readNonemptyFile(path, repositoryRoot);
      if (file.path.endsWith(".json")) {
        try {
          JSON.parse(file.content);
        } catch (error) {
          throw new Error(
            `Required JSON is invalid: ${file.path}: ${error.message}`,
          );
        }
      }
      validated.add(file.path);
    }
  }
  return validated;
}

function reportCapabilityId(report) {
  return report.capabilityId ?? report.capability?.id ?? null;
}

function violationRules(report) {
  const violations = report.accessibility?.counts?.violations;
  if (typeof violations === "number") {
    return violations;
  }
  if (
    violations !== null &&
    typeof violations === "object" &&
    typeof violations.rules === "number"
  ) {
    return violations.rules;
  }
  return null;
}

function artifactPaths(value, paths = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        paths.push(entry);
      } else {
        artifactPaths(entry, paths);
      }
    }
    return paths;
  }
  if (value === null || typeof value !== "object") {
    return paths;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "contentType" || key === "name") {
      continue;
    }
    if (typeof entry === "string") {
      paths.push(entry);
    } else {
      artifactPaths(entry, paths);
    }
  }
  return paths;
}

async function validateResultReport({
  capabilityId,
  path,
  repositoryRoot,
  requireAccessibility,
}) {
  const file = await readNonemptyFile(path, repositoryRoot);
  let report;
  try {
    report = JSON.parse(file.content);
  } catch (error) {
    throw new Error(
      `Result report JSON is invalid: ${path}: ${error.message}`,
    );
  }
  if (report.schemaVersion !== 1) {
    throw new Error(`${path} must use schemaVersion 1`);
  }
  if (reportCapabilityId(report) !== capabilityId) {
    throw new Error(
      `${path} capability must be ${capabilityId}, found ` +
        `${reportCapabilityId(report) ?? "(missing)"}`,
    );
  }
  if (!["smoke", "web-calculator"].includes(report.scenario)) {
    throw new Error(`${path} has an invalid scenario`);
  }
  if (report.status !== "passed") {
    throw new Error(`${path} must report a passed scenario`);
  }
  if (report.assertion?.status !== "passed") {
    throw new Error(`${path} must report a passed assertion`);
  }
  if (requireAccessibility && report.scenario === "web-calculator") {
    if (report.accessibility?.status !== "passed") {
      throw new Error(`${path} must report a passed accessibility audit`);
    }
    const violations = violationRules(report);
    if (violations === null) {
      throw new Error(`${path} must report accessibility violation counts`);
    }
    if (violations !== 0) {
      throw new Error(
        `${path} reports ${violations} blocking accessibility violation(s)`,
      );
    }
  }
  for (const artifactPath of artifactPaths(report.artifacts)) {
    await readNonemptyFile(artifactPath, repositoryRoot);
  }
  return report.scenario;
}

export async function validateE2EOutputs({
  capabilityId,
  repositoryRoot,
  requiredPatterns,
  resultReports,
  requireAccessibility,
}) {
  if (!capabilityId) {
    throw new Error("E2E_CAPABILITY_ID is required");
  }
  const required = await validateRequiredFiles(
    requiredPatterns,
    repositoryRoot,
  );
  const scenarios = [];
  for (const path of resultReports) {
    scenarios.push(
      await validateResultReport({
        capabilityId,
        path,
        repositoryRoot,
        requireAccessibility,
      }),
    );
  }
  return {
    files: required.size,
    reports: resultReports.length,
    scenarios,
  };
}

async function main(environment = process.env) {
  const repositoryRoot = resolve(
    environment.GITHUB_WORKSPACE ?? process.cwd(),
  );
  const result = await validateE2EOutputs({
    capabilityId: environment.E2E_CAPABILITY_ID,
    repositoryRoot,
    requiredPatterns: parseJsonArray(
      "E2E_REQUIRED_FILES",
      environment.E2E_REQUIRED_FILES ?? "[]",
    ),
    resultReports: parseJsonArray(
      "E2E_RESULT_REPORTS",
      environment.E2E_RESULT_REPORTS ?? "[]",
    ),
    requireAccessibility:
      environment.E2E_REQUIRE_ACCESSIBILITY === "true",
  });
  process.stdout.write(
    `Validated ${result.files} required file(s) and ` +
      `${result.reports} result report(s) for ` +
      `${environment.E2E_CAPABILITY_ID}.\n`,
  );
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
