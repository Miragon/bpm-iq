/**
 * The live contract's ONE runtime helper besides the room names: the presence
 * color every client (web, VS Code, the Live Host's agent presence) derives
 * from the same principal must agree — one person, one color everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MOVED_NOTICE, movedNotice, parseMovedNotice, presenceColor } from "../src/live.ts";

test("presenceColor: deterministic per principal, always a hex color", () => {
  assert.equal(presenceColor("petra"), presenceColor("petra"));
  assert.match(presenceColor("petra"), /^#[0-9a-f]{6}$/);
  assert.match(presenceColor(""), /^#[0-9a-f]{6}$/);
  // the agent acting for a person is a different participant
  assert.notEqual(presenceColor("agent:petra"), presenceColor("petra"));
});

test("movedNotice: round-trips through parseMovedNotice; anything else is no notice (#208)", () => {
  assert.deepEqual(parseMovedNotice(movedNotice("acme/models", "processes/o2c.bpmn", "Petra")), {
    type: "bpmiq/moved", // legacy-name-ok: frozen wire value
    to: "processes/o2c.bpmn",
    room: "acme/models/processes/o2c.bpmn",
    by: "Petra",
  });
  for (const payload of [
    "not json",
    "null",
    JSON.stringify({ type: "other", to: "x.bpmn" }),
    JSON.stringify({ type: "bpmiq/moved" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "../../etc/passwd", room: "a/b/../../etc/passwd" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn" }), // legacy-name-ok
    JSON.stringify({ type: "bpmiq/moved", to: "p/x.bpmn", room: "a/b/p/other.bpmn" }), // legacy-name-ok
  ]) {
    assert.equal(parseMovedNotice(payload), undefined, payload);
  }
});

test("MOVED_NOTICE is frozen: a client built before any product rename still follows a move", () => {
  // Spelled in two halves ON PURPOSE: a search/replace of the product name
  // rewrites the constant and every fixture above in the same breath, and the
  // round-trip stays green — this spelling it cannot reach.
  const frozen = "bpm" + "iq/moved";
  assert.equal(MOVED_NOTICE, frozen);
  // what the Live Host sends is what an old client compares against …
  const sent = JSON.parse(movedNotice("acme/models", "processes/o2c.bpmn", "Petra")) as { type: string };
  assert.equal(sent.type, frozen);
  // … and a notice in the old spelling is still a notice
  const legacy = JSON.stringify({ type: frozen, to: "p/x.bpmn", room: "acme/models/p/x.bpmn", by: "Petra" });
  assert.equal(parseMovedNotice(legacy)?.to, "p/x.bpmn");
});
