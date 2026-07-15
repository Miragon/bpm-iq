/** AppError + errorBody — the typed-error → HTTP mapping (src/errors.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError, errorBody } from "../src/index.ts";

test("AppError: explicit fields, defaults, instanceof Error", () => {
  const e = new AppError("release/version-bump-required", "bump it", { status: 422, expose: true });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "AppError");
  assert.equal(e.code, "release/version-bump-required");
  assert.equal(e.status, 422);
  assert.equal(e.expose, true);
  assert.equal(e.message, "bump it");

  const d = new AppError("x/y", "m");
  assert.equal(d.status, 500, "default status");
  assert.equal(d.expose, false, "default: not exposed to anonymous callers");
});

test("AppError: cause passes through; absent cause leaves no cause property", () => {
  const inner = new Error("git plumbing");
  const e = new AppError("x/y", "m", { cause: inner });
  assert.equal(e.cause, inner);
  assert.equal("cause" in new AppError("x/y", "m"), false);
});

test("errorBody: expose=true shows the message even to anonymous callers; code always included", () => {
  const { status, body } = errorBody(
    new AppError("release/upstream-changed", "upstream geändert", { status: 409, expose: true }),
  );
  assert.equal(status, 409);
  assert.deepEqual(body, { error: "upstream geändert", code: "release/upstream-changed" });
});

test("errorBody: expose=false sanitizes for anonymous but keeps the machine code", () => {
  const e = new AppError("repo/secret-detail", "path /var/lib/x leaked", { status: 404 });
  assert.deepEqual(errorBody(e), { status: 404, body: { error: "internal error", code: "repo/secret-detail" } });
  // authenticated caller gets the actionable text
  assert.deepEqual(errorBody(e, { authenticated: true }), {
    status: 404,
    body: { error: "path /var/lib/x leaked", code: "repo/secret-detail" },
  });
});

test("errorBody: plain Error → 500; message iff authenticated; NO code key (legacy body shape)", () => {
  const e = new Error("fs path /data/workspaces boom");
  const anon = errorBody(e);
  assert.deepEqual(anon, { status: 500, body: { error: "internal error" } });
  assert.equal("code" in anon.body, false, "plain-Error bodies must stay byte-identical to before");
  assert.deepEqual(errorBody(e, { authenticated: true }), {
    status: 500,
    body: { error: "fs path /data/workspaces boom" },
  });
});

test("errorBody: non-Error thrown values are String()ed", () => {
  assert.deepEqual(errorBody("boom", { authenticated: true }), { status: 500, body: { error: "boom" } });
  assert.deepEqual(errorBody(42), { status: 500, body: { error: "internal error" } });
  assert.deepEqual(errorBody(undefined, { authenticated: true }), { status: 500, body: { error: "undefined" } });
});
