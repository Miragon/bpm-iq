/**
 * LoginCodeStore (src/application/login-codes.ts): the properties the editor
 * sign-in stands on — single-use, short TTL, unknown codes refused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { LoginCodeStore } from "../src/application/login-codes.ts";

test("issue → redeem yields the session id exactly once", () => {
  const store = new LoginCodeStore();
  const code = store.issue("sess-1");
  assert.equal(store.redeem(code), "sess-1");
  assert.equal(store.redeem(code), undefined, "single-use");
});

test("TTL: an expired code is refused, and swept on the next issue", () => {
  let now = 1_000_000;
  const store = new LoginCodeStore(() => now);
  const code = store.issue("sess-1");
  now += 60_001;
  assert.equal(store.redeem(code), undefined);
});

test("unknown codes are refused; codes are unguessable and distinct", () => {
  const store = new LoginCodeStore();
  assert.equal(store.redeem("no-such-code"), undefined);
  const a = store.issue("s");
  const b = store.issue("s");
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});
