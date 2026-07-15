/**
 * WebSocket connection ceiling (DoS guard) — the pure admit/release logic behind
 * the cell's upgrade handler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionLimiter } from "../src/domain/conn-limit.ts";

test("admits up to the global cap, then refuses", () => {
  const l = new ConnectionLimiter(3, 10);
  assert.ok(l.tryAcquire("a"));
  assert.ok(l.tryAcquire("b"));
  assert.ok(l.tryAcquire("c"));
  assert.equal(l.active, 3);
  assert.equal(l.tryAcquire("d"), false, "global cap reached");
});

test("per-IP cap stops one client monopolising slots; other IPs still admitted", () => {
  const l = new ConnectionLimiter(100, 2);
  assert.ok(l.tryAcquire("x"));
  assert.ok(l.tryAcquire("x"));
  assert.equal(l.tryAcquire("x"), false, "per-IP cap reached for x");
  assert.ok(l.tryAcquire("y"), "a different IP is unaffected");
});

test("release frees a global + per-IP slot and prunes the map at zero", () => {
  const l = new ConnectionLimiter(1, 1);
  assert.ok(l.tryAcquire("x"));
  assert.equal(l.tryAcquire("x"), false);
  l.release("x");
  assert.equal(l.active, 0);
  assert.ok(l.tryAcquire("x"), "slot freed after release");
  // release more than acquired must not underflow into negatives
  l.release("x");
  l.release("x");
  assert.equal(l.active, 0);
  assert.ok(l.tryAcquire("x"));
});
