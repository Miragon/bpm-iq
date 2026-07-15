/** Live-Host API client — session-based (git-provider OAuth), same-origin. */
import { api } from "@bpmiq/api-client";
import type { AppConfig, Me, ProcessInfo, ReleaseResult, RepoInfo } from "@bpmiq/contracts/live-host";

// re-export so app-internal `instanceof ApiError` call sites keep one import path
export { ApiError } from "@bpmiq/api-client";
// the wire types live in @bpmiq/contracts (the backend assembles them under
// `satisfies` checks) — re-exported so component imports keep one import path
export type { AppConfig, Me, ModelRef, ProcessInfo, ReleaseResult, RepoInfo } from "@bpmiq/contracts/live-host";

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
export const releaseProcess = (repo: string, id: string): Promise<ReleaseResult> =>
  api(`/api/repos/${repo}/release/${id}`, { method: "POST" });
