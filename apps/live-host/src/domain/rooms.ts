/**
 * Room-name parsing + on-disk path resolution — the WebSocket authorization and
 * path-safety gate, extracted from server.ts so it is unit-testable (server.ts
 * opens a listener on import). Pure given an injected registry/workspace surface.
 *
 * Room name = "<repo-full-name>/<repo-relative-path>". The repo part is the LONGEST
 * registry prefix (GitHub owner/name, GitLab subgroups), NOT a fixed two segments.
 */
import { resolve } from "node:path";

import { EDITABLE_EXTENSIONS } from "@bpmiq/notations";

import type { ConnectedRepo } from "../repos/registry.ts";

/** the minimal registry surface splitRoom needs (case-insensitive lookup) */
export interface RegistryLookup {
  get(fullName: string): ConnectedRepo | undefined;
}

/** the minimal workspace surface toDiskPath needs */
export interface WorkspaceEnsure {
  ensure(repo: ConnectedRepo): Promise<string>;
}

/** the repo's content config (bpmiq.yml) — injected so this module stays pure */
export type ContentConfigLookup = (workspaceRoot: string) => { processes: string } | undefined;

/**
 * Parse a room into its repo + repo-relative path, or throw. Rejects:
 * malformed rooms, unknown repos, a mis-cased repo prefix (a differently-cased
 * room would fork the same file into a second divergent CRDT doc), suspended
 * installations, dotfiles / .git / node_modules / empty segments, and any file
 * whose extension the notation registry does not consider editable.
 */
export function splitRoom(
  documentName: string,
  registry: RegistryLookup,
  editable: readonly string[] = EDITABLE_EXTENSIONS,
): { repo: ConnectedRepo; path: string } {
  const parts = documentName.split("/");
  if (parts.length < 3) throw new Error(`room must be <repo-full-name>/<path>: ${documentName}`);
  let repo: ConnectedRepo | undefined;
  let repoSegments = 0;
  for (let i = 2; i < parts.length; i++) {
    const candidate = registry.get(parts.slice(0, i).join("/"));
    if (candidate) {
      repo = candidate;
      repoSegments = i; // longest match wins (a repo can't be a prefix of a file path here)
    }
  }
  if (!repo) throw new Error(`not a connected repository: ${parts[0]}/${parts[1]}`);
  // registry.get matches case-insensitively, but the Yjs lineage, liveDocs and the
  // SQLite key are all keyed on the RAW documentName — a differently-cased room
  // would fork the same file into a second, divergent CRDT doc. Force the canonical
  // casing; clients build rooms from the API's repo.fullName, so only hand-typed
  // paths hit this.
  if (parts.slice(0, repoSegments).join("/") !== repo.fullName) {
    throw new Error(`use canonical repo casing '${repo.fullName}', not '${parts.slice(0, repoSegments).join("/")}'`);
  }
  if (repo.suspended) throw new Error(`installation suspended: ${repo.fullName}`);
  const segments = parts.slice(repoSegments);
  if (segments.length === 0) throw new Error(`room must be <repo-full-name>/<path>: ${documentName}`);
  if (segments.some((s) => s === ".git" || s === "node_modules" || s.startsWith(".") || s === ""))
    throw new Error(`not shareable: ${documentName}`);
  const path = segments.join("/");
  if (!editable.some((ext) => path.endsWith(ext))) throw new Error(`not an editable model/doc: ${documentName}`);
  return { repo, path };
}

/**
 * Resolve a room to an absolute on-disk path inside the repo's workspace, guarding
 * against filesystem + cross-repo escape (defense-in-depth over splitRoom's rules).
 * Live rooms exist only INSIDE the repo's configured processes folder (bpmiq.yml)
 * — a repo without the config has no live-editable files at all.
 */
export async function toDiskPath(
  documentName: string,
  registry: RegistryLookup,
  workspaces: WorkspaceEnsure,
  contentConfig: ContentConfigLookup,
  editable: readonly string[] = EDITABLE_EXTENSIONS,
): Promise<string> {
  const { repo, path } = splitRoom(documentName, registry, editable);
  const workspace = await workspaces.ensure(repo);
  const cfg = contentConfig(workspace);
  if (!cfg) throw new Error(`not a BPM content repo (no bpmiq.yml): ${repo.fullName}`);
  const disk = resolve(workspace, path);
  // must live INSIDE the configured processes folder — resolve() normalizes both
  // sides so "." (root), "a//b", trailing slashes etc. all compare correctly
  const procRoot = resolve(workspace, cfg.processes);
  if (disk !== procRoot && !disk.startsWith(procRoot + "/")) {
    throw new Error(`outside the configured processes folder (${cfg.processes}): ${documentName}`);
  }
  if (!disk.startsWith(workspace + "/")) throw new Error(`path escapes workspace: ${documentName}`);
  // NB the lexical checks above are resolve()-based and therefore blind to
  // SYMLINKS — a *.bpmn symlink escaping the checkout passes here. The realpath
  // guard lives in the application layer (collab.ts assertInsideWorkspace), which
  // is where filesystem access belongs; this domain module stays pure.
  return disk;
}
