import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DESCRIPTION_LIMIT,
  EXIT_API,
  EXIT_CONFIGURATION,
  EXIT_DRIFT,
  GitHubApiError,
  GitHubLabelsClient,
  LABEL_NAME_LIMIT,
  ReconciliationError,
  deriveDesiredLabels,
  diffLabels,
  formatDiff,
  hasDrift,
  parseArguments,
  runCli,
  synchronizeLabels,
} from "./sync-e2e-labels.mjs";

const catalog = JSON.parse(
  await readFile(
    new URL("../../tests/e2e/capabilities.json", import.meta.url),
    "utf8",
  ),
);

function memoryOutput() {
  let content = "";
  return {
    stream: {
      write(value) {
        content += value;
      },
    },
    read() {
      return content;
    },
  };
}

function githubLabel(label) {
  return {
    id: 1,
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

function mutableClient(initialLabels) {
  let labels = structuredClone(initialLabels);
  const calls = {
    create: [],
    delete: [],
    list: 0,
    update: [],
  };
  return {
    calls,
    async listLabels() {
      calls.list += 1;
      return structuredClone(labels);
    },
    async createLabel(label) {
      calls.create.push(structuredClone(label));
      labels.push(githubLabel(label));
    },
    async updateLabel(currentName, desired) {
      calls.update.push({
        currentName,
        desired: structuredClone(desired),
      });
      labels = labels.map((label) =>
        label.name === currentName ? githubLabel(desired) : label,
      );
    },
    async deleteLabel(name) {
      calls.delete.push(name);
      labels = labels.filter((label) => label.name !== name);
    },
  };
}

test("derives the ten current stable exact and preset labels", () => {
  const labels = deriveDesiredLabels(catalog);
  assert.deepEqual(
    labels.map((label) => label.name),
    [
      "ci:e2e:all",
      "ci:e2e:cypress:all",
      "ci:e2e:cypress:ubuntu:chrome",
      "ci:e2e:oculix:all",
      "ci:e2e:oculix:ubuntu:chromium",
      "ci:e2e:playwright:all",
      "ci:e2e:playwright:ubuntu:chromium",
      "ci:e2e:selenium:all",
      "ci:e2e:selenium:ubuntu:chromium",
      "ci:e2e:smoke",
    ],
  );
  assert.equal(new Set(labels.map((label) => label.color)).size, 4);
  assert.ok(
    labels.every(
      (label) => [...label.description].length <= DESCRIPTION_LIMIT,
    ),
  );
  assert.ok(
    labels.every(
      (label) => [...label.name].length <= LABEL_NAME_LIMIT,
    ),
  );
  assert.ok(
    labels.every((label) => /[0-9]+ capabilit(?:y|ies)/u.test(
      label.description,
    )),
  );
  assert.equal(
    labels.find((label) => label.name === "ci:e2e:all").color,
    "b60205",
  );
  assert.equal(
    labels.find((label) => label.name === "ci:e2e:smoke").color,
    "0e8a16",
  );
  assert.equal(
    labels.find((label) => label.name === "ci:e2e:selenium:all").color,
    "5319e7",
  );
  assert.equal(
    labels.find(
      (label) => label.name === "ci:e2e:selenium:ubuntu:chromium",
    ).color,
    "1d76db",
  );
});

test("excludes experimental capabilities and experimental-only tools", () => {
  const experimental = {
    ...structuredClone(catalog.capabilities[0]),
    id: "webdriver-windows-firefox",
    selector: "ci:e2e:webdriver:windows:firefox",
    tool: "webdriver",
    os: "windows",
    browser: "firefox",
    task: "e2e:webdriver",
    runner: "windows-latest",
    smoke: false,
    stability: "experimental",
  };
  const labels = deriveDesiredLabels({
    ...catalog,
    capabilities: [...catalog.capabilities, experimental],
  });
  assert.equal(labels.length, 10);
  assert.ok(
    labels.every((label) => !label.name.includes("webdriver")),
  );
});

test("updates expansion counts and sorted cost classes", () => {
  const additional = {
    ...structuredClone(catalog.capabilities[0]),
    id: "selenium-windows-firefox",
    selector: "ci:e2e:selenium:windows:firefox",
    os: "windows",
    browser: "firefox",
    cost_class: "specialized",
    smoke: true,
  };
  const labels = deriveDesiredLabels({
    ...catalog,
    capabilities: [...catalog.capabilities, additional],
  });
  const selenium = labels.find(
    (label) => label.name === "ci:e2e:selenium:all",
  );
  const smoke = labels.find(
    (label) => label.name === "ci:e2e:smoke",
  );
  const full = labels.find(
    (label) => label.name === "ci:e2e:all",
  );
  assert.match(selenium.description, /2 capabilities/);
  assert.match(selenium.description, /specialized, standard/);
  assert.match(smoke.description, /2 capabilities/);
  assert.match(full.description, /5 capabilities/);
});

test("derivation is deterministic across catalog order", () => {
  const forward = deriveDesiredLabels(catalog);
  const reverse = deriveDesiredLabels({
    ...catalog,
    capabilities: catalog.capabilities.toReversed(),
  });
  assert.deepEqual(reverse, forward);
});

test("rejects duplicate capabilities and overlong label names", () => {
  assert.throws(
    () =>
      deriveDesiredLabels({
        ...catalog,
        capabilities: [
          ...catalog.capabilities,
          structuredClone(catalog.capabilities[0]),
        ],
      }),
    /id values must be unique/,
  );
  const overlong = structuredClone(catalog);
  overlong.capabilities[0].tool = "x".repeat(80);
  overlong.capabilities[0].id =
    `${overlong.capabilities[0].tool}-ubuntu-chromium`;
  overlong.capabilities[0].selector =
    `ci:e2e:${overlong.capabilities[0].tool}:ubuntu:chromium`;
  overlong.capabilities[0].task =
    `e2e:${overlong.capabilities[0].tool}`;
  assert.throws(
    () => deriveDesiredLabels(overlong),
    /exceeds 50 characters/,
  );
});

test("diff classifies create, update, stale, and unchanged labels", () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 3);
  const actual = [
    githubLabel(desired[0]),
    {
      ...githubLabel(desired[1]),
      description: "old description",
    },
    {
      ...githubLabel(desired[2]),
      color: desired[2].color.toUpperCase(),
    },
    {
      name: "ci:e2e:retired:all",
      color: "ABCDEF",
      description: "old",
    },
    {
      name: "enhancement",
      color: "a2eeef",
      description: "unmanaged",
    },
  ];
  actual.splice(0, 1);
  const diff = diffLabels(actual, desired);
  assert.deepEqual(diff.create.map((label) => label.name), [
    desired[0].name,
  ]);
  assert.deepEqual(
    diff.update.map((entry) => ({
      name: entry.desired.name,
      fields: entry.fields,
    })),
    [{ name: desired[1].name, fields: ["description"] }],
  );
  assert.deepEqual(diff.unchanged.map((label) => label.name), [
    desired[2].name,
  ]);
  assert.deepEqual(diff.stale.map((label) => label.name), [
    "ci:e2e:retired:all",
  ]);
  assert.equal(hasDrift(diff), true);
});

