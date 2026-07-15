/**
 * Live-host ↔ web wire contract — the JSON the live-host HTTP API sends and
 * @bpmiq/web consumes. The BACKEND is the source of truth: http/api.ts,
 * application/overview.ts and release.ts assemble these shapes under
 * `satisfies` / return-type annotations; the web client re-exports them from
 * lib/api.ts. Changing a field here changes the LIVE wire format — don't.
 */
import type { GitUserWire } from "./common.ts";

/** one declared model file of a process — each opens as its own live document */
export interface ModelRef {
  /** notation registry id (@bpmiq/notations); "text" fallback */
  notation: string;
  /** repo-relative path, e.g. "processes/<id>/<file>" */
  path: string;
}

/** GET /api/repos/:fullName/processes — one row per processes/<id>/ directory */
export interface ProcessInfo {
  repo: string;
  id: string;
  name: string;
  classification: string | null;
  /** process.yaml status; "invalid-yaml" for an unparseable intermediate state */
  status: string | null;
  version: string | null;
  owner: string | null;
  /** primary BPMN model (repo-relative path) */
  bpmn: string | null;
  /** every declared model file with its notation */
  models: ModelRef[];
  dirty: boolean;
  liveSessions: number;
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
