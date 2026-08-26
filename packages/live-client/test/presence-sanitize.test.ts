/**
 * Awareness payload sanitizing at the session boundary (#115 review finding,
 * execution-verified): a hostile or version-skewed peer can put ARBITRARY
 * JSON into its awareness fields — a malformed CanvasPresence reaching the
 * canvas renderer threw after the presence layer was already cleared,
 * blanking every peer's cursors for all viewers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeCanvas, sanitizeUser } from "../src/session.ts";

test("sanitizeCanvas: well-formed states pass through", () => {
  assert.deepEqual(sanitizeCanvas({ cursor: { x: 1.5, y: -2 }, selection: ["a", "b"] }), {
    cursor: { x: 1.5, y: -2 },
    selection: ["a", "b"],
  });
  assert.deepEqual(sanitizeCanvas({ cursor: null, selection: [] }), { cursor: null, selection: [] });
});

test("sanitizeCanvas: every malformed shape the review reproduced is normalized, never thrown on", () => {
  // selection missing / null / non-array — the render()-blanking payloads
  assert.deepEqual(sanitizeCanvas({ cursor: { x: 1, y: 2 } }), { cursor: { x: 1, y: 2 }, selection: [] });
  assert.deepEqual(sanitizeCanvas({ selection: null }), { cursor: null, selection: [] });
  assert.deepEqual(sanitizeCanvas({ selection: 42 }), { cursor: null, selection: [] });
  // non-object canvas values
  assert.equal(sanitizeCanvas(5), undefined);
  assert.equal(sanitizeCanvas("x"), undefined);
  assert.equal(sanitizeCanvas(null), undefined);
  // arrays ARE objects — still a valid (empty) presence, no throw
  assert.deepEqual(sanitizeCanvas([]), { cursor: null, selection: [] });
  // non-string ids are dropped, string ids survive
  assert.deepEqual(sanitizeCanvas({ selection: ["ok", 7, null, {}] })?.selection, ["ok"]);
});

test("sanitizeCanvas: non-finite cursor coordinates become no-cursor (translate(NaN) poisons the SVG)", () => {
  assert.deepEqual(sanitizeCanvas({ cursor: { x: NaN, y: 2 }, selection: [] })?.cursor, null);
  assert.deepEqual(sanitizeCanvas({ cursor: { x: 1, y: Infinity }, selection: [] })?.cursor, null);
  assert.deepEqual(sanitizeCanvas({ cursor: { x: "1", y: 2 }, selection: [] })?.cursor, null);
  assert.deepEqual(sanitizeCanvas({ cursor: "here", selection: [] })?.cursor, null);
});

test("sanitizeUser: requires string name AND color, passes extras through for render-site guards", () => {
  assert.deepEqual(sanitizeUser({ name: "petra", color: "#fa8100" }), { name: "petra", color: "#fa8100" });
  const full = sanitizeUser({ name: "p", color: "#fff", avatarUrl: "https://x", kind: "agent" });
  assert.equal((full as { avatarUrl?: string }).avatarUrl, "https://x");
  assert.equal(sanitizeUser({ name: "petra" }), undefined);
  assert.equal(sanitizeUser({ color: "#fff" }), undefined);
  assert.equal(sanitizeUser({ name: 1, color: "#fff" }), undefined);
  assert.equal(sanitizeUser("petra"), undefined);
  assert.equal(sanitizeUser(null), undefined);
});
