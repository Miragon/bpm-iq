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
    providerToken: "",
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
