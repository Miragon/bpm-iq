import { queryDefaults } from "@bpmiq/api-client";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  closeTodo,
  createDecision,
  type CreateDecisionBody,
  createFolder,
  createProcess,
  type CreateProcessBody,
  createTodo,
  type CreateTodoBody,
  type DecisionInfo,
  fetchChanges,
  fetchConfig,
  fetchDecisions,
  fetchFileHistory,
  fetchFolders,
  fetchMe,
  fetchProcesses,
  fetchRepos,
  fetchTodos,
  logout,
  type ProcessInfo,
  releaseFiles,
  type ReleaseFilesBody,
  syncRepo,
  type TodoWire,
} from "@/lib/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      ...queryDefaults, // retry: false — a 401 must surface immediately (→ login), not be retried
      staleTime: 30_000,
    },
  },
});

/** current session identity + ws token; errors (401) drive the login gate */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: fetchMe });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: fetchConfig });
}

/** connected repositories (a forced registry re-sync is a view-level action) */
export function useRepos() {
  return useQuery({ queryKey: ["repos"], queryFn: () => fetchRepos(false) });
}

export function useProcesses(repo: string) {
  return useQuery({ queryKey: ["processes", repo], queryFn: () => fetchProcesses(repo), enabled: repo.length > 0 });
}

/** decisions (.dmn files) under the repo's processes root */
export function useDecisions(repo: string) {
  return useQuery({ queryKey: ["decisions", repo], queryFn: () => fetchDecisions(repo), enabled: repo.length > 0 });
}

/** create a decision from the blank template — cache seeding mirrors
 *  useCreateProcess (the repo view renders from the cached decision list) */
export function useCreateDecision(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDecisionBody) => createDecision(repo, body),
    onSuccess: (created) => {
      qc.setQueryData<DecisionInfo[]>(["decisions", repo], (old) =>
        old ? (old.some((d) => d.id === created.id) ? old : [...old, created]) : [created],
      );
      void qc.invalidateQueries({ queryKey: ["decisions", repo] });
      void qc.invalidateQueries({ queryKey: ["folders", repo] }); // the folder may be brand-new too
    },
  });
}

/** the release dialog's selection pool — refetched on every open (the shared
 *  workspace moves under live edits, a 30s-stale list would mislead) */
export function useChanges(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["changes", repo],
    queryFn: () => fetchChanges(repo),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/** release a file selection as one PR; the changes pool stays dirty until the
 *  PR merges and the workspace reconciles — refetch anyway to reflect deletes.
 *  The PR toast lives HERE (hook level): mutate-level callbacks are skipped
 *  once the dialog unmounted, and a created PR must never go unannounced. */
export function useReleaseFiles(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReleaseFilesBody) => releaseFiles(repo, body),
    onSuccess: ({ pr }) => {
      toast.success("Release created", {
        description: pr,
        action: { label: "Open PR", onClick: () => window.open(pr, "_blank") },
        duration: 15_000,
      });
      void qc.invalidateQueries({ queryKey: ["changes", repo] });
    },
  });
}

/** folders under the repo's processes root — the repo view shows them as rows
 *  (empty ones included, so a just-created folder survives a reload) */
export function useFolders(repo: string) {
  return useQuery({ queryKey: ["folders", repo], queryFn: () => fetchFolders(repo), enabled: repo.length > 0 });
}

/** create a folder; the response is authoritative — seed it into the folder
 *  list right away (same rationale as useCreateTodo) and reconcile via refetch */
export function useCreateFolder(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => createFolder(repo, { path }),
    onSuccess: (created) => {
      qc.setQueryData<string[]>(["folders", repo], (old) =>
        old ? (old.includes(created.path) ? old : [...old, created.path].sort()) : [created.path],
      );
      void qc.invalidateQueries({ queryKey: ["folders", repo] });
    },
  });
}

/** create a process from the blank template.
 *
 *  The editor route resolves /p/$processId against the CACHED process list
 *  (staleTime 30s) — navigating right after the create would hit a permanent
 *  NotFound. The create response IS the new row: seed it into the cache before
 *  the caller navigates, then refetch in the background. */
