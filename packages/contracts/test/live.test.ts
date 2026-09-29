/**
 * The live contract's ONE runtime helper besides the room names: the presence
 * color every client (web, VS Code, the Live Host's agent presence) derives
 * from the same principal must agree — one person, one color everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { movedNotice, parseMovedNotice, presenceColor } from "../src/live.ts";

test("presenceColor: deterministic per principal, always a hex color", () => {
  assert.equal(presenceColor("petra"), presenceColor("petra"));
  assert.match(presenceColor("petra"), /^#[0-9a-f]{6}$/);
  assert.match(presenceColor(""), /^#[0-9a-f]{6}$/);
  // the agent acting for a person is a different participant
  assert.notEqual(presenceColor("agent:petra"), presenceColor("petra"));
});

test("movedNotice: round-trips through parseMovedNotice; anything else is no notice (#208)", () => {
  assert.deepEqual(parseMovedNotice(movedNotice("acme/models", "processes/o2c.bpmn", "Petra")), {
    type: "bpmiq/moved",
    to: "processes/o2c.bpmn",
    room: "acme/models/processes/o2c.bpmn",
    by: "Petra",
  });
  for (const payload of [
    "not json",
    "null",
    JSON.stringify({ type: "other", to: "x.bpmn" }),
    JSON.stringify({ type: "bpmiq/moved" }),
    JSON.stringify({ type: "bpmiq/moved", to: "" }),
    JSON.stringify({ type: "bpmiq/moved", to: "../../etc/passwd", room: "a/b/../../etc/passwd" }),
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn" }),
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn", room: "a/b/p/other.bpmn" }),
  ]) {
    assert.equal(parseMovedNotice(payload), undefined, payload);
  }
});