test("label name case drifts while color case does not", () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 1);
  const actual = [{
    ...githubLabel(desired[0]),
    name: desired[0].name.toUpperCase(),
    color: desired[0].color.toUpperCase(),
  }];
  const diff = diffLabels(actual, desired);
  assert.deepEqual(diff.update[0].fields, ["name"]);
});

test("formatted output is deterministic and explains retained stale labels", () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 1);
  const diff = diffLabels(
    [{ name: "ci:e2e:z:all", color: "ffffff", description: "" }],
    desired,
  );
  assert.equal(
    formatDiff(diff),
    [
      "E2E label synchronization (dry-run):",
      `  create ${desired[0].name}`,
      "  stale ci:e2e:z:all",
      "Summary: create=1 update=0 stale=1 unchanged=0",
      "Stale managed labels are retained without --apply --prune.",
      "",
    ].join("\n"),
  );
});

test("dry-run and check modes never mutate labels", async () => {
  const desired = deriveDesiredLabels(catalog);
  for (const mode of ["dry-run", "check"]) {
    const client = mutableClient([]);
    const output = memoryOutput();
    const result = await synchronizeLabels({
      client,
      desiredLabels: desired,
      mode,
      output: output.stream,
    });
    assert.equal(result.drift, true);
    assert.equal(client.calls.list, 1);
    assert.deepEqual(client.calls.create, []);
    assert.deepEqual(client.calls.update, []);
    assert.deepEqual(client.calls.delete, []);
    assert.match(output.read(), /create=10/);
  }
});

