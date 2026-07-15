/**
 * The overview read-models, extracted from http/api.ts:
 *
 *   listProcesses — one row per processes/<id>/ directory of a workspace
 *                   (process.yaml metadata, declared model files with their
 *                   notation, dirty-vs-origin flag, live session count)
 *   listRepos     — registry ∩ the session user's per-repo permission, with
 *                   process/dirty counts for locally-present workspaces
 *
 * Pure orchestration over injected surfaces: the dirty check goes through
 * WorkspaceManager.changedPaths (the git subprocess lives behind that seam,
 * never here). The returned object shapes ARE the wire format
 * (@bpmiq/contracts/live-host — shape drift is a tsc error).
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelRef, ProcessInfo, RepoInfo } from "@bpmiq/contracts/live-host";
import { byExtension } from "@bpmiq/notations";
import { parse as parseYaml } from "yaml";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface OverviewDeps {
  registry: { list(): ConnectedRepo[] };
  workspaces: {
    /** content directory (no provisioning) — the overview must never trigger clones */
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
  const dir = join(workspace, "processes");
  if (!existsSync(dir)) return [];
  const live = opts.liveDocs();
  const entries = await readdir(dir, { withFileTypes: true });
  const processes: ProcessInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const yml = join(dir, e.name, "process.yaml");
    if (!existsSync(yml)) continue;
    // process.yaml is a live-editable (.yaml) room — an intermediate invalid
    // parse must not take down the whole listing (adversarial review)
    let meta;
    try {
      meta = parseYaml(await readFile(yml, "utf8"));
    } catch {
      processes.push({
        repo: repo.fullName,
        id: e.name,
        name: e.name,
        classification: null,
        status: "invalid-yaml",
        version: null,
        owner: null,
        bpmn: null,
        models: [],
        dirty: false,
        liveSessions: 0,
      });
      continue;
    }
    const dirty = (await opts.workspaces.changedPaths(repo, `processes/${e.name}`)).length > 0;
    // every declared model file, notation resolved via the registry — the web
    // client opens each of these as its own live document
    const models: ModelRef[] = [];
    const addModel = (rel?: string): void => {
      if (!rel) return;
      models.push({ notation: byExtension(rel)?.id ?? "text", path: `processes/${e.name}/${rel}` });
    };
    for (const v of Object.values((meta?.models ?? {}) as Record<string, string>)) addModel(v);
    for (const sp of meta?.subprocesses ?? []) addModel(sp?.file);
    for (const d of meta?.decisions ?? []) addModel(d?.file);

    processes.push({
      repo: repo.fullName,
      id: e.name,
      name: meta?.name ?? e.name,
      classification: meta?.classification ?? null,
      status: meta?.status ?? null,
      version: meta?.version ?? null,
      owner: meta?.owner?.team ?? null,
      bpmn: meta?.models?.bpmn ? `processes/${e.name}/${meta.models.bpmn}` : null,
      models,
      dirty,
      liveSessions: live.filter((d) => d.startsWith(`${repo.fullName}/processes/${e.name}/`)).length,
    });
  }
  return processes;
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
    // counts only when the workspace already exists locally — the overview
    // must never trigger clones; opening the repo does that. One repo's broken
    // tree must not 500 the whole overview (adversarial review).
    const ws = opts.workspaces.dir(repo);
    let processCount: number | null = null;
    let dirtyCount: number | null = null;
    if (existsSync(join(ws, "processes"))) {
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
