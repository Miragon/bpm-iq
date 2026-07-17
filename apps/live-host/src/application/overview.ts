/**
 * The overview read-models, extracted from http/api.ts:
 *
 *   listProcesses — one row per .bpmn file under the repo's bpmiq.yml
 *                   processes folder (repos/content.ts), with dirty-vs-origin
 *                   flag and live session count
 *   listDecisions — the .dmn sibling of listProcesses
 *   listRepos     — registry ∩ the session user's per-repo permission, with
 *                   process/dirty counts for locally-present workspaces
 *
 * Pure orchestration over injected surfaces: the dirty check goes through
 * WorkspaceManager.changedPaths (the git subprocess lives behind that seam,
 * never here). The returned object shapes ARE the wire format
 * (@bpmiq/contracts/live-host — shape drift is a tsc error).
 */
import type { DecisionInfo, ProcessInfo, RepoInfo } from "@bpmiq/contracts/live-host";
import { byExtension } from "@bpmiq/notations";

import type { Session } from "../adapters/sqlite/sessions.ts";
import { discoverDecisions, discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface OverviewDeps {
  registry: { list(): ConnectedRepo[] };
  workspaces: {
    /** checkout root (no provisioning) — the overview must never trigger clones */
    dir(repo: ConnectedRepo): string;
    /** files under `pathspec` differing from origin/<defaultBranch>; [] on error */
    changedPaths(repo: ConnectedRepo, pathspec: string): Promise<string[]>;
  };
  access: { canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> };
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
}

export async function listProcesses(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<ProcessInfo[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  // proc.path is repo-root-relative; the folder the UI groups by is relative
  // to the processes root ("" = directly inside it)
  const rootPrefix = cfg.processes === "." ? "" : `${cfg.processes}/`;
  const processes: ProcessInfo[] = [];
  for (const proc of await discoverProcesses(workspace, cfg)) {
    // dirty flag comes from the injected changedPaths (git stays behind the seam)
    const dirty = (await opts.workspaces.changedPaths(repo, proc.path)).length > 0;
    const rel = proc.path.startsWith(rootPrefix) ? proc.path.slice(rootPrefix.length) : proc.path;
    processes.push({
      repo: repo.fullName,
      id: proc.id,
      name: proc.id,
      bpmn: proc.path,
      models: [{ notation: byExtension(proc.path)?.id ?? "text", path: proc.path }],
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      dirty,
      // a process is exactly one file — its room is the exact match
      liveSessions: live.filter((d) => d === `${repo.fullName}/${proc.path}`).length,
    });
  }
  return processes;
}

/** The .dmn sibling of listProcesses — one row per decision file. */
export async function listDecisions(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<DecisionInfo[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  const rootPrefix = cfg.processes === "." ? "" : `${cfg.processes}/`;
  const decisions: DecisionInfo[] = [];
  for (const decision of await discoverDecisions(workspace, cfg)) {
    const dirty = (await opts.workspaces.changedPaths(repo, decision.path)).length > 0;
    const rel = decision.path.startsWith(rootPrefix) ? decision.path.slice(rootPrefix.length) : decision.path;
    decisions.push({
      repo: repo.fullName,
      id: decision.id,
      name: decision.id,
      path: decision.path,
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      dirty,
      liveSessions: live.filter((d) => d === `${repo.fullName}/${decision.path}`).length,
    });
  }
  return decisions;
}

/** Repo overview: registry ∩ the session user's per-repo permission. */
export async function listRepos(opts: OverviewDeps, session: Session): Promise<RepoInfo[]> {
  const live = opts.liveDocs();
  const out: RepoInfo[] = [];
  for (const repo of opts.registry.list()) {
    // dev sessions (tests, VS Code) see everything; real users per provider check
    const writable = session.id === "dev" ? true : await opts.access.canWrite(session, repo);
    if (!writable && session.id !== "dev") {
      // no access → the repo does not exist for this user (private by default)
      continue;
    }
    // counts only when the workspace already exists locally AND declares itself
    // a content repo (bpmiq.yml) — the overview must never trigger clones;
    // opening the repo does that. One repo's broken tree must not 500 the whole
    // overview (adversarial review).
    const ws = opts.workspaces.dir(repo);
    let processCount: number | null = null;
    let dirtyCount: number | null = null;
    if (loadContentConfig(ws)) {
      try {
        const processes = await listProcesses(opts, repo, ws);
        processCount = processes.length;
        dirtyCount = processes.filter((p) => p.dirty).length;
      } catch (e) {
        console.log(`overview: listing ${repo.fullName} failed (${(e as Error).message.split("\n")[0]})`);
      }
    }
    // fullName is always "<owner>/<name>" (registry contract; GitLab subgroups
    // keep a slash too) — split() yields ≥1 element, so the fallbacks never fire
    // at runtime; they exist for noUncheckedIndexedAccess.
    const [ownerSegment = repo.fullName, nameSegment = repo.fullName] = repo.fullName.split("/");
    out.push({
      fullName: repo.fullName,
      owner: ownerSegment,
      name: nameSegment,
      defaultBranch: repo.defaultBranch,
      avatarUrl: repo.avatarUrl,
      suspended: repo.suspended,
      permission: writable ? "write" : "none",
      processCount,
      dirtyCount,
      liveSessions: live.filter((d) => d.startsWith(`${repo.fullName}/`)).length,
    });
  }
  return out;
}
