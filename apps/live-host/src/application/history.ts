/**
 * File-history read-models — the commits on the default branch touching one
 * model file (the editor's history panel), and the file's content at one of
 * those commits (Compare/Restore). Pure orchestration over injected surfaces:
 * the git subprocess lives behind WorkspaceManager, path safety behind
 * splitRoom — the SAME gate the live rooms use, so history serves exactly the
 * shareable model files and nothing else (.git, dotfiles, escapes).
 */
import { roomName } from "@bpmiq/contracts/live";
import type { FileAtCommitWire, FileCommitWire } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import { isCommitSha } from "../domain/file-history.ts";
import { type RegistryLookup, splitRoom } from "../domain/rooms.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface HistoryDeps {
  registry: RegistryLookup;
  workspaces: {
    /** provision/refresh the checkout (fetches origin/<defaultBranch>, ≤1/min) */
    ensure(repo: ConnectedRepo): Promise<string>;
    fileHistory(repo: ConnectedRepo, path: string, limit: number): Promise<FileCommitWire[]>;
    fileAtCommit(repo: ConnectedRepo, path: string, sha: string): Promise<string | null>;
  };
}

/** commits touching `path` on the default branch, newest first; `limitRaw`
 *  comes straight from ?limit= — clamped to 1..200, default 50 */
export async function fileHistory(
  opts: HistoryDeps,
  repo: ConnectedRepo,
  path: string,
  limitRaw: string | null,
): Promise<FileCommitWire[]> {
  const safePath = modelPath(opts, repo, path);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(limitRaw ?? "")) || 50));
  await opts.workspaces.ensure(repo);
  return opts.workspaces.fileHistory(repo, safePath, limit);
}

/** the file's content at one commit — the Compare/Restore source */
export async function fileAtCommit(
  opts: HistoryDeps,
  repo: ConnectedRepo,
  path: string,
  sha: string,
): Promise<FileAtCommitWire> {
  const safePath = modelPath(opts, repo, path);
  if (!isCommitSha(sha)) {
    throw new AppError("history/invalid-sha", `not a commit sha: ${sha}`, { status: 400, expose: true });
  }
  await opts.workspaces.ensure(repo);
  const content = await opts.workspaces.fileAtCommit(repo, safePath, sha);
  if (content === null) {
    throw new AppError("history/unknown-commit", `no ${safePath} at commit ${sha} in ${repo.fullName}`, {
      status: 404,
      expose: true,
    });
  }
  return { sha, path: safePath, content };
}

/** validate `path` through the live-room gate (splitRoom) against the ALREADY
 *  authorized repo — a path that resolves to a different registry entry (GitLab
 *  subgroup prefix collisions) is rejected, not silently re-scoped */
function modelPath(opts: HistoryDeps, repo: ConnectedRepo, path: string): string {
  let split: { repo: ConnectedRepo; path: string };
  try {
    split = splitRoom(roomName(repo.fullName, path), opts.registry);
  } catch (e) {
    throw new AppError("history/invalid-path", (e as Error).message, { status: 400, expose: true });
  }
  if (split.repo.fullName !== repo.fullName) {
    throw new AppError("history/invalid-path", `path resolves outside ${repo.fullName}: ${path}`, {
      status: 400,
      expose: true,
    });
  }
  return split.path;
}
