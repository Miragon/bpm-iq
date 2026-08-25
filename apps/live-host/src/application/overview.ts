/**
 * The overview read-models, extracted from http/api.ts:
 *
 *   listProcesses — one row per .bpmn file under the repo's bpmiq.yml
 *                   processes folder (repos/content.ts), with dirty-vs-origin
 *                   flag and live session count
 *   listDecisions — the .dmn sibling of listProcesses
 *   listChanges   — every file differing from origin/<default>, the pool a
 *                   file-selection release picks from
 *   listRepos     — registry ∩ the session user's per-repo permission, with
 *                   process/dirty counts for locally-present workspaces
 *
 * Pure orchestration over injected surfaces: the dirty check goes through
 * WorkspaceManager.changedPaths (the git subprocess lives behind that seam,
 * never here). The returned object shapes ARE the wire format
 * (@bpmiq/contracts/live-host — shape drift is a tsc error).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { roomName, roomPrefix } from "@bpmiq/contracts/live";
import type { ChangedFileWire, DecisionInfo, ModelInfo, ProcessInfo, RepoInfo } from "@bpmiq/contracts/live-host";
import { byExtension } from "@bpmiq/notations";
import { deriveProcess } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";

import type { Session } from "../adapters/sqlite/sessions.ts";
import { discoverDecisions, discoverModels, discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface OverviewDeps {
  registry: { list(): ConnectedRepo[] };
  workspaces: {
    /** checkout root (no provisioning) — the overview must never trigger clones */
    dir(repo: ConnectedRepo): string;
    /** files under `pathspec` differing from origin/<defaultBranch>; [] on error */
    changedPaths(repo: ConnectedRepo, pathspec: string): Promise<string[]>;
    /** changed files under `pathspec` with status; [] on error */
    changedFiles(
      repo: ConnectedRepo,
      pathspec: string,
    ): Promise<Array<{ path: string; status: "modified" | "added" | "deleted" }>>;
  };
  access: { canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> };
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
}

/** the row shape both model kinds share — wire mapping stays per wrapper */
interface ModelRow {
  id: string;
  path: string;
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/**
 * The shared list core: discovery + folder math + dirty + live sessions.
 * Dirty comes from ONE changedPaths call over the processes root for the
 * whole list (it used to be one git subprocess pair PER ROW — the read-model
 * half of the cost #86 item 10 removed from the MCP path).
 */
async function listModels(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
  discover: (
    root: string,
    cfg: NonNullable<ReturnType<typeof loadContentConfig>>,
  ) => Promise<Array<{ id: string; path: string }>>,
): Promise<ModelRow[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  // m.path is repo-root-relative; the folder the UI groups by is relative
  // to the processes root ("" = directly inside it)
  const rootPrefix = cfg.processes === "." ? "" : `${cfg.processes}/`;
  const discovered = await discover(workspace, cfg);
  const changed = new Set(await opts.workspaces.changedPaths(repo, cfg.processes));
  return discovered.map((m) => {
    const rel = m.path.startsWith(rootPrefix) ? m.path.slice(rootPrefix.length) : m.path;
    return {
      id: m.id,
      path: m.path,
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      dirty: changed.has(m.path),
      // a model is exactly one file — its room is the exact match
      liveSessions: live.filter((d) => d === roomName(repo.fullName, m.path)).length,
    };
  });
}

/**
 * One row per process (.bpmn) of a CONNECTED repo's workspace — the overview
 * read-model. Dirty means the file differs from origin/<default>.
 */
export async function listProcesses(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<ProcessInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverProcesses);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    bpmn: m.path,
    models: [{ notation: byExtension(m.path)?.id ?? "text", path: m.path }],
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/** The .dmn sibling of listProcesses — one row per decision file. */
export async function listDecisions(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<DecisionInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverDecisions);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    path: m.path,
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/**
 * One row per model file of ANY registered notation — the registry-wide
 * superset of listProcesses/listDecisions (which stay the typed views).
 */
export async function listAllModels(opts: OverviewDeps, repo: ConnectedRepo, workspace: string): Promise<ModelInfo[]> {
  const rows = await listModels(opts, repo, workspace, discoverModels);
  return rows.map((m) => ({
    repo: repo.fullName,
    id: m.id,
    name: m.id,
    path: m.path,
    notation: byExtension(m.path)?.id ?? "text",
    folder: m.folder,
    dirty: m.dirty,
    liveSessions: m.liveSessions,
  }));
}

/** one businessRuleTask that delegates to a decision */
export interface DecisionUsage {
  /** the process id (= .bpmn file stem) */
  process: string;
  path: string;
  /** the businessRuleTask's element id and name */
  element: string;
  elementName: string | null;
}

/**
 * Which processes delegate to a decision — the impact question ("what breaks
 * if I change this table?"). Reads the workspace tree rather than the live
 * documents on purpose: opening a live room per process would be a Hocuspocus
 * connection per file, and the released truth is what the link check and the
 * release PR reason about anyway.
 *
 * Deliberately NOT riding buildRepoIndex yet: the wire carries elementName
 * (the businessRuleTask's label), which ModelRef does not represent —
 * consolidate once refs carry a source-element label (epic #118).
 */
export async function decisionUsers(workspace: string, decisionId: string): Promise<DecisionUsage[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const out: DecisionUsage[] = [];
  for (const proc of await discoverProcesses(workspace, cfg)) {
    const xml = await readFile(join(workspace, proc.path), "utf8").catch(() => undefined);
    if (xml === undefined) continue;
    const graph = extractModelGraph(proc.path, xml);
    if (!graph) continue;
    for (const decision of deriveProcess(graph).decisions) {
      if (decision.decisionRef !== decisionId) continue;
      out.push({ process: proc.id, path: proc.path, element: decision.id, elementName: decision.name });
    }
  }
  return out;
}

/**
 * Every CONTENT file in which the shared workspace differs from
 * origin/<default> — the pool a file-selection release picks from, confined
 * to the bpmiq.yml processes scope (like live rooms; checkout files outside
 * it are not part of the platform's surface). liveSessions marks files a
 * colleague currently has open, so the release dialog can warn before
 * shipping somebody's work in progress.
 */
export async function listChanges(
  opts: OverviewDeps,
  repo: ConnectedRepo,
  workspace: string,
): Promise<ChangedFileWire[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const live = opts.liveDocs();
  return (await opts.workspaces.changedFiles(repo, cfg.processes)).map((c) => ({
    ...c,
    liveSessions: live.filter((d) => d === roomName(repo.fullName, c.path)).length,
  }));
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
    let decisionCount: number | null = null;
    let dirtyCount: number | null = null;
    const cfg = loadContentConfig(ws);
    if (cfg) {
      try {
        // counts come from DISCOVERY (readdir only) and dirty from ONE
        // changedPaths call per repo — the per-row git subprocesses the list
        // endpoints used to pay never belonged on the overview. dirtyCount
        // deliberately includes dirty DECISIONS now: a repo whose only change
        // is a decision used to show no "live changes" badge at all.
        const procs = await discoverProcesses(ws, cfg);
        const decs = await discoverDecisions(ws, cfg);
        const changed = new Set(await opts.workspaces.changedPaths(repo, cfg.processes));
        processCount = procs.length;
        decisionCount = decs.length;
        dirtyCount = [...procs, ...decs].filter((m) => changed.has(m.path)).length;
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
      decisionCount,
      dirtyCount,
      liveSessions: live.filter((d) => d.startsWith(roomPrefix(repo.fullName))).length,
    });
  }
  return out;
}
