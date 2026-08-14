/**
 * File-history read-models — the commits on the default branch touching one
 * model file (the editor's history panel), and the file's content at one of
 * those commits (Compare/Restore). Pure orchestration over injected surfaces:
 * the git subprocess lives behind WorkspaceManager, path safety behind
 * splitRoom — the SAME gate the live rooms use, so history serves exactly the
 * shareable model files and nothing else (.git, dotfiles, escapes).
 */
import type { FileAtCommitWire, FileCommitWire } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import { isCommitSha } from "../domain/file-history.ts";
import type { RegistryLookup } from "../domain/rooms.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { modelPath } from "./model-path.ts";

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
  const safePath = modelPath(opts.registry, repo, path, "history/invalid-path");
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
  const safePath = modelPath(opts.registry, repo, path, "history/invalid-path");
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
