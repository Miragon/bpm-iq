/**
 * Resolve a catch-up conflict (#185): a file the default branch changed while
 * the shared workspace held unreleased edits of it on an older base. The
 * catch-up kept the local version and flagged the file; the release guard
 * refuses it until someone decides:
 *
 *   keep "main"       the file takes the default branch's version — ONLY this
 *                     file, every other unreleased edit stays. Refused while
 *                     the file is open in a live session (the editor's
 *                     write-through would put the old state right back), the
 *                     same gate the full reset has.
 *   keep "workspace"  the local version stays and the flag goes — the next
 *                     release deliberately replaces upstream's change.
 *
 * Only flagged paths are accepted: the list comes from git itself, so the
 * membership check doubles as the path-safety gate. Pure orchestration over
 * injected surfaces (git stays behind WorkspaceManager, lineage behind
 * dropLineage) — ApiOptions structurally satisfies ConflictDeps.
 */
import { roomName } from "@designiq/contracts/live";
import type { ResolveConflictBody, ResolveConflictResult } from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";

import type { ConnectedRepo } from "../repos/registry.ts";

export interface ConflictDeps {
  workspaces: {
    /** provision the checkout (the conflict list lives inside it) */
    ensure(repo: ConnectedRepo): Promise<string>;
    /** the flagged paths */
    conflicts(repo: ConnectedRepo): Promise<string[]>;
    /** give one file the default branch's version and clear its flag */
    takeUpstream(repo: ConnectedRepo, path: string): Promise<void>;
    /** clear one file's flag, keeping the local version */
    keepWorkspace(repo: ConnectedRepo, path: string): Promise<void>;
  };
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
  /** invalidate one room's Yjs lineage so the next open reseeds from the new tree */
  dropLineage: (room: string) => void;
}

export async function resolveConflict(
  opts: ConflictDeps,
  repo: ConnectedRepo,
  body: ResolveConflictBody,
): Promise<ResolveConflictResult> {
  await opts.workspaces.ensure(repo);
  if (!(await opts.workspaces.conflicts(repo)).includes(body.path)) {
    throw new AppError("conflict/not-found", `no conflict on ${body.path} in ${repo.fullName}`, {
      status: 404,
      expose: true,
    });
  }
  const room = roomName(repo.fullName, body.path);
  if (body.keep === "main") {
    if (opts.liveDocs().includes(room)) {
      throw new AppError(
        "conflict/live-session",
        `${body.path} is open in a live editing session — close it before taking ${repo.defaultBranch}'s version`,
        { status: 409, expose: true },
      );
    }
    await opts.workspaces.takeUpstream(repo, body.path);
    opts.dropLineage(room);
  } else {
    await opts.workspaces.keepWorkspace(repo, body.path);
  }
  return { path: body.path, keep: body.keep };
}
