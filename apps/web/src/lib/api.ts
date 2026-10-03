/** Live-Host API client — session-based (git-provider OAuth), same-origin. */
import { api } from "@designiq/api-client";
import type {
  AppConfig,
  ChangedFileWire,
  ContentWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateModelBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  DeleteModelsBody,
  DeleteModelsResult,
  DuplicateModelBody,
  DuplicateModelResult,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ModelInfo,
  ModelReferencesWire,
  MoveModelsBody,
  MoveModelsResult,
  ProcessInfo,
  ReleaseFilesBody,
  ReleaseResult,
  RenameModelBody,
  RenameModelResult,
  RepoInfo,
  ResolveConflictBody,
  ResolveConflictResult,
  SyncResult,
  TodoJobWire,
  TodoWire,
} from "@designiq/contracts/live-host";

// re-export so app-internal `instanceof ApiError` call sites keep one import path
export { ApiError } from "@designiq/api-client";
// the wire types live in @designiq/contracts (the backend assembles them under
// `satisfies` checks) — re-exported so component imports keep one import path
export type {
  AppConfig,
  ChangedFileWire,
  ContentWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateModelBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  DeleteModelsBody,
  DeleteModelsResult,
  DuplicateModelBody,
  DuplicateModelResult,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ModelInfo,
  ModelRef,
  ModelReferencesWire,
  MoveModelsBody,
  MoveModelsResult,
  ProcessInfo,
  ReferenceWire,
  ReleaseFilesBody,
  ReleaseResult,
  RenameModelBody,
  RenameModelResult,
  RepoInfo,
  ResolveConflictBody,
  ResolveConflictResult,
  SyncResult,
  TodoAnchorWire,
  TodoElementWire,
  TodoJobWire,
  TodoWire,
} from "@designiq/contracts/live-host";

export const config = {
  // same origin as the page (single port; wss:// behind Fly TLS). Override with
  // VITE_LIVE_URL only for split-origin dev (e.g. the Vite proxy).
  wsUrl:
    (import.meta.env.VITE_LIVE_URL as string | undefined) ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
};

/** presence color, DETERMINISTIC per login — lives in the live contract now
 *  so the Live Host paints its agent presence from the same palette */
export { presenceColor } from "@designiq/contracts/live";

