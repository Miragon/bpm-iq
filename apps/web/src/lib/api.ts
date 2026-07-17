/** Live-Host API client — session-based (git-provider OAuth), same-origin. */
import { api } from "@bpmiq/api-client";
import type {
  AppConfig,
  ChangedFileWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ProcessInfo,
  ReleaseFilesBody,
  ReleaseResult,
  RepoInfo,
  SyncResult,
  TodoWire,
} from "@bpmiq/contracts/live-host";

// re-export so app-internal `instanceof ApiError` call sites keep one import path
export { ApiError } from "@bpmiq/api-client";
// the wire types live in @bpmiq/contracts (the backend assembles them under
// `satisfies` checks) — re-exported so component imports keep one import path
export type {
  AppConfig,
  ChangedFileWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ModelRef,
  ProcessInfo,
  ReleaseFilesBody,
  ReleaseResult,
  RepoInfo,
  SyncResult,
  TodoAnchorWire,
  TodoElementWire,
  TodoWire,
} from "@bpmiq/contracts/live-host";

export const config = {
  // same origin as the page (single port; wss:// behind Fly TLS). Override with
  // VITE_LIVE_URL only for split-origin dev (e.g. the Vite proxy).
  wsUrl:
    (import.meta.env.VITE_LIVE_URL as string | undefined) ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
  color:
    localStorage.getItem("bpm-live-color") ??
    ["#fa8100", "#0aa2c0", "#7c4dff", "#2e7d32", "#c2185b"][Math.floor(Math.random() * 5)] ??
    "#fa8100",
};
localStorage.setItem("bpm-live-color", config.color);

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
/** decisions (.dmn files) under the repo's processes root */
export const fetchDecisions = (repo: string): Promise<DecisionInfo[]> => api(`/api/repos/${repo}/decisions`);
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
/** hard-reset the repo's workspace onto origin/<default> — discards unreleased live edits */
export const syncRepo = (repo: string): Promise<SyncResult> => api(`/api/repos/${repo}/sync`, { method: "POST" });
export const releaseProcess = (repo: string, id: string): Promise<ReleaseResult> =>
  api(`/api/repos/${repo}/release/${encodeURIComponent(id)}`, { method: "POST" });
/** every file differing from origin — the release dialog's selection pool */
export const fetchChanges = (repo: string): Promise<ChangedFileWire[]> => api(`/api/repos/${repo}/changes`);
/** release exactly the selected changed files as one PR */
export const releaseFiles = (repo: string, body: ReleaseFilesBody): Promise<ReleaseResult> =>
  api(`/api/repos/${repo}/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
