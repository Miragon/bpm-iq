/**
 * The "Open Live Model" picker's data — pure (no vscode API), fed by the Live
 * Host's overview routes: GET /api/repos (the repos this session may write)
 * and GET /api/repos/<repo>/models (every model of every registered notation).
 * Unit-tested in src/test/unit/model-picker.test.ts.
 */
import { roomName } from "@bpmiq/contracts/live";
import type { ModelInfo, RepoInfo } from "@bpmiq/contracts/live-host";

/** a QuickPick item carrying its value — the shape vscode.window.showQuickPick
 *  renders (label with $(icon) syntax, description, detail) */
export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

/** repos a person can open: write access, not suspended — by name */
export function repoItems(repos: RepoInfo[]): PickItem<RepoInfo>[] {
  return repos
    .filter((r) => r.permission === "write" && !r.suspended)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((r) => ({ label: `$(repo) ${r.fullName}`, description: describeRepo(r), value: r }));
}

function describeRepo(r: RepoInfo): string {
  const parts: string[] = [];
  if (r.processCount !== null) parts.push(`${r.processCount} processes`);
  if (r.decisionCount !== null) parts.push(`${r.decisionCount} decisions`);
  if (r.liveSessions > 0) parts.push(`${r.liveSessions} live`);
  return parts.join(" · ");
}

/** models by folder, then name; the description says what it is and who is
 *  on it, the detail is the repo-relative path (searchable) */
export function modelItems(models: ModelInfo[]): PickItem<ModelInfo>[] {
  return [...models]
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
    .map((m) => ({
      label: `$(file) ${m.name}`,
      description: [
        m.notation,
        m.folder || undefined,
        m.liveSessions > 0 ? `${m.liveSessions} live` : undefined,
        m.dirty ? "unreleased changes" : undefined,
      ]
        .filter((p): p is string => p !== undefined)
        .join(" · "),
      detail: m.path,
      value: m,
    }));
}

/** the bpm-live URI of a model — the path IS the room name */
export function modelUri(repoFullName: string, path: string): string {
  return `bpm-live:/${roomName(repoFullName, path)}`;
}