export const fetchConfig = (): Promise<AppConfig> => api("/api/config");
export const fetchMe = (): Promise<Me> => api("/api/me");
export const logout = (): Promise<{ ok: boolean }> => api("/api/logout", { method: "POST" });
export const fetchRepos = (refresh = false): Promise<RepoInfo[]> => api(`/api/repos${refresh ? "?refresh=1" : ""}`);
export const fetchProcesses = (repo: string): Promise<ProcessInfo[]> => api(`/api/repos/${repo}/processes`);
/** create a new process from the blank template; response is its ProcessInfo row */
export const createProcess = (repo: string, body: CreateProcessBody): Promise<ProcessInfo> =>
  api(`/api/repos/${repo}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** create a model of ANY template-capable notation (#139) — wardley, team
 *  topology, markdown …; bpmn/dmn keep their typed creates above */
export const createModel = (repo: string, body: CreateModelBody): Promise<ModelInfo> =>
  api(`/api/repos/${repo}/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** decisions (.dmn files) under the repo's processes root */
export const fetchDecisions = (repo: string): Promise<DecisionInfo[]> => api(`/api/repos/${repo}/decisions`);
/** every model file of ANY registered notation — the superset of processes + decisions */
export const fetchModels = (repo: string): Promise<ModelInfo[]> => api(`/api/repos/${repo}/models`);
/** create a new decision from the blank template; response is its DecisionInfo row */
export const createDecision = (repo: string, body: CreateDecisionBody): Promise<DecisionInfo> =>
  api(`/api/repos/${repo}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** folders under the repo's processes root (recursive, includes empty ones) */
export const fetchFolders = (repo: string): Promise<FolderListWire> => api(`/api/repos/${repo}/folders`);
export const createFolder = (repo: string, body: CreateFolderBody): Promise<FolderWire> =>
  api(`/api/repos/${repo}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** move model files into another folder (a decision's tests sidecar follows) */
export const moveModels = (repo: string, body: MoveModelsBody): Promise<MoveModelsResult> =>
  api(`/api/repos/${repo}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** give a model a new id (= file stem); callers follow, an open model's editors too */
export const renameModel = (repo: string, body: RenameModelBody): Promise<RenameModelResult> =>
  api(`/api/repos/${repo}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** copy a model's live content into the same folder under a new id */
export const duplicateModel = (repo: string, body: DuplicateModelBody): Promise<DuplicateModelResult> =>
  api(`/api/repos/${repo}/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** delete model files, all or nothing (a decision's tests sidecar goes along) */
export const deleteModels = (repo: string, body: DeleteModelsBody): Promise<DeleteModelsResult> =>
  api(`/api/repos/${repo}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** which models point at each of `paths` */
export const fetchReferences = (repo: string, paths: string[]): Promise<ModelReferencesWire[]> =>
  api(`/api/repos/${repo}/references?${paths.map((p) => `path=${encodeURIComponent(p)}`).join("&")}`);
/** hard-reset the repo's workspace onto origin/<default> — discards unreleased live edits */
export const syncRepo = (repo: string): Promise<SyncResult> => api(`/api/repos/${repo}/sync`, { method: "POST" });
export const releaseProcess = (repo: string, id: string): Promise<ReleaseResult> =>
  api(`/api/repos/${repo}/release/${encodeURIComponent(id)}`, { method: "POST" });
/** every file differing from origin — the release dialog's selection pool */
export const fetchChanges = (repo: string): Promise<ChangedFileWire[]> => api(`/api/repos/${repo}/changes`);
/** resolve a catch-up conflict: take main's version of the file, or keep the workspace's */
export const resolveConflict = (repo: string, body: ResolveConflictBody): Promise<ResolveConflictResult> =>
  api(`/api/repos/${repo}/conflicts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** release exactly the selected changed files as one PR */
export const releaseFiles = (repo: string, body: ReleaseFilesBody): Promise<ReleaseResult> =>
  api(`/api/repos/${repo}/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** the LIVE content of any editable document in the repo, plus its baseVersion.
 *  Used for SIBLING files the editor does not itself have open — a decision's
 *  `<stem>.tests.yaml`, say. Throws ApiError 404 when the file does not exist. */
export const fetchContent = (repo: string, path: string): Promise<ContentWire> =>
  api(`/api/repos/${repo}/content?path=${encodeURIComponent(path)}`);

/** the backend's hard cap on history length — a full response means truncation */
export const HISTORY_LIMIT = 200;
/** default-branch commits touching one model file, newest first */
export const fetchFileHistory = (repo: string, path: string): Promise<FileCommitWire[]> =>
  api(`/api/repos/${repo}/history?path=${encodeURIComponent(path)}&limit=${HISTORY_LIMIT}`);
/** the file's content at one commit — the Compare/Restore source */
export const fetchFileAtCommit = (repo: string, path: string, sha: string): Promise<FileAtCommitWire> =>
  api(`/api/repos/${repo}/history/content?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`);
/** open todos of a repo, optionally narrowed to one process */
export const fetchTodos = (repo: string, process?: string): Promise<TodoWire[]> =>
  api(`/api/repos/${repo}/todos${process ? `?process=${encodeURIComponent(process)}` : ""}`);
export const createTodo = (repo: string, body: CreateTodoBody): Promise<TodoWire> =>
  api(`/api/repos/${repo}/todos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** close (resolve) a todo in its tracker — errors (403 permission, 501 no tracker) carry actionable messages */
export const closeTodo = (repo: string, id: string): Promise<{ ok: true }> =>
  api(`/api/repos/${repo}/todos/${encodeURIComponent(id)}/close`, { method: "POST" });
/** background todo work of a repo — a renamed process's todos moving, a deleted one's closing */
export const fetchTodoJobs = (repo: string): Promise<TodoJobWire[]> => api(`/api/repos/${repo}/todo-jobs`);
/** run a failed todo job again */
export const retryTodoJob = (repo: string, id: string): Promise<TodoJobWire> =>
  api(`/api/repos/${repo}/todo-jobs/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