test("apply refetches, creates and updates, verifies, and retains stale", async () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 2);
  const client = mutableClient([
    {
      ...githubLabel(desired[0]),
      description: "old",
    },
    {
      name: "ci:e2e:retired:all",
      color: "ffffff",
      description: "old",
    },
  ]);
  const output = memoryOutput();
  const result = await synchronizeLabels({
    client,
    desiredLabels: desired,
    mode: "apply",
    output: output.stream,
  });
  assert.equal(client.calls.list, 3);
  assert.deepEqual(
    client.calls.create.map((label) => label.name),
    [desired[1].name],
  );
  assert.deepEqual(
    client.calls.update.map((entry) => entry.currentName),
    [desired[0].name],
  );
  assert.deepEqual(client.calls.delete, []);
  assert.equal(result.drift, true);
  assert.match(output.read(), /deleted=0/);
});

test("apply tolerates unrelated label changes after preview", async () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 1);
  let listCall = 0;
  const unrelated = {
    name: "enhancement",
    color: "a2eeef",
    description: "Unmanaged label",
  };
  const client = {
    async listLabels() {
      listCall += 1;
      if (listCall === 1) {
        return [githubLabel(desired[0])];
      }
      return [githubLabel(desired[0]), unrelated];
    },
    async createLabel() {
      assert.fail("unchanged managed state requires no create");
    },
    async updateLabel() {
      assert.fail("unchanged managed state requires no update");
    },
    async deleteLabel() {
      assert.fail("unmanaged labels must never be deleted");
    },
  };
  await synchronizeLabels({
    client,
    desiredLabels: desired,
    mode: "apply",
    output: memoryOutput().stream,
  });
  assert.equal(listCall, 3);
});

test("apply aborts if managed labels change after the displayed preview", async () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 1);
  const concurrent = {
    name: "ci:e2e:concurrent:all",
    color: "ffffff",
    description: "Added after preview",
  };
  let listCall = 0;
  const deletes = [];
  const client = {
    async listLabels() {
      listCall += 1;
      return listCall === 1
        ? [githubLabel(desired[0])]
        : [githubLabel(desired[0]), concurrent];
    },
    async createLabel() {
      assert.fail("state change must abort before create");
    },
    async updateLabel() {
      assert.fail("state change must abort before update");
    },
    async deleteLabel(name) {
      deletes.push(name);
    },
  };
  await assert.rejects(
    synchronizeLabels({
      client,
      desiredLabels: desired,
      mode: "apply",
      prune: true,
      output: memoryOutput().stream,
    }),
    (error) => {
      assert.ok(error instanceof ReconciliationError);
      assert.match(error.message, /changed after preview/);
      return true;
    },
  );
  assert.deepEqual(deletes, []);
});

