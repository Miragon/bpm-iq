/**
 * The repo overview's last known list, kept across page loads (#212): the
 * overview renders it at once and revalidates in the background, instead of
 * showing nothing until the server's per-repo permission checks are done.
 *
 * ONE entry per origin, stamped with the login it belongs to: read only for
 * that login, overwritten by the next one, removed on logout — one account
 * never sees another account's (private) repo names. Deliberately NOT a
 * TanStack cache persister: that would persist ["me"] too, whose wsToken IS
 * the session id.
 */
import type { Me, RepoInfo } from "@designiq/contracts/live-host";
import type { QueryClient } from "@tanstack/react-query";

/** bump the version when RepoInfo changes incompatibly — old entries are then ignored */
const KEY = "designiq.repos.v1";
/** older than this, a snapshot misleads more than it helps */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface RepoSnapshot {
  login: string;
  savedAt: number;
  repos: RepoInfo[];
}

type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): SnapshotStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // storage blocked (privacy settings) — no snapshot
  }
}

const isRepoRow = (r: unknown): boolean =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as RepoInfo).fullName === "string" &&
  typeof (r as RepoInfo).owner === "string" &&
  typeof (r as RepoInfo).name === "string";

/** the snapshot of `login`, or undefined (none, another login's, too old, unreadable) */
export function readRepoSnapshot(
  login: string,
  storage = browserStorage(),
  now = Date.now(),
): RepoSnapshot | undefined {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return undefined;
    const snap = JSON.parse(raw) as Partial<RepoSnapshot>;
    if (snap.login !== login || typeof snap.savedAt !== "number" || now - snap.savedAt > MAX_AGE_MS) return undefined;
    if (!Array.isArray(snap.repos) || !snap.repos.every(isRepoRow)) return undefined;
    return { login, savedAt: snap.savedAt, repos: snap.repos };
  } catch {
    return undefined;
  }
}

export function writeRepoSnapshot(login: string, repos: RepoInfo[], storage = browserStorage(), now = Date.now()) {
  try {
    storage?.setItem(KEY, JSON.stringify({ login, savedAt: now, repos } satisfies RepoSnapshot));
  } catch {
    /* quota or blocked storage — the next visit simply waits for the server */
  }
}

export function clearRepoSnapshot(storage = browserStorage()) {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* blocked storage never held a snapshot */
  }
}

/**
 * Snapshot every successful ["repos"] result — the query's own fetches AND the
 * overview's forced refresh (a setQueryData) — under the signed-in login.
 * Nothing without a login in the cache: a fetch that lands after logout
 * cleared it must not write the list back.
 */
export function persistRepoSnapshots(qc: QueryClient, storage = browserStorage()): () => void {
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.query.queryKey[0] !== "repos") return;
    const login = qc.getQueryData<Me>(["me"])?.user.login;
    const repos = event.query.state.data as RepoInfo[] | undefined;
    if (login && repos) writeRepoSnapshot(login, repos, storage);
  });
}
