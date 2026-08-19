/**
 * Deep-link survival across the login round-trip. The SPA renders the Login
 * screen IN PLACE of the route (routes/root.tsx), so the deep-link URL is
 * still in the address bar when the user clicks "Sign in" — only the
 * full-page `/auth/<provider>` navigation loses it: every server callback
 * lands on "/" (http/api.ts). Deliberately CLIENT-side (sessionStorage,
 * per-tab, per-origin): the OAuth/OIDC state machinery stays untouched, there
 * is no server-side open-redirect surface, and the stash survives every
 * same-tab 302 chain — including the cell-mode control-plane bounce, which a
 * server-side returnTo could never thread through.
 */

const KEY = "bpmiq.returnTo";

/** call from the sign-in click while the deep-link URL is still current */
export function stashReturnTo(): void {
  try {
    if (window.location.pathname !== "/") {
      sessionStorage.setItem(KEY, window.location.pathname + window.location.search);
    } else {
      // signing in FROM the overview must not inherit the stash of an earlier
      // abandoned sign-in — that would teleport an explicit "/" navigation
      sessionStorage.removeItem(KEY);
    }
  } catch {
    /* storage blocked (privacy mode) — the user lands on the overview */
  }
}

/** one-shot read: returns a same-origin path or undefined, always clearing the
 *  stash. "//host" and "/\host" are scheme-relative escapes, not paths. */
export function takeReturnTo(): string | undefined {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value === null) return undefined;
    sessionStorage.removeItem(KEY);
    if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return value;
  } catch {
    /* storage blocked — nothing to restore */
  }
  return undefined;
}