test("apply with prune explicitly deletes stale managed labels", async () => {
  const desired = deriveDesiredLabels(catalog).slice(0, 1);
  const client = mutableClient([
    githubLabel(desired[0]),
    {
      name: "ci:e2e:retired:all",
      color: "ffffff",
      description: "old",
    },
    {
      name: "bug",
      color: "d73a4a",
      description: "unmanaged",
    },
  ]);
  const result = await synchronizeLabels({
    client,
    desiredLabels: desired,
    mode: "apply",
    prune: true,
    output: memoryOutput().stream,
  });
  assert.deepEqual(client.calls.delete, ["ci:e2e:retired:all"]);
  assert.equal(result.drift, false);
});

test("GitHub client paginates labels until a short page", async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: `label-${index}`,
    color: "ffffff",
    description: "",
  }));
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options });
    const body = url.endsWith("page=1")
      ? firstPage
      : [{ name: "last", color: "000000", description: "" }];
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  };
  const client = new GitHubLabelsClient({
    repository: "owner/repository",
    token: "secret",
    fetchImplementation,
  });
  const labels = await client.listLabels();
  assert.equal(labels.length, 101);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /per_page=100&page=1$/);
  assert.match(requests[1].url, /per_page=100&page=2$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
});

test("GitHub API failures retain status without exposing credentials", async () => {
  const client = new GitHubLabelsClient({
    repository: "owner/repository",
    token: "do-not-print",
    fetchImplementation: async () => ({
      ok: false,
      status: 403,
      async json() {
        return { message: "rate limited" };
      },
    }),
  });
  await assert.rejects(
    client.listLabels(),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /do-not-print/);
      assert.match(error.message, /rate limited/);
      return true;
    },
  );
});

test("GitHub update uses the REST API new_name field", async () => {
  const requests = [];
  const client = new GitHubLabelsClient({
    repository: "owner/repository",
    token: "secret",
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
      };
    },
  });
  await client.updateLabel("CI:E2E:OLD", {
    name: "ci:e2e:new",
    color: "1d76db",
    description: "Updated label",
  });
  assert.match(requests[0].url, /labels\/CI%3AE2E%3AOLD$/);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    new_name: "ci:e2e:new",
    color: "1d76db",
    description: "Updated label",
  });
});

test("argument parsing defaults to dry-run and gates destructive pruning", () => {
  assert.deepEqual(
    {
      ...parseArguments([]),
      catalogPath: "<default>",
    },
    {
      catalogPath: "<default>",
      mode: "dry-run",
      prune: false,
      repository: undefined,
    },
  );
  assert.deepEqual(
    {
      ...parseArguments([
        "--apply",
        "--prune",
        "--repository",
        "owner/repository",
      ]),
      catalogPath: "<default>",
    },
    {
      catalogPath: "<default>",
      mode: "apply",
      prune: true,
      repository: "owner/repository",
    },
  );
  assert.throws(() => parseArguments(["--prune"]), /requires --apply/);
  assert.throws(
    () => parseArguments(["--check", "--apply"]),
    /exclusive/,
  );
});

test("CLI distinguishes drift, configuration, and API failures", async () => {
  const driftClient = mutableClient([]);
  assert.equal(
    await runCli({
      argv: ["--check"],
      catalog,
      client: driftClient,
      output: memoryOutput().stream,
      errorOutput: memoryOutput().stream,
    }),
    EXIT_DRIFT,
  );
  assert.equal(
    await runCli({
      argv: ["--prune"],
      catalog,
      client: driftClient,
      output: memoryOutput().stream,
      errorOutput: memoryOutput().stream,
    }),
    EXIT_CONFIGURATION,
  );
  const apiClient = {
    async listLabels() {
      throw new GitHubApiError("unavailable", 503);
    },
  };
  assert.equal(
    await runCli({
      argv: [],
      catalog,
      client: apiClient,
      output: memoryOutput().stream,
      errorOutput: memoryOutput().stream,
    }),
    EXIT_API,
  );
});
