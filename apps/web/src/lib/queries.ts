import { queryDefaults } from "@bpmiq/api-client";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  closeTodo,
  createDecision,
  type CreateDecisionBody,
  createFolder,
  createModel,
  type CreateModelBody,
  createProcess,
  type CreateProcessBody,
  createTodo,
  type CreateTodoBody,
  fetchChanges,
  fetchConfig,
  fetchDecisions,
  fetchFileHistory,
  fetchFolders,
  fetchMe,
  fetchModels,
  fetchProcesses,
  fetchRepos,
  fetchTodos,
  type FolderListWire,
  logout,
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

/** every model file of ANY registered notation under the repo's models root */
export function useModels(repo: string) {
  return useQuery({ queryKey: ["models", repo], queryFn: () => fetchModels(repo), enabled: repo.length > 0 });
}

/** create a decision from the blank template — cache seeding mirrors
 *  useCreateProcess (the repo view renders from the cached decision list) */
export function useCreateDecision(repo: string) {
  return useCreateModel(repo, "decisions", (body: CreateDecisionBody) => createDecision(repo, body));
}

/** create a model of ANY template-capable notation (#139) — same cache policy
 *  against the registry-wide "models" list the repo view renders from */
export function useCreateNotationModel(repo: string) {
  return useCreateModel(repo, "models", (body: CreateModelBody) => createModel(repo, body));
}

/** the shared create-mutation cache policy: seed the kind's list, then refetch
 *  it, the folder tree (a brand-new folder) and the repo overview — decision
 *  creates used to SKIP the repos invalidation, which becomes real staleness
 *  now that RepoInfo carries decisionCount/dirty decisions */
function useCreateModel<TBody, TInfo extends { id: string; path?: string }>(
  repo: string,
  key: "processes" | "decisions" | "models",
  mutationFn: (body: TBody) => Promise<TInfo>,
) {
  const qc = useQueryClient();
  // seed identity: the models list holds EVERY notation and its ids are only
  // unique PER NOTATION (a wardley 'order' lives beside order.bpmn) — dedupe
  // by path where the row carries one; process rows (no `path`) keep the id
  const identity = (row: TInfo): string => row.path ?? row.id;
  return useMutation({
    mutationFn,
    onSuccess: (created) => {
      qc.setQueryData<TInfo[]>([key, repo], (old) =>
        old ? (old.some((m) => identity(m) === identity(created)) ? old : [...old, created]) : [created],
      );
      void qc.invalidateQueries({ queryKey: [key, repo] });
      // the registry-wide models list contains EVERY kind — a typed create
      // (process/decision) belongs in it too, so it must never stay stale
      if (key !== "models") void qc.invalidateQueries({ queryKey: ["models", repo] });
      void qc.invalidateQueries({ queryKey: ["folders", repo] }); // the folder may be brand-new too
      void qc.invalidateQueries({ queryKey: ["repos"] }); // process/decision/dirty counts changed
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
      // creating a folder only succeeds in a content repo, so seed isContentRepo
      qc.setQueryData<FolderListWire>(["folders", repo], (old) => {
        const folders = old?.folders ?? [];
        if (folders.includes(created.path)) return old;
        return { isContentRepo: true, folders: [...folders, created.path].sort() };
      });
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
  return useCreateModel(repo, "processes", (body: CreateProcessBody) => createProcess(repo, body));
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
      void qc.invalidateQueries({ queryKey: ["models", repo] }); // …and never-released other-notation files
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
