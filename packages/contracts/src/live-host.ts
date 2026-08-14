/**
 * Live-host ↔ web wire contract — the JSON the live-host HTTP API sends and
 * @bpmiq/web consumes. The BACKEND is the source of truth: http/api.ts,
 * application/overview.ts and release.ts assemble these shapes under
 * `satisfies` / return-type annotations; the web client re-exports them from
 * lib/api.ts. Changing a field here changes the LIVE wire format — don't.
 */
import type { GitUserWire } from "./common.ts";
import type { TodoAnchor, TodoElement } from "./todo-anchor.ts";

/** one model file of a process — each opens as its own live document */
export interface ModelRef {
  /** notation registry id (@bpmiq/notations); "text" fallback */
  notation: string;
  /** repo-relative path, e.g. "processes/<file>.bpmn" */
  path: string;
}

/**
 * GET /api/repos/:fullName/processes — one row per .bpmn file under the
 * repo's bpmiq.yml processes folder (a process IS its BPMN file; id = file
 * name without extension).
 */
export interface ProcessInfo {
  repo: string;
  id: string;
  name: string;
  /** the process's BPMN file (repo-relative path) */
  bpmn: string;
  /** the process's model files with their notation */
  models: ModelRef[];
  /** folder of the BPMN file relative to the processes root ("" = root) */
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/** POST /api/repos/:fullName/processes — response is the created ProcessInfo.
 * The process id (= file stem) is derived from `name`; it must be unique
 * repo-wide, so a duplicate is a 409 regardless of `folder`. */
export interface CreateProcessBody {
  /** human title — becomes the pool name; the file stem is its kebab-case slug */
  name: string;
  /** target folder relative to the processes root ("" / absent = root) */
  folder?: string;
}

/**
 * GET /api/repos/:fullName/decisions — one row per .dmn file under the
 * repo's bpmiq.yml processes folder (a decision IS its DMN file; id = file
 * name without extension, unique repo-wide like process ids).
 */
export interface DecisionInfo {
  repo: string;
  id: string;
  name: string;
  /** the decision's DMN file (repo-relative path) */
  path: string;
  /** folder of the DMN file relative to the processes root ("" = root) */
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/** POST /api/repos/:fullName/decisions — response is the created DecisionInfo.
 * The decision id (= file stem) is derived from `name`; it must be unique
 * among .dmn files repo-wide, so a duplicate is a 409 regardless of `folder`. */
export interface CreateDecisionBody {
  /** human title — becomes the decision name; the file stem is its kebab-case slug */
  name: string;
  /** target folder relative to the processes root ("" / absent = root) */
  folder?: string;
}

/**
 * GET /api/repos/:fullName/folders — the repo's folder tree plus whether the
 * repo is a bpm content repo at all. `isContentRepo` is false when the repo has
 * NO root bpmiq.yml; the repo view hides its create/release actions then (a
 * create would 422, a release has nothing to ship — "not a matching repo").
 */
export interface FolderListWire {
  /** the repo declares itself a bpm content repo (a root bpmiq.yml is present) */
  isContentRepo: boolean;
  /** every folder under the processes root (recursive, sorted, includes empty
   * ones), processes-root-relative — [] when there is no config or no folder */
  folders: string[];
}

/** POST /api/repos/:fullName/folders — response is the created FolderWire */
export interface CreateFolderBody {
  /** processes-root-relative folder path to create (may be nested) */
  path: string;
}

export interface FolderWire {
  /** the created folder, processes-root-relative and normalized */
  path: string;
}

/** GET /api/repos — registry ∩ the session user's per-repo permission */
export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  avatarUrl: string | null;
  suspended: boolean;
  permission: "write" | "none";
  /** null when the workspace is not cloned yet (the overview never clones) */
  processCount: number | null;
  dirtyCount: number | null;
  liveSessions: number;
}

/** GET /api/me */
export interface Me {
  user: GitUserWire;
  wsToken: string;
}

/** GET /api/config */
export interface AppConfig {
  providers: { id: string; label: string }[];
  installUrl: string | null;
  /** the MCP endpoint under the server's public URL — what an AI client connects to */
  mcpUrl: string;
}

/** POST /api/repos/:fullName/release/:id and /release (file selection) */
export interface ReleaseResult {
  /** the opened pull request's URL */
  pr: string;
  branch: string;
  by: string;
  repo: string;
  /** true when pushed/opened with the app installation token (self-approvable PR) */
  botAuthored: boolean;
  /** the repo-relative files the release shipped */
  files: string[];
}

/**
 * GET /api/repos/:fullName/changes — every file in which the shared workspace
 * differs from origin/<defaultBranch>, the pool a release selects from. The
 * workspace is shared per repo, so this may include colleagues' in-progress
 * edits — liveSessions marks files somebody currently has open.
 */
export interface ChangedFileWire {
  /** repo-root-relative path (the same identifier live rooms use) */
  path: string;
  status: "modified" | "added" | "deleted";
  liveSessions: number;
}

/** POST /api/repos/:fullName/release — release exactly the selected files.
 * Every entry must currently be changed vs origin (GET /changes), otherwise 409. */
export interface ReleaseFilesBody {
  /** repo-relative paths to ship (non-empty) */
  files: string[];
  /** optional human title — becomes the PR/commit subject and the branch slug */
  title?: string;
}

/**
 * POST /api/repos/:fullName/sync — hard-reset the repo's workspace onto
 * origin/<defaultBranch> ("load the latest state from main"). Unreleased live
 * edits (the dirty processes) are discarded, so the client confirms first.
 */
export interface SyncResult {
  /** the branch the workspace was reset onto (the repo's default branch) */
  branch: string;
  /** repo-relative paths whose content the reset changed or removed */
  changed: string[];
}

/** GET /api/repos/:fullName/history?path=<model path>[&limit=<n>] — commits on
 * the default branch touching the file, newest first */
export interface FileCommitWire {
  /** full commit sha */
  sha: string;
  subject: string;
  /** message body below the subject line; "" when none */
  body: string;
  author: string;
  /** ISO-8601 author date */
  authoredAt: string;
}

/** GET /api/repos/:fullName/history/content?path=<model path>&sha=<sha> */
export interface FileAtCommitWire {
  sha: string;
  /** content-relative model path (the room path) */
  path: string;
  /** the file's full content at that commit */
  content: string;
}

/** one BPMN element a todo is anchored to (id = anchor, name = creation-time
 *  snapshot) — the wire shape IS the codec's TodoElement (./todo-anchor.ts);
 *  changing that type changes the LIVE wire format */
export type TodoElementWire = TodoElement;

/** platform anchor of a todo — which process/file/elements it belongs to;
 *  the wire shape IS the codec's TodoAnchor (./todo-anchor.ts) */
export type TodoAnchorWire = TodoAnchor;

/** GET /api/repos/:fullName/todos[?process=<id>] — one row per OPEN tracker item */
export interface TodoWire {
  /** tracker-native id as a string (GitHub/GitLab: issue number; Jira: "PROJ-123") */
  id: string;
  url: string;
  title: string;
  /** the author's description with the platform markup stripped ("" when none) */
  body: string;
  state: "open" | "done";
  /** null = no parseable anchor (e.g. created by hand in the tracker) */
  anchor: TodoAnchorWire | null;
  author: string | null;
  assignees: string[];
  createdAt: string;
}

/** POST /api/repos/:fullName/todos — response is the created TodoWire */
export interface CreateTodoBody {
  title: string;
  body?: string;
  anchor: {
    process: string;
    file?: string;
    elements?: TodoElementWire[];
    processVersion?: string;
  };
}

/** GET /api/repos/:fullName/content?path=<model path> — the LIVE document content
 *  (the same Y.Text the collaborative rooms edit, read server-side) */
export interface ContentWire {
  repo: string;
  /** content-relative model path (the room path) */
  path: string;
  xml: string;
  /** opaque optimistic-concurrency token — changes on ANY edit (incl. delete-only) */
  baseVersion: string;
}

/** PUT /api/repos/:fullName/content?path=… — request body. baseVersion is REQUIRED
 *  (from a prior GET); a stale one returns 409 ContentConflictWire instead of overwriting. */
export interface PutContentBody {
  xml: string;
  baseVersion: string;
  /** "block" (default): ERROR findings refuse the save (422). "warn": findings
   * come back on the result instead — the modeler widget's autosave uses this,
   * mirroring the ws path, which has never gated live edits. */
  lint?: "block" | "warn";
}

/** PUT success response */
export interface PutContentResultWire {
  path: string;
  /** the new token to continue editing against */
  baseVersion: string;
  /** validator WARN findings (non-blocking; [] for non-.bpmn files) */
  warnings: string[];
  /** validator ERROR findings — only present on lint:"warn" saves, where they
   * inform instead of refusing */
  errors?: string[];
}

/** PUT 409 — the document changed since the client's read */
export interface ContentConflictWire {
  error: string;
  code: "content/conflict";
  path: string;
  /** re-derive the edit against this and retry with the fresh baseVersion */
  currentXml: string;
  baseVersion: string;
}
