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
import { roomName } from "@bpmiq/contracts/live";
import type { SyncResult } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import type { ConnectedRepo } from "../repos/registry.ts";

export interface SyncDeps {
  workspaces: {
    /** the in-place host checkout must never be hard-reset */
    isHostRepo(fullName: string): boolean;
    /** provision the checkout (clone on first sync) before the reset */
    ensure(repo: ConnectedRepo): Promise<string>;
    /** fetch + hard-reset onto origin/<defaultBranch>; returns overwritten/removed paths */
    resetToDefault(repo: ConnectedRepo): Promise<string[]>;
  };
  /** repo-qualified document names of live rooms — a non-empty match blocks the reset */
  liveDocs: () => string[];
  /** invalidate one room's Yjs lineage so the next open reseeds from the new tree */
  dropLineage: (room: string) => void;
}

export async function syncRepo(opts: SyncDeps, repo: ConnectedRepo): Promise<SyncResult> {
  if (opts.workspaces.isHostRepo(repo.fullName)) {
    throw new AppError(
      "sync/host-repo",
      `${repo.fullName} runs in place — its checkout is managed by the operator, not reset from the app`,
      { status: 422, expose: true },
    );
  }
  if (opts.liveDocs().some((d) => d.startsWith(`${repo.fullName}/`))) {
    throw new AppError(
      "sync/live-sessions",
      `${repo.fullName} has open editing sessions — close them before loading the latest state`,
      { status: 409, expose: true },
    );
  }
  await opts.workspaces.ensure(repo);
  const changed = await opts.workspaces.resetToDefault(repo);
  // drop the lineage of every file the reset changed so the next open reseeds
  // from the fetched tree instead of write-through resurrecting the stale state
  // (the same invalidation reconcile does via hooks.onReconciled)
  for (const path of changed) opts.dropLineage(roomName(repo.fullName, path));
  return { branch: repo.defaultBranch, changed };
}
