import { queryDefaults } from "@bpmiq/api-client";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  closeTodo,
  createTodo,
  type CreateTodoBody,
  fetchConfig,
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

/** create a model-anchored todo; invalidates every todos query of the repo (all + per-process) */
export function useCreateTodo(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTodoBody) => createTodo(repo, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["todos", repo] }),
  });
}

/** close a todo in the tracker; drops the row from every todos query of the
 *  repo right away (badges/counts follow via setTodos), then re-syncs by
 *  invalidating the ["todos", repo] prefix on settle */
export function useCloseTodo(repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => closeTodo(repo, id),
    onSuccess: (_result, id) =>
      qc.setQueriesData<TodoWire[]>({ queryKey: ["todos", repo] }, (old) => old?.filter((t) => t.id !== id)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["todos", repo] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: logout, onSuccess: () => qc.clear() });
}
