/**
 * Resolve a model id (= file stem) to its repo-relative path — by DISCOVERY,
 * not through the overview read-model: listProcesses/listDecisions decorate
 * every row with `changedPaths`, which spawns two git subprocesses per file,
 * all discarded when the caller only needs one path. Six /mcp tools resolved
 * ids that way (2×N subprocesses per call); release.ts always resolved via
 * discovery — this is that pattern, shared.
 *
 * Error contract: typed 404s with the message shape the MCP tools always had
 * ("… (use list_processes).") — safe() surfaces it to agents verbatim, and a
 * REST caller gets the status. One deliberate wire change: a repo without a
 * bpmiq.yml now says so, instead of "process 'x' not found".
 */
import { AppError } from "@bpmiq/http-kit";

import type { WorkspaceEnsure } from "../domain/rooms.ts";
import {
  CONTENT_CONFIG_FILE,
  type ContentConfig,
  discoverDecisions,
  discoverModels,
  discoverProcesses,
  loadContentConfig,
} from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface FindModelDeps {
  workspaces: WorkspaceEnsure;
}

/** the repo's content config, or the typed 404 every id lookup answers
 *  without one */
function requireContentConfig(workspace: string, repo: ConnectedRepo): ContentConfig {
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "content/not-a-content-repo",
      `${repo.fullName} has no ${CONTENT_CONFIG_FILE} — not a BPM content repo`,
      { status: 404, expose: true },
    );
  }
  return cfg;
}

async function find(
  opts: FindModelDeps,
  repo: ConnectedRepo,
  id: string,
  kind: "process" | "decision",
): Promise<string> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = requireContentConfig(workspace, repo);
  const discovered = await (kind === "process" ? discoverProcesses : discoverDecisions)(workspace, cfg);
  const hit = discovered.find((m) => m.id === id);
  if (!hit) {
    throw new AppError(
      `content/unknown-${kind}`,
      `${kind} '${id}' not found in ${repo.fullName} (use list_${kind === "process" ? "processes" : "decisions"}).`,
      { status: 404, expose: true },
    );
  }
  return hit.path;
}

/** repo-relative path of the process with this id (the .bpmn file stem) */
export function findProcessPath(opts: FindModelDeps, repo: ConnectedRepo, id: string): Promise<string> {
  return find(opts, repo, id, "process");
}

/** repo-relative path of the decision with this id (the .dmn file stem) */
export function findDecisionPath(opts: FindModelDeps, repo: ConnectedRepo, id: string): Promise<string> {
  return find(opts, repo, id, "decision");
}

/**
 * Repo-relative path of a model of ANY registered notation by id (= file
 * stem). `notation` narrows the lookup; without it a stem shared across
 * notations resolves bpmn-first — the rule get_view established (a process
 * keeps winning for the process-shaped callers). The message names
 * list_models, the listing that shows every notation.
 */
export async function findModelPath(
  opts: FindModelDeps,
  repo: ConnectedRepo,
  id: string,
  notation?: string,
): Promise<string> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = requireContentConfig(workspace, repo);
  const matches = (await discoverModels(workspace, cfg)).filter(
    (m) => m.id === id && (notation === undefined || m.notation === notation),
  );
  const hit = matches.find((m) => m.notation === "bpmn") ?? matches[0];
  if (!hit) {
    throw new AppError(
      "content/unknown-model",
      `unknown model '${id}'${notation ? ` (${notation})` : ""} in ${repo.fullName} — list_models shows what exists.`,
      { status: 404, expose: true },
    );
  }
  return hit.path;
}
