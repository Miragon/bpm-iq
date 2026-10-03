import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DEPTH, parseArguments } from "../../src/cli/arguments.ts";

test("parseArguments reads the metrics command with one file and an optional --json flag in any position", () => {
  assert.deepEqual(parseArguments(["metrics", "model.bpmn"]), { command: "metrics", file: "model.bpmn", json: false });
  assert.deepEqual(parseArguments(["metrics", "--json", "model.bpmn"]), {
    command: "metrics",
    file: "model.bpmn",
    json: true,
  });
});

test("parseArguments reads the outline command with its defaults and all options", () => {
  assert.deepEqual(parseArguments(["outline", "model.bpmn"]), {
    command: "outline",
    file: "model.bpmn",
    json: false,
    options: { around: undefined, depth: DEFAULT_DEPTH, bounds: false, full: false },
  });
  assert.deepEqual(
    parseArguments(["outline", "model.bpmn", "--around", "task_a", "--depth", "3", "--bounds", "--full", "--json"]),
    {
      command: "outline",
      file: "model.bpmn",
      json: true,
      options: { around: "task_a", depth: 3, bounds: true, full: true },
    },
  );
});

test("parseArguments reads the layout and edit commands", () => {
  assert.deepEqual(parseArguments(["layout", "a.bpmn", "--mode", "relayout", "--scope", "x,y", "--dry-run"]), {
    command: "layout",
    file: "a.bpmn",
    json: false,
    dryRun: true,
    request: { mode: "relayout", scope: { kind: "fragmentOf", ids: ["x", "y"] } },
  });
  assert.deepEqual(parseArguments(["layout", "a.bpmn", "--mode", "tidy", "--plane", "Process_A"]), {
    command: "layout",
    file: "a.bpmn",
    json: false,
    dryRun: false,
    request: { mode: "tidy", scope: { kind: "plane", id: "Process_A" } },
  });
  assert.deepEqual(parseArguments(["edit", "a.bpmn", "--ops", "ops.json", "--json"]), {
    command: "edit",
    file: "a.bpmn",
    json: true,
    dryRun: false,
    ops: "ops.json",
  });
});

test("parseArguments rejects a layout without or with an unknown mode, scope and plane together, edit without ops", () => {
  assert.equal(parseArguments(["layout", "a.bpmn"]), undefined);
  assert.equal(parseArguments(["layout", "a.bpmn", "--mode", "shuffle"]), undefined);
  assert.equal(parseArguments(["layout", "a.bpmn", "--mode", "tidy", "--scope", "x", "--plane", "P"]), undefined);
  assert.equal(parseArguments(["edit", "a.bpmn"]), undefined);
});

test("parseArguments rejects an unknown command, a missing or second file and unknown flags", () => {
  assert.equal(parseArguments(["explode", "a.bpmn"]), undefined);
  assert.equal(parseArguments(["metrics"]), undefined);
  assert.equal(parseArguments(["metrics", "a.bpmn", "b.bpmn"]), undefined);
  assert.equal(parseArguments(["metrics", "a.bpmn", "--yaml"]), undefined);
});

test("parseArguments rejects outline flags on metrics and invalid outline values", () => {
  assert.equal(parseArguments(["metrics", "a.bpmn", "--bounds"]), undefined);
  assert.equal(parseArguments(["outline", "a.bpmn", "--around"]), undefined);
  assert.equal(parseArguments(["outline", "a.bpmn", "--around", "--json"]), undefined);
  assert.equal(parseArguments(["outline", "a.bpmn", "--depth", "-1"]), undefined);
  assert.equal(parseArguments(["outline", "a.bpmn", "--depth", "two"]), undefined);
});
