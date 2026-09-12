/**
 * The Live Host's HTTP side (companion to the Hocuspocus ws server).
 *
 * Access model (docs/multi-repo-architecture.md): LOGIN AUTHENTICATES,
 * REPOS AUTHORIZE. The IdP login only establishes who you are; whether you
 * may see/edit/release a repository is decided per (user, repo) app-side
 * against the GitHub App's installation (ADR 0001) — the connected-repo set
 * derives from its installations (RepoRegistry). ADR 0007: the IdP is the
 * one login; LIVE_AUTH=none is the declared absence of one.
 *
 *   GET  /api/config                             → auth mode, login, app install URL
 *   GET  /auth/oidc(/callback)                   → browser OIDC login (code+PKCE) — THE login
 *        …?editor=<scheme>&editor_state=<nonce> → the SAME login landing in an editor (editor-login.ts)
 *   POST /auth/exchange                          → editor sign-in: one-time code → Me (session id as wsToken)
 *   GET  /api/me, POST /api/logout               (logout: cookie session, or the Bearer session id)
 *   GET  /api/repos                              → repo OVERVIEW (per-user permission)
 *   GET  /api/repos/:owner/:repo/processes       → process list      (repo write required)
 *   POST /api/repos/:owner/:repo/processes       → create a process from the blank template (repo write required)
 *   GET  /api/repos/:owner/:repo/decisions       → decision (.dmn) list (repo write required)
 *   POST /api/repos/:owner/:repo/decisions       → create a decision from the blank template (repo write required)
 *   POST /api/repos/:owner/:repo/models          → create a model of any template-capable notation (repo write required)
 *   GET  /api/repos/:owner/:repo/folders         → folders under the processes root (repo write required)
 *   POST /api/repos/:owner/:repo/folders         → create a folder   (repo write required)
 *   GET  /api/repos/:owner/:repo/changes         → files differing from origin (release selection pool)
 *   POST /api/repos/:owner/:repo/release         → release a FILE SELECTION as one PR (repo write required)
 *   POST /api/repos/:owner/:repo/sync            → hard-reset workspace to origin/<default> (repo write required)
 *   GET  /api/repos/:owner/:repo/history         → default-branch commits of one model file (repo write required)
 *   GET  /api/repos/:owner/:repo/history/content → that file's content at a commit (repo write required)
 *   GET  /api/repos/:owner/:repo/todos           → open model-anchored todos (repo write required)
 *   POST /api/repos/:owner/:repo/todos           → create a todo in the repo's tracker (repo write required)
 *   POST /api/repos/:owner/:repo/todos/:id/close → close a todo in the tracker (repo write required)
 *   POST /api/repos/:owner/:repo/release/:id     → release AS THE USER (repo write required)
 *   GET  /api/repos/:owner/:repo/content?path=   → current LIVE model content + baseVersion (repo write required)
 *   PUT  /api/repos/:owner/:repo/content?path=   → validate + CAS-save into the live doc (repo write required)
 *   POST /mcp                                    → MCP endpoint (stateless Streamable HTTP; session id / OIDC JWT / none-mode principal)
 *   GET  /.well-known/oauth-protected-resource(/mcp) → RFC-9728 PRM, per resource (only when OIDC is configured)
 *   POST /webhook/github                         → installation lifecycle (HMAC-verified)
 *   GET  /setup/installed                        → post-install sync + redirect
 *   GET  /healthz, /*                            → liveness, built web app (public)
 *
 * Releases push with the App's installation token and open the PR bot-authored
 * with the human as git author (ADR 0001) — merge rights stay at the provider
 * (CODEOWNERS/branch protection).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

import type {
  AppConfig,
  ChangedFileWire,
  ContentConflictWire,
  ContentWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateModelBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  EditorLoginExchangeBody,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ModelInfo,
  ProcessInfo,
  PutContentRequest,
  PutContentResultWire,
  ReleaseFilesBody,
  ReleaseResult,
  SyncResult,
  TodoWire,
} from "@bpmiq/contracts/live-host";
import { AppError, bearerAuth, errorBody, readBody, redirect, securityHeaders, send } from "@bpmiq/http-kit";

import {
  clearCookie,
  clearEditorCookie,
  clearOauthCookie,
  clearPkceCookie,
  COOKIE,
  EDITOR_COOKIE,
  editorCookie,
  OAUTH_COOKIE,
  oauthCookie,
  PKCE_COOKIE,
  pkceCookie,
  readCookie,
  type Session,
  sessionCookie,
  type SessionStore,
} from "../adapters/sqlite/sessions.ts";
import type { AgentPresence } from "../application/agent-presence.ts";
import { authorizeRepo } from "../application/authz.ts";
import { type DirectDoc, getContent, putContent } from "../application/content.ts";
import { fileAtCommit, fileHistory } from "../application/history.ts";
import type { LoginCodeStore } from "../application/login-codes.ts";
import { listAllModels, listChanges, listDecisions, listProcesses, listRepos } from "../application/overview.ts";
import type { RoomPresenceDeps } from "../application/room-presence.ts";
import {
  createDecision,
  createFolder,
  createNotationModel,
  createProcess,
  listFolders,
} from "../application/scaffold.ts";
import { syncRepo } from "../application/sync.ts";
import { closeTodoFor, fileTodo } from "../application/todos.ts";
import type { WsTicketStore } from "../application/ws-tickets.ts";
import type { RepoConnectionSource } from "../ports/connection-source.ts";
import type { GitProvider } from "../ports/git-provider.ts";
import type { IssueTracker } from "../ports/issue-tracker.ts";
import { release, releaseFiles } from "../release.ts";
import type { AccessCache } from "../repos/access.ts";
import type { ConnectedRepo, RepoRegistry } from "../repos/registry.ts";
import type { WorkspaceManager } from "../repos/workspaces.ts";
import {
  decodeEditorCookie,
  editorReturnPage,
  editorReturnUri,
  encodeEditorCookie,
  parseEditorLogin,
} from "./editor-login.ts";
import { handleMcp } from "./mcp.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface ApiOptions {
  webDist: string;
  publicUrl: string;
  /** the release backend: push URL + PR creation on installation tokens */
  github: GitProvider;
  sessions: SessionStore;
  registry: RepoRegistry;
  workspaces: WorkspaceManager;
  access: Pick<AccessCache, "canWrite" | "invalidate">;
  /** LIVE_AUTH=none (auth/none.ts, ADR 0007): the ONE principal every request
   * resolves to, whatever credential it carries — absent = authenticated mode */
  local?: Session;
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
  /** invalidate a room's Yjs lineage — sync-to-default drops the reset files' lineage */
  dropLineage: (room: string) => void;
  /** provider seam for the connected-repo set: connect URL + webhook verification */
  connectionSource?: RepoConnectionSource;
  /** issue-tracker seam (model-anchored todos) — absent when the platform has
   * no credentials to act on the tracker (the /todos routes then answer 501) */
  issues?: IssueTracker;
  /** cell mode (ADR 0002): the control-plane origin (derived from
   * TOKEN_MINT_URL) — a cross-tenant OIDC login redirects there for re-routing */
  controlPlaneUrl?: string;
  /** cell mode: this cell's tenant — the cross-tenant redirect asks the
   * platform to rescope the IdP session to exactly this org (?org=…) */
  tenantInstallationId?: number;
  /** deep liveness (ADR 0002): SQLite writable + disk free — 503 when degraded */
  deepHealth?: () => Promise<{ ok: boolean; checks: Record<string, unknown> }>;
  /** cell mode: secret unlocking the /healthz DETAIL (the control-plane fleet poll
   * presents it). Unset (standalone) → detail is public (single-tenant box). */
  healthAuth?: string;
  /** server-side handle to a live room (Hocuspocus direct connection) — the
   * content routes and MCP tools read/write the SAME docs the ws rooms edit */
  openDoc: (room: string) => Promise<DirectDoc>;
  /** the room size cap — content PUT enforces it itself (the ws-side ingest
   * guard never runs for direct connections) */
  maxDocBytes: number;
  /** native OIDC bearer-JWT auth (headless clients) — absent = session-ids only.
   * The verifier throws typed AppErrors (401) on every failure; api.ts stays
   * adapter-free, the implementation is injected from server.ts (auth/oidc.ts). */
  oidc?: {
    verify: (token: string) => Promise<{ login: string; name: string; sub: string }>;
    /** advertised in the RFC-9728 protected-resource metadata */
    issuer: string;
    /** OAuth scopes advertised in the PRM (scopes_supported) and the 401
     * challenge (scope=…). Absent → neither is emitted. */
    scopes?: string[];
  };
  /** interactive browser OIDC login (auth/oidc-login.ts) — code+PKCE flow whose
   * access token is validated by `oidc.verify` (requires `oidc`). Present → the
   * web client shows the SSO button ("/auth/oidc"). */
  oidcLogin?: {
    label: string;
    authorizeUrl(redirectUri: string, state: string, codeChallenge: string): Promise<string>;
    exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string }>;
  };
  /** omit the write tools (create/save/release) from /mcp */
  mcpReadOnly?: boolean;
  /** single-use ws tickets for the MCP-App widget's live Yjs connection
   * (application/ws-tickets.ts) — absent = the widget stays on bridge autosave */
  wsTickets?: WsTicketStore;
  /** single-use sign-in codes for EDITOR logins (application/login-codes.ts,
   * http/editor-login.ts) — absent = a ?editor= login start answers 501 */
  loginCodes?: LoginCodeStore;
  /** agent presence (application/agent-presence.ts): the MCP tools announce
   * the caller's agent in every room they touch — absent = agents stay invisible */
  presence?: Pick<AgentPresence, "touch">;
  /** who is in a room (get_presence) — the raw peers of a LOADED room */
  peersOf?: RoomPresenceDeps["peersOf"];
}

