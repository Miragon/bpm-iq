/**
 * Handoff-token verification (ADR 0002 cell login) — the cell trusts a
 * short-lived HMAC-signed identity token from the control plane, creates a
 * LOCAL session, and stores NO user token.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handoffSecret, signHandoff } from "@bpmiq/cell-protocol";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";

const SECRET = "handoff-secret";

/** mimic the control plane signing a handoff token */
function sign(claims: Record<string, unknown>, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function store(): SessionStore {
  return new SessionStore(new DatabaseSync(":memory:"));
}

test("valid handoff token yields the user identity", () => {
  const s = store();
  const user = s.verifyHandoff(
    sign({ login: "petra", name: "Petra", avatarUrl: null, provider: "github", exp: Date.now() / 1000 + 60 }),
    SECRET,
  );
  assert.equal(user?.login, "petra");
  assert.equal(user?.provider, "github");
});

test("expired handoff token is rejected", () => {
  const s = store();
  const user = s.verifyHandoff(sign({ login: "petra", exp: Date.now() / 1000 - 1 }), SECRET);
  assert.equal(user, undefined);
});

test("tampered signature is rejected", () => {
  const s = store();
  const token = sign({ login: "petra", exp: Date.now() / 1000 + 60 }, "attacker-secret");
  assert.equal(s.verifyHandoff(token, SECRET), undefined);
});

test("malformed / empty token is rejected", () => {
  const s = store();
  assert.equal(s.verifyHandoff(null, SECRET), undefined);
  assert.equal(s.verifyHandoff("garbage", SECRET), undefined);
  assert.equal(s.verifyHandoff("no-dot-payload", SECRET), undefined);
});

test("single-use: a token's jti (from the real signer) can be redeemed only once", () => {
  const s = store();
  const secret = handoffSecret("master", 7);
  const v = s.verifyHandoff(
    signHandoff({ login: "petra", name: "Petra", avatarUrl: null, provider: "github" }, secret, 60),
    secret,
  );
  assert.ok(v?.jti, "carries a unique jti");
  assert.equal(s.consumeHandoff(v.jti, v.handoffExp * 1000), true, "first redeem succeeds");
  assert.equal(s.consumeHandoff(v.jti, v.handoffExp * 1000), false, "replay refused");
});

test("a handoff session stores NO user token (zero-token, ADR 0001)", () => {
  const s = store();
  const user = s.verifyHandoff(sign({ login: "petra", exp: Date.now() / 1000 + 60 }), SECRET)!;
  const session = s.create(user); // no grant
  assert.equal(session.providerToken, "");
  assert.equal(session.refreshToken, undefined);
  // and it round-trips out of the store the same way
  const loaded = s.get(session.id);
  assert.equal(loaded?.user.login, "petra");
  assert.equal(loaded?.providerToken, "");
});
