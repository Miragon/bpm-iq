import assert from "node:assert/strict";
import { test } from "node:test";

import { fail, isMissingTool, ok, safe, unwrapToolResult } from "../index.ts";
import { toolText } from "../testing.ts";

test("ok: strings pass through, objects become pretty-printed JSON", () => {
  assert.deepEqual(ok("plain"), { content: [{ type: "text", text: "plain" }] });
  const result = ok({ a: 1 });
  assert.equal(result.content[0]?.text, JSON.stringify({ a: 1 }, null, 2));
  assert.equal(result.isError, undefined);
});

test("safe: a throw becomes fail() with the per-server prefix", async () => {
  const boom = () => {
    throw new Error("nope");
  };
  assert.deepEqual(await safe(boom)({}), fail("nope"));
  assert.deepEqual(await safe(boom, { prefix: "Unexpected error: " })({}), fail("Unexpected error: nope"));
});

test("unwrapToolResult: parses ok() payloads, throws the server message on isError", () => {
  assert.deepEqual(unwrapToolResult(ok({ a: 1 }), "t"), { a: 1 });
  assert.throws(() => unwrapToolResult(fail("agent-readable reason"), "t"), /agent-readable reason/);
  assert.throws(() => unwrapToolResult({ isError: true }, "t"), /t failed/);
});

test("isMissingTool: tool-not-found vs a real error", () => {
  assert.ok(isMissingTool(new Error("Tool list_todos not found"), "list_todos"));
  assert.ok(!isMissingTool(new Error("process 'x' not found"), "list_todos"));
});

test("toolText: raw first-block extraction for tests (prose stays prose)", () => {
  assert.deepEqual(toolText(fail("boom")), { isError: true, text: "boom" });
  assert.deepEqual(toolText(ok("no results.")), { isError: false, text: "no results." });
  assert.deepEqual(toolText({}), { isError: false, text: "" });
});
