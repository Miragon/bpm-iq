/** Shared same-origin API client for the bpmiq SPAs (session cookie auth). */

/** an API error carrying the HTTP status (so callers can branch on 401/403) */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** fetch JSON from a same-origin API route; non-2xx throws an ApiError */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `API ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** shared TanStack Query defaults: a 401 must surface immediately (→ login),
 *  not be retried, and window focus must not refetch behind the user's back */
export const queryDefaults = { retry: false, refetchOnWindowFocus: false } as const;
