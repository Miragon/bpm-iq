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
import { CONTENT_CONFIG_FILE, discoverDecisions, discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface FindModelDeps {
  workspaces: WorkspaceEnsure;
}

async function find(
  opts: FindModelDeps,
  repo: ConnectedRepo,
  id: string,
  kind: "process" | "decision",
): Promise<string> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "content/not-a-content-repo",
      `${repo.fullName} has no ${CONTENT_CONFIG_FILE} — not a BPM content repo`,
      { status: 404, expose: true },
    );
  }
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
