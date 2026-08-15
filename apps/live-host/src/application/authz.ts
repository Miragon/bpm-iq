/**
 * The ONE repo authorization gate for the request-scoped transports (REST +
 * MCP): registry lookup, then the per-(user,repo) write check — ADR 0001's
 * provider-native authz. Both routers used to carry a private copy of this
 * rule ("the tool-level mirror of api.ts repoOf"); 24 call sites now share
 * this audited one, so a change to the security boundary happens exactly once.
 *
 * Deliberately NOT the WebSocket entrance (collab.ts): its lookup is the
 * room-based splitRoom (longest registry prefix, canonical casing, suspension)
 * with its own dev-token branch — only the denial WORDING is shared there.
 */
import { AppError } from "@bpmiq/http-kit";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface AuthzDeps {
  registry: { get(fullName: string): ConnectedRepo | undefined };
  access: { canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> };
}

export const notConnectedMessage = (fullName: string): string => `not a connected repository: ${fullName}`;
export const noWriteAccessMessage = (login: string, fullName: string): string =>
  `@${login}: no write access to ${fullName}`;

/** resolve + authorize a repo; throws typed errors the transports map
 *  (REST: status + message body, MCP: safe() surfaces the message) */
export async function authorizeRepo(deps: AuthzDeps, session: Session, fullName: string): Promise<ConnectedRepo> {
  const repo = deps.registry.get(fullName);
  if (!repo) {
    throw new AppError("repo/not-connected", notConnectedMessage(fullName), { status: 404, expose: true });
  }
  if (session.id !== "dev" && !(await deps.access.canWrite(session, repo))) {
    throw new AppError("repo/no-write-access", noWriteAccessMessage(session.user.login, repo.fullName), {
      status: 403,
      expose: true,
    });
  }
  return repo;
}
