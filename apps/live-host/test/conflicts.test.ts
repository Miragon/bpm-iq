/**
 * Conflict resolution use-case (src/application/conflicts.ts, #185) — the
 * gates and the lineage invalidation against injected fakes (no git). The git
 * mechanics of takeUpstream / keepWorkspace are covered in workspaces.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError } from "@designiq/http-kit";

import { type ConflictDeps, resolveConflict } from "../src/application/conflicts.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

/** one flagged file, nothing open — each test overrides what it probes */
function deps(over: Partial<ConflictDeps> = {}) {
  const calls: string[] = [];
  const dropped: string[] = [];
  const base: ConflictDeps = {
    workspaces: {
      ensure: async () => "/ws",
      conflicts: async () => ["processes/order.bpmn"],
      takeUpstream: async (_repo, path) => void calls.push(`main:${path}`),
      keepWorkspace: async (_repo, path) => void calls.push(`workspace:${path}`),
    },
    liveDocs: () => [],
    dropLineage: (room) => dropped.push(room),
  };
  return { deps: { ...base, ...over }, calls, dropped };
}

const rejectsWith = (code: string, status: number) => (e: unknown) => {
  assert.ok(e instanceof AppError);
  assert.equal(e.code, code);
  assert.equal(e.status, status);
  return true;
};

test("resolveConflict: keep main takes upstream's version of that one file and drops its lineage", async () => {
  const { deps: d, calls, dropped } = deps();
  const result = await resolveConflict(d, REPO, { path: "processes/order.bpmn", keep: "main" });
  assert.deepEqual(result, { path: "processes/order.bpmn", keep: "main" });
  assert.deepEqual(calls, ["main:processes/order.bpmn"]);
  assert.deepEqual(dropped, ["acme/models/processes/order.bpmn"], "the next open reseeds from main's version");
});

test("resolveConflict: keep workspace only clears the flag — no rewrite, no lineage drop", async () => {
  const { deps: d, calls, dropped } = deps();
  await resolveConflict(d, REPO, { path: "processes/order.bpmn", keep: "workspace" });
  assert.deepEqual(calls, ["workspace:processes/order.bpmn"]);
  assert.deepEqual(dropped, []);
});

test("resolveConflict: an unflagged path is a 404 — the flag list is the path-safety gate", async () => {
  const { deps: d, calls } = deps();
  for (const path of ["processes/other.bpmn", "../../etc/passwd"]) {
    await assert.rejects(resolveConflict(d, REPO, { path, keep: "main" }), rejectsWith("conflict/not-found", 404));
  }
  assert.deepEqual(calls, []);
});

test("resolveConflict: taking main's version of a file open in a live session is refused (409)", async () => {
  const { deps: d, calls } = deps({ liveDocs: () => ["acme/models/processes/order.bpmn"] });
  await assert.rejects(
    resolveConflict(d, REPO, { path: "processes/order.bpmn", keep: "main" }),
    rejectsWith("conflict/live-session", 409),
  );
  assert.deepEqual(calls, []);
  // keeping the workspace's version never rewrites the file — an open editor is fine
  await resolveConflict(d, REPO, { path: "processes/order.bpmn", keep: "workspace" });
  assert.deepEqual(calls, ["workspace:processes/order.bpmn"]);
});
