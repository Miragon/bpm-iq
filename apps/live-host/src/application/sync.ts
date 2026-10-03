/**
 * Sync-to-default read/write use-case: hard-reset a repo's workspace onto
 * origin/<defaultBranch> ("load the latest state from main"). The DESTRUCTIVE
 * counterpart to the automatic reconcile — it deliberately discards uncommitted
 * live edits, so the web client confirms the discard before calling it.
 *
 * Two safety gates before any git touches the tree (Variant A, the schlanke
 * path):
 *   - the in-place host checkout is refused (a hard reset there wipes the
 *     operator's own monorepo working tree, not just models)
 *   - a repo with OPEN live sessions is refused — a reset races the reseed of
 *     a doc someone is editing; close the sessions first (mirrors reconcile,
 *     which also stands down under live docs)
 *
 * Pure orchestration over injected surfaces (the git subprocess stays behind
 * WorkspaceManager, lineage behind dropLineage). ApiOptions structurally
 * satisfies SyncDeps — the returned shape IS the wire format (SyncResult).
 */
import { roomName, roomPrefix } from "@designiq/contracts/live";
import type { SyncResult } from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";
import { byExtension, modelStem } from "@designiq/notations";

import type { ConnectedRepo } from "../repos/registry.ts";

export interface SyncDeps {
  workspaces: {
    /** the in-place host checkout must never be hard-reset */
    isHostRepo(fullName: string): boolean;
    /** provision the checkout (clone on first sync) before the reset */
    ensure(repo: ConnectedRepo): Promise<string>;
    /** fetch + hard-reset onto origin/<defaultBranch>; returns overwritten/removed paths */
    resetToDefault(repo: ConnectedRepo): Promise<string[]>;
    /** the platform's unreleased renames — the reset discards them (#208) */
    renames?(repo: ConnectedRepo): Promise<Array<{ from: string; to: string }>>;
  };
  /** a discarded process rename sends its todos back to the old id (#208) —
   *  absent when the host has no tracker */
  todoJobs?: { move(repo: string, from: string, to: { process: string; file: string }, by: string): unknown };
  /** repo-qualified document names of live rooms — a non-empty match blocks the reset */
  liveDocs: () => string[];
  /** invalidate one room's Yjs lineage so the next open reseeds from the new tree */
  dropLineage: (room: string) => void;
}

export async function syncRepo(opts: SyncDeps, repo: ConnectedRepo, by = "platform"): Promise<SyncResult> {
  if (opts.workspaces.isHostRepo(repo.fullName)) {
    throw new AppError(
      "sync/host-repo",
      `${repo.fullName} runs in place — its checkout is managed by the operator, not reset from the app`,
      { status: 422, expose: true },
    );
  }
  if (opts.liveDocs().some((d) => d.startsWith(roomPrefix(repo.fullName)))) {
    throw new AppError(
      "sync/live-sessions",
      `${repo.fullName} has open editing sessions — close them before loading the latest state`,
      { status: 409, expose: true },
    );
  }
  await opts.workspaces.ensure(repo);
  // the reset brings back every renamed process's OLD file — its todos, which
  // followed the rename, go back with it (read before the reset clears the journal).
  // Only where the reset really restored it: a rename released and merged
  // meanwhile stays, and so do its todos
  const renamed = opts.todoJobs ? ((await opts.workspaces.renames?.(repo).catch(() => [])) ?? []) : [];
  const changed = await opts.workspaces.resetToDefault(repo);
  for (const { from, to } of renamed) {
    if (byExtension(from)?.id !== "bpmn" || modelStem(from) === modelStem(to) || !changed.includes(from)) continue;
    opts.todoJobs?.move(repo.fullName, modelStem(to), { process: modelStem(from), file: from }, by);
  }
  // drop the lineage of every file the reset changed so the next open reseeds
  // from the fetched tree instead of write-through resurrecting the stale state
  // (the same invalidation reconcile does via hooks.onReconciled)
  for (const path of changed) opts.dropLineage(roomName(repo.fullName, path));
  return { branch: repo.defaultBranch, changed };
}
