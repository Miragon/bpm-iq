/**
 * The control-plane ↔ cell wire contract, tested where it lives (no cross-app
 * import): derived per-tenant secrets + constant-time verification.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cellSecret, cellTokenKey, verifyCellSecret } from "../src/index.ts";

const MASTER = "master";

test("derived secrets: per-tenant, per-purpose isolation + constant-time verify", () => {
  assert.notEqual(cellSecret(MASTER, 1), cellSecret(MASTER, 2), "per-tenant");
  assert.ok(verifyCellSecret(MASTER, 1, cellSecret(MASTER, 1)));
  assert.ok(!verifyCellSecret(MASTER, 1, cellSecret(MASTER, 2)), "another tenant's secret is refused");
  // the at-rest token key is a distinct purpose — a leaked mint secret (sent
  // as a Bearer on every mint) must not also unlock the persisted-token store
  assert.notEqual(cellTokenKey(MASTER, 1), cellSecret(MASTER, 1), "token key ≠ mint secret");
  assert.notEqual(cellTokenKey(MASTER, 1), cellTokenKey(MASTER, 2), "per-tenant");
});
