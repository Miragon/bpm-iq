/**
 * Sync-to-default use-case (src/application/sync.ts) — the two safety gates and
 * the lineage invalidation, against injected fakes (no git). The git mechanics
 * of resetToDefault are covered separately in workspaces.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError } from "@designiq/http-kit";

import { type SyncDeps, syncRepo } from "../src/application/sync.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const REPO: ConnectedRepo = {
  fullName: "acme/models",
  defaultBranch: "main",
  private: false,
  avatarUrl: null,
  installationId: 1,
  suspended: false,
};

/** deps that would happily reset — each test overrides one gate */
function deps(over: Partial<SyncDeps> = {}) {
  const calls = { ensure: 0, reset: 0 };
  const dropped: string[] = [];
  const base: SyncDeps = {
    workspaces: {
      isHostRepo: () => false,
      ensure: async () => {
        calls.ensure++;
        return "/ws";
      },
      resetToDefault: async () => {
        calls.reset++;
        return ["processes/order.bpmn", "processes/sub/check-credit.bpmn"];
      },
    },
    liveDocs: () => [],
    dropLineage: (room) => dropped.push(room),
  };
  return { deps: { ...base, ...over } as SyncDeps, calls, dropped };
}

test("syncRepo: happy path resets, drops each changed file's lineage, returns the wire shape", async () => {
  const { deps: d, calls, dropped } = deps();
  const result = await syncRepo(d, REPO);
  assert.deepEqual(result, {
    branch: "main",
    changed: ["processes/order.bpmn", "processes/sub/check-credit.bpmn"],
  });
  assert.equal(calls.ensure, 1, "provisions the checkout before resetting");
  assert.equal(calls.reset, 1);
  assert.deepEqual(
    dropped,
    ["acme/models/processes/order.bpmn", "acme/models/processes/sub/check-credit.bpmn"],
    "each reset file's room lineage is invalidated (repo-qualified room name)",
  );
});

test("syncRepo: the in-place host checkout is refused (422) before any git", async () => {
  const { deps: d, calls } = deps({
    workspaces: {
      isHostRepo: () => true,
      ensure: async () => "/ws",
      resetToDefault: async () => {
        throw new Error("must not run");
      },
    },
  });
  await assert.rejects(syncRepo(d, REPO), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, "sync/host-repo");
    assert.equal(e.status, 422);
    return true;
  });
  assert.equal(calls.reset, 0);
});

test("syncRepo: a repo with an open live session is refused (409) — never races a reseed", async () => {
  const { deps: d, calls } = deps({
    // an open doc of THIS repo blocks; a foreign repo's session does not
    liveDocs: () => ["other/repo/processes/x.bpmn", "acme/models/processes/order.bpmn"],
  });
  await assert.rejects(syncRepo(d, REPO), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, "sync/live-sessions");
    assert.equal(e.status, 409);
    return true;
  });
  assert.equal(calls.ensure, 0, "gated before provisioning");
  assert.equal(calls.reset, 0);
});

test("syncRepo: a foreign repo's live session does not block", async () => {
  const { deps: d, calls } = deps({ liveDocs: () => ["other/repo/processes/order.bpmn"] });
  await syncRepo(d, REPO);
  assert.equal(calls.reset, 1, "only THIS repo's sessions gate the reset");
});

test("syncRepo: a discarded process rename sends its todos back to the old id; decisions, moves and merged renames need nothing (#208)", async () => {
  const moves: Array<{ from: string; to: string; file: string }> = [];
  const order: string[] = [];
  const { deps: base } = deps();
  const d: SyncDeps = {
    ...base,
    workspaces: {
      ...base.workspaces,
      renames: async () => {
        order.push("renames");
        return [
          { from: "processes/invoice-handling.bpmn", to: "processes/billing.bpmn" },
          { from: "processes/credit.dmn", to: "processes/credit-limit.dmn" },
          { from: "processes/order.bpmn", to: "processes/archive/order.bpmn" },
          // released and merged meanwhile — the reset keeps delivery.bpmn
          { from: "processes/shipping.bpmn", to: "processes/delivery.bpmn" },
        ];
      },
      resetToDefault: async () => {
        order.push("reset");
        // what the reset restores or removes — the merged rename is no change
        return [
          "processes/archive/order.bpmn",
          "processes/billing.bpmn",
          "processes/credit-limit.dmn",
          "processes/credit.dmn",
          "processes/invoice-handling.bpmn",
          "processes/order.bpmn",
        ];
      },
    },
    todoJobs: { move: (_repo, from, to) => void moves.push({ from, to: to.process, file: to.file }) },
  };
  await syncRepo(d, REPO, "petra");
  assert.deepEqual(order, ["renames", "reset"], "the journal is read BEFORE the reset clears it");
  assert.deepEqual(moves, [{ from: "billing", to: "invoice-handling", file: "processes/invoice-handling.bpmn" }]);
});
