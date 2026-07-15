/**
 * The control-plane ↔ cell wire contract, tested where it lives (no cross-app
 * import). Single-use (jti) enforcement is storage-backed and tested cell-side.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cellSecret, cellTokenKey, handoffSecret, signHandoff, verifyCellSecret, verifyHandoff } from "../src/index.ts";

const MASTER = "master";
const user = { login: "petra", name: "Petra", avatarUrl: null, provider: "github" };

test("derived secrets: per-tenant, per-purpose isolation + constant-time verify", () => {
  assert.notEqual(cellSecret(MASTER, 1), handoffSecret(MASTER, 1), "mint and handoff secrets differ");
  assert.notEqual(cellSecret(MASTER, 1), cellSecret(MASTER, 2), "per-tenant");
  assert.ok(verifyCellSecret(MASTER, 1, cellSecret(MASTER, 1)));
  assert.ok(!verifyCellSecret(MASTER, 1, cellSecret(MASTER, 2)), "another tenant's secret is refused");
  // the at-rest token key is a THIRD distinct purpose — a leaked mint secret (sent
  // as a Bearer on every mint) must not also unlock the persisted-token store
  assert.notEqual(cellTokenKey(MASTER, 1), cellSecret(MASTER, 1), "token key ≠ mint secret");
  assert.notEqual(cellTokenKey(MASTER, 1), handoffSecret(MASTER, 1), "token key ≠ handoff secret");
  assert.notEqual(cellTokenKey(MASTER, 1), cellTokenKey(MASTER, 2), "per-tenant");
});

test("handoff round-trip: sign → verify (byte-stable codec both sides share)", () => {
  const secret = handoffSecret(MASTER, 7);
  const token = signHandoff(user, secret, 60);
  const v = verifyHandoff(token, secret);
  assert.equal(v?.login, "petra");
  assert.ok(v?.jti, "carries a unique jti");
  assert.equal(typeof v?.exp, "number");
  // a token signed for tenant 7 must NOT verify with tenant 8's handoff secret
  assert.equal(verifyHandoff(token, handoffSecret(MASTER, 8)), undefined);
});

test("handoff expiry is enforced", () => {
  const secret = handoffSecret(MASTER, 7);
  assert.equal(verifyHandoff(signHandoff(user, secret, -1), secret), undefined);
});

test("handoff rejects a tampered payload (identity swap keeps the old mac)", () => {
  const secret = handoffSecret(MASTER, 7);
  const [, mac] = signHandoff(user, secret, 60).split(".");
  const forged =
    Buffer.from(JSON.stringify({ ...user, login: "attacker", exp: Math.floor(Date.now() / 1000) + 60 })).toString(
      "base64url",
    ) +
    "." +
    mac;
  assert.equal(verifyHandoff(forged, secret), undefined);
});
