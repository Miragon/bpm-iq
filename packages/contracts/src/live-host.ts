/**
 * Live-host ↔ web wire contract — the JSON the live-host HTTP API sends and
 * @bpmiq/web consumes. The BACKEND is the source of truth: http/api.ts,
 * application/overview.ts and release.ts assemble these shapes under
 * `satisfies` / return-type annotations; the web client re-exports them from
 * lib/api.ts. Changing a field here changes the LIVE wire format — don't.
 */
import type { GitUserWire } from "./common.ts";

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

/** GET /api/repos/:fullName/folders — every folder under the processes root
 * (recursive, sorted, includes empty ones), processes-root-relative */
export type FolderListWire = string[];

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
}

/** POST /api/repos/:fullName/release/:id */
export interface ReleaseResult {
  /** the opened pull request's URL */
  pr: string;
  branch: string;
  by: string;
  repo: string;
  /** true when pushed/opened with the app installation token (self-approvable PR) */
  botAuthored: boolean;
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

/** one BPMN element a todo is anchored to (id = anchor, name = creation-time snapshot) */
export interface TodoElementWire {
  id: string;
  name: string | null;
}

/** platform anchor of a todo — which process/file/elements it belongs to */
export interface TodoAnchorWire {
  process: string;
  file: string | null;
  elements: TodoElementWire[];
  processVersion: string | null;
}

/** GET /api/repos/:fullName/todos[?process=<id>] — one row per OPEN tracker item */
export interface TodoWire {
  /** tracker-native id as a string (GitHub/GitLab: issue number; Jira: "PROJ-123") */
  id: string;
  url: string;
  title: string;
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
