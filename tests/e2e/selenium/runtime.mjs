import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilityId } from "./configuration.mjs";

export const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DIAGNOSTICS_DIRECTORY = resolve(
  HARNESS_DIRECTORY,
  "diagnostics",
);
export const RUNTIME_DIRECTORY = resolve(HARNESS_DIRECTORY, ".runtime");

export function runtimeStatePath(capability) {
  return resolve(
    RUNTIME_DIRECTORY,
    `${capabilityId(capability)}-resources.json`,
  );
}

export function scenarioLogDirectory(capability, scenario) {
  return resolve(
    RUNTIME_DIRECTORY,
    "logs",
    capabilityId(capability),
    scenario,
  );
}
