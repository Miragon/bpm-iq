/**
 * LIVE_AUTH=none — the declared absence of authentication (ADR 0007).
 *
 * Not a login and not a token: every request, ws join and MCP call resolves
 * to ONE local principal, and every repository the registry knows is
 * writable. Meant for a developer's own machine or a trusted single-team
 * network — the network boundary is the authentication. The mode is never
 * inferred from missing configuration: server.ts refuses to start in `oidc`
 * mode without a login rather than falling into this one.
 *
 * Clients keep sending whatever ws token /api/me hands them; here that is an
 * opaque constant, and the ws join accepts any value.
 */
import { userInfo } from "node:os";

import type { Session } from "../adapters/sqlite/sessions.ts";

/** the `provider` of the local principal — what /api/me and the roster show */
export const LOCAL_PROVIDER = "local";
/** the session id, doubling as the ws token /api/me returns (any value is accepted) */
export const LOCAL_SESSION_ID = "local";

/** the one principal of a none-mode host: `LIVE_LOCAL_USER`, else the OS user
 *  name (in a container that is root/node — set the variable) */
export function makeLocalPrincipal(login?: string): Session {
  const name = login?.trim() || osUser() || "local";
  return {
    id: LOCAL_SESSION_ID,
    user: { login: name, name, avatarUrl: null, provider: LOCAL_PROVIDER },
    createdAt: Date.now(),
  };
}

function osUser(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined; // no passwd entry for the uid (minimal containers)
  }
}

/** none mode's authorization: everything the registry knows is writable —
 *  the same shape as AccessCache, so the transports need no mode switch */
export const allowAllAccess = {
  canWrite: async (): Promise<boolean> => true,
  invalidate: (): void => {},
};

/**
 * A browser request from ANOTHER site is not the local principal. A none-mode
 * host on a developer's machine is reachable from every web page that
 * machine's browser visits — localhost:8301 is inside the "trusted network" —
 * so without this gate a malicious page could read and release repositories
 * through the developer's own browser. Browsers label their requests (Fetch
 * Metadata `Sec-Fetch-Site`; the `Origin` header on cross-origin and WebSocket
 * requests); non-browser clients (curl, the VS Code extension host, MCP
 * clients) send neither and are unaffected. Same-site (another port of the
 * same host — the web dev server, which proxies anyway) is deliberately
 * allowed: the network boundary IS the auth.
 *
 * The Origin fallback is NOT a leftover for old browsers: no browser sends
 * Fetch Metadata on a WebSocket handshake (verified Chrome 153 — `origin` and
 * nothing else), so it decides every browser ws join, plus every same-origin
 * POST. It therefore compares SITES, not origins — the port may differ: a
 * container publishes 8080 under another port (`-p 8301:8080`), and
 * LIVE_PUBLIC_URL names the container's. Scheme and host must still match, so
 * a page on another host is as rejected as before.
 */
export function isCrossSite(header: (name: string) => string | null | undefined, publicUrl?: string): boolean {
  const site = header("sec-fetch-site");
  if (site) return site === "cross-site";
  const origin = header("origin");
  if (!origin || !publicUrl) return false;
  try {
    const from = new URL(origin);
    const ours = new URL(publicUrl);
    return from.protocol !== ours.protocol || from.hostname !== ours.hostname;
  } catch {
    return true; // an unparsable Origin is not ours
  }
}