export function useCreateProcess(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProcessBody) => createProcess(repo, body),
    onSuccess: (created) => {
      qc.setQueryData<ProcessInfo[]>(["processes", repo], (old) =>
        old ? (old.some((p) => p.id === created.id) ? old : [...old, created]) : [created],
      );
      void qc.invalidateQueries({ queryKey: ["processes", repo] });
      void qc.invalidateQueries({ queryKey: ["folders", repo] }); // the folder may be brand-new too
      void qc.invalidateQueries({ queryKey: ["repos"] }); // processCount/dirtyCount changed
    },
  });
}

/** hard-reset the repo's workspace onto its default branch ("load latest from
 *  main") — discards unreleased live edits, so the caller confirms first. On
 *  success the process list (dirty flags) and the overview (dirty counts) are
 *  stale, so refetch both. */
export function useSyncRepo(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => syncRepo(repo),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["processes", repo] });
      void qc.invalidateQueries({ queryKey: ["decisions", repo] }); // never-released .dmn files are gone too
      void qc.invalidateQueries({ queryKey: ["folders", repo] }); // the reset deletes never-released folders
      void qc.invalidateQueries({ queryKey: ["repos"] });
    },
  });
}

/** default-branch commit history of one model file — fetched while the panel
 *  is open (`enabled`). It moves OUTSIDE the app (a release PR merges on the
 *  provider), so poll once a minute while the panel is open and re-sync on
 *  focus — the same pattern as useTodos, same rationale. */
export function useFileHistory(repo: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["history", repo, path],
    queryFn: () => fetchFileHistory(repo, path),
    enabled: enabled && repo.length > 0 && path.length > 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** open todos of a repo, optionally narrowed to one process (`?process=<id>`) */
export function useTodos(repo: string, process?: string, enabled = true) {
  return useQuery({
    queryKey: ["todos", repo, process ?? null],
    queryFn: () => fetchTodos(repo, process),
    enabled: enabled && repo.length > 0,
    // todos change outside the app (closed on GitHub, filed by hand): poll once
    // a minute while the tab is focused (refetchIntervalInBackground stays false)
    // and re-sync on focus — per-query overrides, the shared queryDefaults keep
    // refetchOnWindowFocus: false for everything else
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** create a model-anchored todo.
 *
 *  GitHub's issue LIST lags the create by a few seconds (eventual consistency),
 *  so an immediate refetch would come back WITHOUT the new todo and overwrite
 *  the cache with the stale list. The create RESPONSE is authoritative: write
 *  it into every matching todos query directly; the 60s poll / focus refetch
 *  reconciles with the tracker later. */
export function useCreateTodo(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTodoBody) => createTodo(repo, body),
    onSuccess: (created) => {
      for (const [key, data] of qc.getQueriesData<TodoWire[]>({ queryKey: ["todos", repo] })) {
        const processFilter = key[2] as string | null | undefined;
        // per-process queries only receive todos anchored to that process
        if (processFilter != null && processFilter !== created.anchor?.process) continue;
        if (data?.some((t) => t.id === created.id)) continue;
        qc.setQueryData<TodoWire[]>(key, [created, ...(data ?? [])]);
      }
    },
  });
}

/** close a todo in the tracker; drops the row from every todos query of the
 *  repo right away (badges/counts follow via setTodos). No invalidation on
 *  success — the tracker's list lags the close (same eventual consistency as
 *  create) and would resurrect the row; the poll reconciles. On ERROR the
 *  invalidation restores the optimistically removed row. */
export function useCloseTodo(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => closeTodo(repo, id),
    onSuccess: (_result, id) =>
      qc.setQueriesData<TodoWire[]>({ queryKey: ["todos", repo] }, (old) => old?.filter((t) => t.id !== id)),
    onError: () => qc.invalidateQueries({ queryKey: ["todos", repo] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: logout, onSuccess: () => qc.clear() });
}
