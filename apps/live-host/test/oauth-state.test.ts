/**
 * live-host OAuth `state` browser-binding (login-CSRF / session-fixation fix). The
 * signed state carries a random nonce that must match a cookie set at /auth start —
 * so a state minted in the attacker's browser can't complete a login in the victim's.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";

const store = () => new SessionStore(new DatabaseSync(":memory:"));

test("oauth state: issue → verify passes only with the matching browser nonce", () => {
  const s = store();
  const { state, nonce } = s.issueState("github");
  assert.ok(s.verifyState(state, "github", nonce));
});

test("oauth state: a state without its browser nonce is rejected (the CSRF fix)", () => {
  const s = store();
  const { state } = s.issueState("github");
  assert.equal(s.verifyState(state, "github", undefined), false, "no cookie → reject");
  assert.equal(s.verifyState(state, "github", "someone-elses-nonce"), false, "wrong cookie → reject");
});

test("oauth state: rejects a provider mismatch, a tampered mac, and a null state", () => {
  const s = store();
  const { state, nonce } = s.issueState("github");
  assert.equal(s.verifyState(state, "gitlab", nonce), false, "provider prefix mismatch");
  const tampered = state.slice(0, -1) + (state.at(-1) === "A" ? "B" : "A");
  assert.equal(s.verifyState(tampered, "github", nonce), false, "tampered mac");
  assert.equal(s.verifyState(null, "github", nonce), false);
});

test("oauth state: each issue produces a fresh nonce", () => {
  const s = store();
  assert.notEqual(s.issueState("github").nonce, s.issueState("github").nonce);
});

test("oauth state survives a restart when a key is configured (derived secret)", () => {
  // two stores with the SAME key = the same process before/after a redeploy —
  // a state issued by the old process must verify in the new one
  const before = new SessionStore(new DatabaseSync(":memory:"), "enc-key");
  const after = new SessionStore(new DatabaseSync(":memory:"), "enc-key");
  const { state, nonce } = before.issueState("github");
  assert.ok(after.verifyState(state, "github", nonce), "derived state secret survives restarts");
  // different key (or keyless dev) → still isolated
  const other = new SessionStore(new DatabaseSync(":memory:"), "other-key");
  assert.equal(other.verifyState(state, "github", nonce), false, "a different key never verifies");
});

test("oauth state: keyless dev stays per-process (random secret, no cross-verify)", () => {
  const a = new SessionStore(new DatabaseSync(":memory:"));
  const b = new SessionStore(new DatabaseSync(":memory:"));
  const { state, nonce } = a.issueState("github");
  assert.ok(a.verifyState(state, "github", nonce));
  assert.equal(b.verifyState(state, "github", nonce), false);
});