// send/redirect/readBody/securityHeaders/bearerAuth come from @bpmiq/http-kit —
// the shared, unit-tested primitives (one canonical impl for both backends).
// NB send() now emits compact JSON (was pretty-printed here); the e2e greps are
// whitespace-tolerant (`"key": *"value"`), verified before the switch.
// listProcesses/listRepos (the overview read-models) live in application/overview.ts —
// ApiOptions structurally satisfies their injected OverviewDeps surface.

/** parse a JSON request body; sends the 400/413 itself and returns undefined */
async function jsonBody<T>(req: IncomingMessage, res: ServerResponse, maxBytes?: number): Promise<T | undefined> {
  try {
    return JSON.parse((await readBody(req, { maxBytes })).toString()) as T;
  } catch (e) {
    if (e instanceof Error && e.message === "body too large") {
      send(res, 413, { error: "body too large" });
    } else {
      send(res, 400, { error: "invalid JSON body" });
    }
    return undefined;
  }
}

function serveStatic(dist: string, urlPath: string, res: ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath); // `GET /%` etc. throws — a bad path is 400, not a 500
  } catch {
    return send(res, 400, { error: "bad path encoding" });
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  for (const file of [join(dist, safe), join(dist, safe, "index.html"), join(dist, "index.html")]) {
    if (!file.startsWith(dist)) break;
    if (existsSync(file) && statSync(file).isFile()) {
      // HTML must never be cached (it references the hashed bundles); the
      // content-hashed assets themselves are immutable
      const immutable = file.includes("/assets/");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(file).pipe(res);
      return;
    }
  }
  send(res, 404, "not found");
}

