import { queryDefaults } from "@bpmiq/api-client";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  closeTodo,
  createTodo,
  type CreateTodoBody,
  fetchConfig,
  fetchFileHistory,
  fetchMe,
  fetchProcesses,
  fetchRepos,
  fetchTodos,
  logout,
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
