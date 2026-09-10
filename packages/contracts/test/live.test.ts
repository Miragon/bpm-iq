/**
 * The live contract's ONE runtime helper besides the room names: the presence
 * color every client (web, VS Code, the Live Host's agent presence) derives
 * from the same principal must agree — one person, one color everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { presenceColor } from "../src/live.ts";

test("presenceColor: deterministic per principal, always a hex color", () => {
  assert.equal(presenceColor("petra"), presenceColor("petra"));
  assert.match(presenceColor("petra"), /^#[0-9a-f]{6}$/);
  assert.match(presenceColor(""), /^#[0-9a-f]{6}$/);
  // the agent acting for a person is a different participant
  assert.notEqual(presenceColor("agent:petra"), presenceColor("petra"));
});
