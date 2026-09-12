import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelInfo, RepoInfo } from "@bpmiq/contracts/live-host";

import { modelItems, modelUri, repoItems } from "../../model-picker.ts";

const repo = (over: Partial<RepoInfo>): RepoInfo => ({
  fullName: "acme/models",
  owner: "acme",
  name: "models",
  defaultBranch: "main",
  avatarUrl: null,
  suspended: false,
  permission: "write",
  processCount: 3,
  decisionCount: 1,
  dirtyCount: 0,
  liveSessions: 0,
  ...over,
});
const model = (over: Partial<ModelInfo>): ModelInfo => ({
  repo: "acme/models",
  id: "order",
  name: "order",
  path: "processes/order.bpmn",
  notation: "bpmn",
  folder: "",
  dirty: false,
  liveSessions: 0,
  ...over,
});

test("repoItems: writable, non-suspended repos by name, with their counts", () => {
  const items = repoItems([
    repo({ fullName: "zeta/models" }),
    repo({ fullName: "acme/models", liveSessions: 2 }),
    repo({ fullName: "acme/readonly", permission: "none" }),
    repo({ fullName: "acme/suspended", suspended: true }),
    repo({ fullName: "acme/uncloned", processCount: null, decisionCount: null }),
  ]);
  assert.deepEqual(
    items.map((i) => i.value.fullName),
    ["acme/models", "acme/uncloned", "zeta/models"],
  );
  assert.equal(items[0]?.label, "$(repo) acme/models");
  assert.equal(items[0]?.description, "3 processes · 1 decisions · 2 live");
  assert.equal(items[1]?.description, "", "no counts before the workspace exists");
});

test("modelItems: folder then name; description carries notation, folder, live peers, dirty", () => {
  const items = modelItems([
    model({ name: "zeta", path: "processes/zeta.dmn", notation: "dmn" }),
    model({
      name: "sub",
      path: "processes/subprocesses/sub.bpmn",
      folder: "subprocesses",
      liveSessions: 1,
      dirty: true,
    }),
    model({ name: "alpha", path: "processes/alpha.bpmn" }),
  ]);
  assert.deepEqual(
    items.map((i) => i.value.name),
    ["alpha", "zeta", "sub"],
  );
  assert.equal(items[0]?.description, "bpmn");
  assert.equal(items[0]?.detail, "processes/alpha.bpmn");
  assert.equal(items[2]?.description, "bpmn · subprocesses · 1 live · unreleased changes");
});

test("modelUri: the path is the room name", () => {
  assert.equal(modelUri("acme/models", "processes/order.bpmn"), "bpm-live:/acme/models/processes/order.bpmn");
});