/** the browser-reachable auth surface that answers CORS (public metadata + /mcp) */
const CORS_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/mcp",
]);

export function startApi(port: number, opts: ApiOptions): Server {
  const secure = opts.publicUrl.startsWith("https");

  const sessionOf = async (req: IncomingMessage): Promise<Session | undefined> => {
    // LIVE_AUTH=none: everyone is the local principal (ADR 0007)
    if (opts.local) return opts.local;
    const sid = readCookie(req.headers.cookie, COOKIE);
    const fromCookie = opts.sessions.get(sid);
    if (fromCookie) return fromCookie;
    // headless clients: Authorization: Bearer <session-id or OIDC JWT>
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    // a JWS-shaped bearer (three dot-separated parts) is a JWT, never a session
    // id — verify it (throws a typed 401 AppError) instead of a doomed lookup.
    // The session is SYNTHETIC (never persisted): identity only, like every
    // session; per-repo authz runs app-side against the login (AccessCache).
    if (bearer && opts.oidc && bearer.split(".").length === 3) {
      const id = await opts.oidc.verify(bearer);
      return {
        id: `oidc:${id.sub}`,
        user: { login: id.login, name: id.name, avatarUrl: null, provider: "oidc" },
        createdAt: Date.now(),
      };
    }
    return opts.sessions.get(bearer);
  };

  // ── editor sign-in (http/editor-login.ts) ──────────────────────────────
  // A login START may carry ?editor=<scheme>&editor_state=<nonce>: returns the
  // flow cookie to set alongside the OAuth nonce, undefined for a plain
  // browser login, or answers the 400/501 itself and returns null.
  const editorStart = (res: ServerResponse, params: URLSearchParams): string | undefined | null => {
    const editor = parseEditorLogin(params);
    if (editor === undefined) return undefined;
    if (editor === null) {
      send(res, 400, { error: "invalid editor sign-in parameters" });
      return null;
    }
    if (!opts.loginCodes) {
      send(res, 501, { error: "editor sign-in is not available on this host" });
      return null;
    }
    return editorCookie(encodeEditorCookie(editor), secure);
  };
  // The login LANDING, shared by every callback: an editor flow gets the
  // one-time-code page and NO session cookie (its session stays separate from
  // any web session); a browser flow the cookie + redirect home.
  const finishLogin = (req: IncomingMessage, res: ServerResponse, session: Session, clearFlow: string[]): void => {
    const editor = decodeEditorCookie(readCookie(req.headers.cookie, EDITOR_COOKIE));
    if (editor && opts.loginCodes) {
      const code = opts.loginCodes.issue(session.id);
      return send(res, 200, editorReturnPage(editorReturnUri(editor, code), session.user.login), {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": [...clearFlow, clearEditorCookie(secure)],
      });
    }
    return redirect(res, "/", { "set-cookie": [sessionCookie(session.id, secure), ...clearFlow] });
  };

  // RFC 9728: 401s advertise where the protected-resource metadata lives, so
  // MCP clients can discover the IdP and run their OAuth flow unattended. The
  // metadata URL is resource-specific (§3.3): /mcp has its OWN document whose
  // `resource` carries the /mcp path (claude.ai matches it exactly, incl. the
  // path component), so a /mcp 401 must point there — not at the root document.
  const prmPath = (pathname: string): string =>
    pathname === "/mcp" || pathname.startsWith("/mcp/")
      ? "/.well-known/oauth-protected-resource/mcp"
      : "/.well-known/oauth-protected-resource";
  const challenge = (pathname: string): Record<string, string> => {
    if (!opts.oidc) return {};
    let v = `Bearer resource_metadata="${opts.publicUrl}${prmPath(pathname)}"`;
    // the challenge scope is authoritative for the client (SEP-835); emit it
    // only when configured, else clients request an empty scope
    if (opts.oidc.scopes?.length) v += `, scope="${opts.oidc.scopes.join(" ")}"`;
    return { "www-authenticate": v };
  };
  const unauthorized = (res: ServerResponse, body: unknown, pathname: string): void =>
    send(res, 401, body, challenge(pathname));

  /** RFC 9728 metadata body for one resource identifier (guard `opts.oidc` at the call). */
  const prm = (resource: string): Record<string, unknown> => ({
    resource,
    authorization_servers: [opts.oidc!.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "bpmiq Live Host",
    ...(opts.oidc!.scopes?.length ? { scopes_supported: opts.oidc!.scopes } : {}),
  });

  /** the create routes' shared body gate (undefined = the 400 was already sent) */
  const parseCreateBody = (
    res: ServerResponse,
    body: CreateProcessBody | CreateDecisionBody | undefined,
  ): { name: string; folder?: string } | undefined => {
    if (body === undefined) return undefined;
    if (typeof body?.name !== "string" || body.name.trim().length === 0) {
      send(res, 400, { error: "name must be a non-empty string" });
      return undefined;
    }
    if (body.folder !== undefined && typeof body.folder !== "string") {
      send(res, 400, { error: "folder must be a string" });
      return undefined;
    }
    return { name: body.name, folder: body.folder };
  };

  /** resolve + authorize a repo route segment (the shared application-layer
   *  gate); sends the error response itself — NOT via the catch-all, which
   *  would log every ordinary 403 as a 500 and re-run sessionOf */
  const repoOf = async (
    res: ServerResponse,
    session: Session,
    fullName: string,
  ): Promise<ConnectedRepo | undefined> => {
    try {
      return await authorizeRepo(opts, session, fullName);
    } catch (e) {
      const err = e as AppError;
      send(res, err.status ?? 500, { error: err.message });
      return undefined;
    }
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", opts.publicUrl);
    try {
      // baseline security headers on EVERY response (API, redirects, static web app)
      securityHeaders(res, { secure });

      // CORS for the browser-reachable auth surface: the public PRM documents and
      // /mcp. Origin "*" but NEVER credentials — so a browser never sends cookies
      // cross-origin (the cookie-session path stays same-origin only), and a
      // cross-origin MCP client must authenticate with a Bearer token. setHeader
      // (not writeHead) so the route's own writeHead merges on top.
      if (CORS_PATHS.has(url.pathname)) {
        res.setHeader("access-control-allow-origin", "*");
        // without this the 401's challenge is invisible to a browser client —
        // www-authenticate is not in the CORS-safelisted response headers
        res.setHeader("access-control-expose-headers", "www-authenticate");
        res.setHeader("vary", "origin");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
            "access-control-max-age": "600",
          });
          return res.end();
        }
      }

      if (url.pathname === "/healthz") {
        // static ok unless a deep check is wired; a degraded cell (SQLite
        // unwritable, disk full) must fail the Fly health check, not green-light
        if (!opts.deepHealth) return send(res, 200, "ok");
        const h = await opts.deepHealth();
        const status = h.ok ? "ok" : "degraded";
        // the detail (tenant id, liveDocs, disk) is operator-only in cell mode — a
        // public probe (and the Fly health check) gets status + the 200/503 code. The
        // control-plane fleet poll presents the cell secret to read the detail.
        const authed = !opts.healthAuth || bearerAuth(req, opts.healthAuth);
        return send(res, h.ok ? 200 : 503, authed ? { status, ...h.checks } : { status });
      }

      // RFC 9728 protected-resource metadata (public) — MCP clients resolve the
      // IdP from here after a 401's WWW-Authenticate challenge. Only exists when
      // OIDC is configured; a session-only deployment has nothing to advertise.
      if (opts.oidc && url.pathname === "/.well-known/oauth-protected-resource") {
        return send(res, 200, prm(opts.publicUrl));
      }
      // RFC 9728 §3.3: the /mcp resource has its OWN metadata, whose `resource`
      // carries the /mcp path — clients that match the resource URL exactly
      // (claude.ai) read this one, discovered from the /mcp 401 challenge.
      if (opts.oidc && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return send(res, 200, prm(`${opts.publicUrl}/mcp`));
      }

      // ── installation lifecycle ───────────────────────────────────────
      // GitHub redirects here after (re)installation of the central app.
      // requestSync() coalesces (single-flight + 10s min interval), so an
      // anonymous flood of this endpoint can't amplify into GitHub API calls.
      if (url.pathname === "/setup/installed") {
        await opts.registry
          .requestSync()
          .catch((e) => console.log(`post-install sync failed: ${(e as Error).message}`));
        opts.access.invalidate();
        // ?connected=1 makes the overview force a fresh sync via the session-
        // gated refresh path (guarantees the just-added repo shows even if this
        // anonymous, coalesced sync was skipped)
        return redirect(res, "/?connected=1");
      }
      if (url.pathname === "/webhook/github" && req.method === "POST") {
        const body = await readBody(req);
        // verification is the connection source's job (GitHub: HMAC signature;
        // GitLab later: X-Gitlab-Token). FAIL CLOSED: unverifiable = refused,
        // unauthenticated POSTs never drive syncs (adversarial review).
        const verdict = opts.connectionSource?.verifyWebhook(req.headers, body);
        if (!verdict) return send(res, 503, { error: "webhook not configured" });
        if (!verdict.authentic) return send(res, 401, { error: "invalid signature" });
        if (verdict.membershipChanged) {
          opts.registry
            .requestSync()
            .then(() => opts.access.invalidate())
            .catch((e) => console.log(`webhook sync failed: ${(e as Error).message}`));
        }
        return send(res, 202, { ok: true });
      }

      // ── browser OIDC login (auth/oidc-login.ts): code + PKCE against the
      // configured IdP; the access token is verified by the SAME resource-server
      // verifier as MCP bearers (issuer/audience/login claim/tenant gate — one
      // identity contract, two entrances). The session is identity-only
      // (ADR 0001); per-repo authorization runs app-side as everywhere.
      if (opts.oidcLogin && url.pathname === "/auth/oidc") {
        const editor = editorStart(res, url.searchParams);
        if (editor === null) return;
        const redirectUri = `${opts.publicUrl}/auth/oidc/callback`;
        // browser-bound state (login-CSRF/fixation) + PKCE verifier, both riding
        // in short-lived HttpOnly cookies
        const { state, nonce } = opts.sessions.issueState("oidc");
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        return redirect(res, await opts.oidcLogin.authorizeUrl(redirectUri, state, challenge), {
          "set-cookie": [oauthCookie(nonce, secure), pkceCookie(verifier, secure), ...(editor ? [editor] : [])],
        });
      }
      if (opts.oidcLogin && url.pathname === "/auth/oidc/callback") {
        const clearFlow = [clearOauthCookie(secure), clearPkceCookie(secure), clearEditorCookie(secure)];
        if (
          !opts.sessions.verifyState(
            url.searchParams.get("state"),
            "oidc",
            readCookie(req.headers.cookie, OAUTH_COOKIE),
          )
        ) {
          return send(res, 400, { error: "invalid OAuth state" }, { "set-cookie": clearFlow });
        }
        const denied = url.searchParams.get("error");
        if (denied) {
          return send(
            res,
            401,
            { error: `sign-in refused by the identity provider: ${denied}` },
            { "set-cookie": clearFlow },
          );
        }
        const code = url.searchParams.get("code");
        const verifier = readCookie(req.headers.cookie, PKCE_COOKIE);
        if (!code || !verifier) return send(res, 400, { error: "missing code" }, { "set-cookie": clearFlow });
        const { accessToken } = await opts.oidcLogin.exchangeCode(
          code,
          `${opts.publicUrl}/auth/oidc/callback`,
          verifier,
        );
        // fail closed: signature, issuer, audience, login claim — and in cell
        // mode the tenant gate. A token for ANOTHER tenant is not an error page
        // but a routing problem: the platform's login re-routes to the right cell.
        let id: { login: string; name: string; sub: string };
        try {
          if (!opts.oidc) return send(res, 503, { error: "OIDC login not configured" });
          id = await opts.oidc.verify(accessToken);
        } catch (e) {
          if (e instanceof AppError && e.code === "auth/wrong-tenant" && opts.controlPlaneUrl) {
            // the session is scoped to ANOTHER tenant's org — ask the platform
            // to rescope it to THIS one (silent with a live IdP session), so a
            // cross-workspace bookmark self-heals instead of dead-ending
            const org = opts.tenantInstallationId !== undefined ? `?org=${opts.tenantInstallationId}` : "";
            return redirect(res, `${opts.controlPlaneUrl}/login${org}`, { "set-cookie": clearFlow });
          }
          throw e;
        }
        const session = opts.sessions.create({ login: id.login, name: id.name, avatarUrl: null, provider: "oidc" });
        console.log(`oidc login: @${id.login}`);
        return finishLogin(req, res, session, clearFlow);
      }
      // the IdP is the only browser login (ADR 0007): unconfigured, its routes
      // are a 404 — never the SPA fallthrough
      if (url.pathname === "/auth/oidc" || url.pathname === "/auth/oidc/callback") {
        return send(res, 404, { error: "browser login not configured" });
      }

      // ── editor sign-in, step 3: the one-time code becomes the session ───
      if (url.pathname === "/auth/exchange" && req.method === "POST") {
        if (!opts.loginCodes) return send(res, 501, { error: "editor sign-in is not available on this host" });
        const body = await jsonBody<EditorLoginExchangeBody>(req, res, 4096);
        if (!body) return;
        const session =
          typeof body.code === "string" ? opts.sessions.get(opts.loginCodes.redeem(body.code)) : undefined;
        if (!session) return send(res, 401, { error: "invalid, used or expired sign-in code" });
        console.log(`editor sign-in: @${session.user.login}`);
        return send(res, 200, { user: session.user, wsToken: session.id } satisfies Me);
      }

      // ── session-facing API ───────────────────────────────────────────
      if (url.pathname === "/api/config") {
        return send(res, 200, {
          // the IdP login when configured — the web client renders it generically
          // as a "/auth/<id>" button (empty in none mode: nothing to sign in to)
          providers: opts.oidcLogin ? [{ id: "oidc", label: opts.oidcLogin.label }] : [],
          // ADR 0007: "none" tells the clients there is nothing to sign in to
          auth: opts.local ? "none" : "oidc",
          installUrl: opts.connectionSource?.connectUrl() ?? null,
          // publicUrl, not the request Host — the URL must work from OUTSIDE
          // (an AI client on another machine), and behind a proxy the Host
          // header is the internal address
          mcpUrl: `${opts.publicUrl}/mcp`,
        } satisfies AppConfig);
      }
      if (url.pathname === "/api/me") {
        const session = await sessionOf(req);
        if (!session) return unauthorized(res, { error: "not logged in" }, url.pathname);
        // NB for an OIDC-JWT session wsToken is the synthetic id — NOT a usable
        // ws token (the ws join stays session-id-only for now)
        return send(res, 200, { user: session.user, wsToken: session.id } satisfies Me);
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        // the cookie session — or, for an editor / headless client, the Bearer
        // session id (a JWT bearer or the local principal names no row: a no-op delete)
        const sid = readCookie(req.headers.cookie, COOKIE) ?? req.headers.authorization?.replace(/^Bearer /, "");
        if (sid) opts.sessions.delete(sid);
        return send(res, 200, { ok: true }, { "set-cookie": clearCookie() });
      }

      // repo OVERVIEW
      if (url.pathname === "/api/repos") {
        const session = await sessionOf(req);
        if (!session) return unauthorized(res, { error: "not logged in" }, url.pathname);
        if (url.searchParams.has("refresh")) {
          // session-gated explicit refresh → force a real sync (bypass the 10s
          // coalesce) so a repo just added on GitHub appears now
          await opts.registry
            .requestSync(true)
            .catch((e) => console.log(`refresh sync failed: ${(e as Error).message}`));
          opts.access.invalidate();
        }
        return send(res, 200, await listRepos(opts, session));
      }

      // repo-scoped: processes + history (+ /content) + todos (+ close) + release.
      // The repo segment is GREEDY (multi-segment) — GitLab projects live in
      // subgroups, so "owner/name" must not be baked into the route shape. The
      // registry decides what a repo is.
      // Group 3 = todo id (tracker-native, opaque: GitHub numbers, Jira "PROJ-123"),
      // group 4 = release process id.
      // `content` (the LIVE model content) is the LAST alternative with a
      // lookbehind: without it the greedy repo group backtracks and captures
      // ".../history" as the repo so "history/content" would match as bare
      // "content". A repo literally NAMED "<owner>/history" therefore cannot
      // address /content over REST (the URL is claimed by history/content) —
      // accepted keyword-collision edge; MCP tools and ws rooms are unaffected.
      const repoRoute = url.pathname.match(
        /^\/api\/repos\/(.+)\/(processes|decisions|models|folders|changes|sync|history(?:\/content)?|todos(?:\/([0-9A-Za-z-]+)\/close)?|release(?:\/([^/]+))?|(?<!\/history\/)content)$/,
      );
      if (repoRoute) {
        const session = await sessionOf(req);
        if (!session) return unauthorized(res, { error: "not logged in" }, url.pathname);
        const repo = await repoOf(res, session, repoRoute[1] ?? "");
        if (!repo) return;
        if (repoRoute[2] === "processes") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = parseCreateBody(res, await jsonBody<CreateProcessBody>(req, res));
            if (body === undefined) return;
            const created = await createProcess(repo, workspace, body);
            console.log(`process created in ${repo.fullName} by @${session.user.login}: ${created.bpmn}`);
            return send(res, 201, created satisfies ProcessInfo);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await listProcesses(opts, repo, workspace));
        }
        if (repoRoute[2] === "decisions") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = parseCreateBody(res, await jsonBody<CreateDecisionBody>(req, res));
            if (body === undefined) return;
            const created = await createDecision(repo, workspace, body);
            console.log(`decision created in ${repo.fullName} by @${session.user.login}: ${created.path}`);
            return send(res, 201, created satisfies DecisionInfo);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await listDecisions(opts, repo, workspace));
        }
        // every model file of ANY registered notation — the registry-wide
        // superset of /processes and /decisions. POST creates a model of any
        // TEMPLATE-capable notation (#139); bpmn/dmn keep their typed routes
        // (richer wire rows), everything else goes through here.
        if (repoRoute[2] === "models") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = await jsonBody<CreateModelBody>(req, res);
            if (body === undefined) return;
            if (typeof body?.notation !== "string" || body.notation.length === 0) {
              return send(res, 400, { error: "notation must be a non-empty string" });
            }
            if (typeof body?.name !== "string" || body.name.trim().length === 0) {
              return send(res, 400, { error: "name must be a non-empty string" });
            }
            if (body.folder !== undefined && typeof body.folder !== "string") {
              return send(res, 400, { error: "folder must be a string" });
            }
            const created = await createNotationModel(repo, workspace, body);
            console.log(
              `model created in ${repo.fullName} by @${session.user.login}: ${created.path} (${created.notation})`,
            );
            return send(res, 201, created satisfies ModelInfo);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await listAllModels(opts, repo, workspace));
        }
        if (repoRoute[2] === "folders") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = await jsonBody<CreateFolderBody>(req, res);
            if (body === undefined) return;
            if (typeof body?.path !== "string" || body.path.trim().length === 0) {
              return send(res, 400, { error: "path must be a non-empty string" });
            }
            const path = await createFolder(repo, workspace, body.path);
            console.log(`folder created in ${repo.fullName} by @${session.user.login}: ${path}/`);
            return send(res, 201, { path } satisfies FolderWire);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, (await listFolders(workspace)) satisfies FolderListWire);
        }
        // hard-reset the workspace onto origin/<default> ("load latest from main")
        // — DISCARDS unreleased live edits (the web client confirms first). Refuses
        // the in-place host checkout (422) and repos with open sessions (409).
        if (repoRoute[2] === "sync") {
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          const result = await syncRepo(opts, repo);
          console.log(
            `synced ${repo.fullName} → origin/${repo.defaultBranch} by @${session.user.login}: ${result.changed.length} file(s) reset`,
          );
          return send(res, 200, result satisfies SyncResult);
        }
        // the LIVE model content (application/content.ts): GET reads the same
        // Y.Text the rooms edit (+ a baseVersion token); PUT validates and
        // compare-and-sets it — a stale token gets 409 + the current content
        // instead of overwriting. ?path is the content-relative model path.
        if (repoRoute[2] === "content") {
          const path = url.searchParams.get("path") ?? "";
          if (!path) return send(res, 400, { error: "missing ?path=<content-relative model path>" });
          if (req.method === "GET") {
            return send(res, 200, (await getContent(opts, repo, path)) satisfies ContentWire);
          }
          if (req.method === "PUT") {
            // JSON-escape inflation of an at-cap document stays well under 2x + slack
            const body = await jsonBody<PutContentRequest>(req, res, opts.maxDocBytes * 2 + 65_536);
            if (body === undefined) return;
            const out = await putContent(opts, repo, path, body);
            if (!out.ok) return send(res, 409, out.conflict satisfies ContentConflictWire);
            console.log(`content saved: ${repo.fullName}/${out.result.path} by @${session.user.login}`);
            return send(res, 200, out.result satisfies PutContentResultWire);
          }
          return send(res, 405, { error: "method not allowed" });
        }
        // file history (read-models in application/history.ts) — ?path is the
        // content-relative model path, the same identifier the live rooms use
        if (repoRoute[2] === "history" || repoRoute[2] === "history/content") {
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          const path = url.searchParams.get("path") ?? "";
          if (!path) return send(res, 400, { error: "missing ?path=<content-relative model path>" });
          if (repoRoute[2] === "history") {
            const commits = await fileHistory(opts, repo, path, url.searchParams.get("limit"));
            return send(res, 200, commits satisfies FileCommitWire[]);
          }
          const file = await fileAtCommit(opts, repo, path, url.searchParams.get("sha") ?? "");
          return send(res, 200, file satisfies FileAtCommitWire);
        }
        if (repoRoute[2]?.startsWith("todos")) {
          // the tracker seam needs a platform credential (installation token) —
          // a credential-less local spike has no way to act on the repo's issues
          if (!opts.issues) {
            return send(res, 501, { error: "todo tracking is not configured (requires platform credentials)" });
          }
          // todos/:id/close — the close itself is bot-authored, the SESSION user is
          // attributed (same model as create); unknown ids surface as upstream errors
          // through the shared error path
          const todoId = repoRoute[3];
          if (todoId) {
            if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
            await closeTodoFor(opts.issues, session, repo, todoId, "rest");
            return send(res, 200, { ok: true });
          }
          if (req.method === "GET") {
            const todos = await opts.issues.listTodos(repo.fullName, url.searchParams.get("process") ?? undefined);
            return send(res, 200, todos satisfies TodoWire[]);
          }
          if (req.method === "POST") {
            const body = await jsonBody<CreateTodoBody>(req, res);
            if (body === undefined) return;
            // validation, server-side anchor resolution (unknown process = 404,
            // client file only kept when it names that process) and the audit
            // line live in the shared use-case
            const todo = await fileTodo(
              opts,
              opts.issues,
              session,
              repo,
              {
                title: body?.title,
                body: body?.body,
                process: typeof body?.anchor?.process === "string" ? body.anchor.process : undefined,
                file: typeof body?.anchor?.file === "string" ? body.anchor.file : undefined,
                elements: Array.isArray(body?.anchor?.elements) ? body.anchor.elements : [],
                processVersion: body?.anchor?.processVersion,
              },
              "rest",
            );
            return send(res, 201, todo satisfies TodoWire);
          }
          return send(res, 405, { error: "method not allowed" });
        }
        // the release dialog's selection pool: every content file differing from origin
        if (repoRoute[2] === "changes") {
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          const workspace = await opts.workspaces.ensure(repo);
          return send(res, 200, (await listChanges(opts, repo, workspace)) satisfies ChangedFileWire[]);
        }
        // file-selection release: ship exactly the picked changed files as one PR
        if (repoRoute[2] === "release" && req.method === "POST") {
          const provider = opts.github;
          const body = await jsonBody<ReleaseFilesBody>(req, res);
          if (body === undefined) return;
          if (!Array.isArray(body?.files) || body.files.some((f) => typeof f !== "string")) {
            return send(res, 400, { error: "files must be an array of repo-relative paths" });
          }
          if (body.title !== undefined && typeof body.title !== "string") {
            return send(res, 400, { error: "title must be a string" });
          }
          if (typeof body.title === "string" && body.title.length > 200) {
            return send(res, 400, { error: "title must be at most 200 characters" });
          }
          const result = await releaseFiles(opts, session, provider, repo, { files: body.files, title: body.title });
          console.log(`released ${repo.fullName} (${result.files.length} file(s)) by @${result.by} → ${result.pr}`);
          return send(res, 200, result satisfies ReleaseResult);
        }
        if (repoRoute[2]?.startsWith("release/") && req.method === "POST") {
          const provider = opts.github;
          // process ids come from file names — decode so any URL-safe encoding
          // works; a malformed %-escape is simply an unknown process, not a 500
          let id: string;
          try {
            id = decodeURIComponent(repoRoute[4] ?? "");
          } catch {
            return send(res, 404, { error: `unknown process: ${repoRoute[4]} (${repo.fullName})` });
          }
          const result = await release(opts, session, provider, repo, id);
          console.log(`released ${repo.fullName}#${id} by @${result.by} → ${result.pr}`);
          return send(res, 200, result satisfies ReleaseResult);
        }
        return send(res, 405, { error: "method not allowed" });
      }

      // MCP endpoint (http/mcp.ts): stateless Streamable HTTP on the official
      // SDK; tools call the application use-cases in-process with the caller's
      // session. Same auth surface as the REST API (session id, JWT, none-mode principal).
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST", "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Stateless server: POST JSON-RPC messages to this endpoint." },
              id: null,
            }),
          );
        }
        const session = await sessionOf(req);
        if (!session) return unauthorized(res, { error: "not logged in" }, url.pathname);
        return handleMcp(req, res, opts, session);
      }

      // never serve the SPA under /.well-known/* — OAuth clients probe these
      // paths and parse the body as JSON; a 200 HTML fallback crashes them,
      // while a clean 404 lets them conclude "no metadata here" and move on
      if (url.pathname.startsWith("/.well-known/")) return send(res, 404, { error: "not found" });
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(opts.webDist, url.pathname, res);
      return send(res, 405, { error: "method not allowed" });
    } catch (e) {
      // always log the full detail server-side; return it only to an authenticated
      // session (release conflicts etc. are actionable for the user), never to an
      // anonymous caller (fs paths / GitHub API bodies are operator information)
      const message = e instanceof Error ? e.message : String(e);
      console.log(`500 on ${req.method} ${url.pathname}: ${message.split("\n")[0]}`);
      // sessionOf can itself throw (an expired-cookie lookup DELETEs — a SQLite
      // write): on a full/readonly disk the 500 path must degrade to anonymous,
      // not double-fault into an unhandled rejection that kills the process.
      let authed = false;
      try {
        authed = Boolean(await sessionOf(req));
      } catch {
        /* degraded storage or a failing JWT re-verify — treat as anonymous */
      }
      // typed AppErrors (release gates: 409/422/404; JWT verify: 401) carry
      // their own status + machine code; plain Errors map to the 500 body.
      // 401s additionally carry the OIDC discovery challenge (RFC 9728).
      const { status, body } = errorBody(e, { authenticated: authed });
      return send(res, status, body, status === 401 ? challenge(url.pathname) : {});
    }
  });
  httpServer.listen(port, () => {
    console.log(
      `api + web + ws : http://localhost:${port}  (auth: ${opts.local ? `none — every request is @${opts.local.user.login}` : opts.oidcLogin ? "oidc" : "bearer only"})`,
    );
  });
  return httpServer;
}
