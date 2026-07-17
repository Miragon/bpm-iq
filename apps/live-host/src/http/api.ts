/**
 * The Live Host's HTTP side (companion to the Hocuspocus ws server).
 *
 * Access model (docs/multi-repo-architecture.md): LOGIN AUTHENTICATES,
 * REPOS AUTHORIZE. The OAuth grant only establishes who you are; whether you
 * may see/edit/release a repository is decided per (user, repo) against the
 * provider — the connected-repo set derives from the GitHub App's
 * installations (RepoRegistry).
 *
 *   GET  /api/config                             → providers + app install URL
 *   GET  /auth/:provider(/callback)              → OAuth login (authentication only)
 *   GET  /api/me, POST /api/logout
 *   GET  /api/repos                              → repo OVERVIEW (per-user permission)
 *   GET  /api/repos/:owner/:repo/processes       → process list      (repo write required)
 *   POST /api/repos/:owner/:repo/processes       → create a process from the blank template (repo write required)
 *   GET  /api/repos/:owner/:repo/decisions       → decision (.dmn) list (repo write required)
 *   POST /api/repos/:owner/:repo/decisions       → create a decision from the blank template (repo write required)
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
 *   POST /webhook/github                         → installation lifecycle (HMAC-verified)
 *   GET  /setup/installed                        → post-install sync + redirect
 *   GET  /healthz, /*                            → liveness, built web app (public)
 *
 * Releases push with the USER's token and open the PR in their name — merge
 * rights stay at the provider (CODEOWNERS/branch protection).
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

import type {
  AppConfig,
  ChangedFileWire,
  CreateDecisionBody,
  CreateFolderBody,
  CreateProcessBody,
  CreateTodoBody,
  DecisionInfo,
  FileAtCommitWire,
  FileCommitWire,
  FolderListWire,
  FolderWire,
  Me,
  ProcessInfo,
  ReleaseFilesBody,
  ReleaseResult,
  SyncResult,
  TodoWire,
} from "@bpmiq/contracts/live-host";
import { bearerAuth, errorBody, readBody, redirect, securityHeaders, send } from "@bpmiq/http-kit";

import {
  clearCookie,
  clearOauthCookie,
  COOKIE,
  OAUTH_COOKIE,
  oauthCookie,
  readCookie,
  type Session,
  sessionCookie,
  type SessionStore,
} from "../adapters/sqlite/sessions.ts";
import { fileAtCommit, fileHistory } from "../application/history.ts";
import { listChanges, listDecisions, listProcesses, listRepos } from "../application/overview.ts";
import { createDecision, createFolder, createProcess, listFolders } from "../application/scaffold.ts";
import { syncRepo } from "../application/sync.ts";
import type { RepoConnectionSource } from "../ports/connection-source.ts";
import type { GitProvider } from "../ports/git-provider.ts";
import type { IssueTracker } from "../ports/issue-tracker.ts";
import { release, releaseFiles } from "../release.ts";
import type { AccessCache } from "../repos/access.ts";
import type { ConnectedRepo, RepoRegistry } from "../repos/registry.ts";
import type { WorkspaceManager } from "../repos/workspaces.ts";

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
  providers: Map<string, GitProvider>;
  /** REST backend for per-repo access checks + releases (works without login buttons) */
  github: GitProvider;
  sessions: SessionStore;
  registry: RepoRegistry;
  workspaces: WorkspaceManager;
  access: AccessCache;
  /** optional shared token for headless clients (tests, VS Code) — off if unset */
  devToken?: () => string | undefined;
  devUser?: string;
  /** repo-qualified document names of live rooms */
  liveDocs: () => string[];
  /** invalidate a room's Yjs lineage — sync-to-default drops the reset files' lineage */
  dropLineage: (room: string) => void;
  /** provider seam for the connected-repo set: connect URL + webhook verification */
  connectionSource?: RepoConnectionSource;
  /** issue-tracker seam (model-anchored todos) — absent when the platform has
   * no credentials to act on the tracker (the /todos routes then answer 501) */
  issues?: IssueTracker;
  /** cell mode (ADR 0002): shared secret to verify control-plane handoff logins */
  handoffSecret?: string;
  /** control-plane origin (derived from TOKEN_MINT_URL) — for the handoff CSRF
   * Origin check and for redirecting a failed handoff back to a fresh /workspaces */
  controlPlaneUrl?: string;
  /** deep liveness (ADR 0002): SQLite writable + disk free — 503 when degraded */
  deepHealth?: () => Promise<{ ok: boolean; checks: Record<string, unknown> }>;
  /** cell mode: secret unlocking the /healthz DETAIL (the control-plane fleet poll
   * presents it). Unset (standalone) → detail is public (single-tenant box). */
  healthAuth?: string;
}

// send/redirect/readBody/securityHeaders/bearerAuth come from @bpmiq/http-kit —
// the shared, unit-tested primitives (one canonical impl for both backends).
// NB send() now emits compact JSON (was pretty-printed here); the e2e greps are
// whitespace-tolerant (`"key": *"value"`), verified before the switch.
// listProcesses/listRepos (the overview read-models) live in application/overview.ts —
// ApiOptions structurally satisfies their injected OverviewDeps surface.

/** parse a JSON request body; sends the 400 itself and returns undefined */
async function jsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    return JSON.parse((await readBody(req)).toString()) as T;
  } catch {
    send(res, 400, { error: "invalid JSON body" });
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

export function startApi(port: number, opts: ApiOptions): Server {
  const secure = opts.publicUrl.startsWith("https");

  const sessionOf = (req: IncomingMessage): Session | undefined => {
    const sid = readCookie(req.headers.cookie, COOKIE);
    const fromCookie = opts.sessions.get(sid);
    if (fromCookie) return fromCookie;
    // headless clients: Authorization: Bearer <session-id or dev token>
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const devToken = opts.devToken?.();
    if (bearer && devToken && bearer === devToken) {
      return {
        id: "dev",
        user: {
          login: opts.devUser ?? "dev-token",
          name: opts.devUser ?? "dev-token",
          avatarUrl: null,
          provider: "dev",
        },
        providerToken: "",
        createdAt: Date.now(),
      };
    }
    return opts.sessions.get(bearer);
  };

  /** resolve + authorize a repo route segment; sends the error response itself */
  const repoOf = async (
    res: ServerResponse,
    session: Session,
    fullName: string,
  ): Promise<ConnectedRepo | undefined> => {
    const repo = opts.registry.get(fullName);
    if (!repo) {
      send(res, 404, { error: `not a connected repository: ${fullName}` });
      return undefined;
    }
    if (session.id !== "dev" && !(await opts.access.canWrite(session, repo))) {
      send(res, 403, { error: `@${session.user.login}: no write access to ${repo.fullName}` });
      return undefined;
    }
    return repo;
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", opts.publicUrl);
    try {
      // baseline security headers on EVERY response (API, redirects, static web app)
      securityHeaders(res, { secure });
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

      // ── cell handoff login (ADR 0002): the control plane authenticated the
      // user and signed a short-lived token; the cell mints a LOCAL session from
      // it. No GitHub OAuth callback in a cell, no user token stored — identity
      // only; authorization runs app-side (installation token). Must precede the
      // /auth/:provider matcher, which would otherwise swallow /auth/handoff.
      if (url.pathname === "/auth/handoff" && opts.handoffSecret) {
        // CSRF defense-in-depth: an attacker's auto-submitting form on a concrete
        // OTHER web origin (which could log a victim into the attacker's identity)
        // is refused. The handoff TOKEN is the primary defense — single-use (jti),
        // HMAC-signed with the per-cell secret, 300 s TTL, POST-body-delivered.
        //
        // NB the chooser (control plane) and this cell live on distinct *.fly.dev
        // subdomains, and *.fly.dev is on the Public Suffix List → the legit
        // handoff is inherently CROSS-SITE. For cross-site top-level form POSTs
        // several browsers (Safari, sometimes Chrome) send `Origin: null` for
        // privacy — so `null` must be treated as "no trustworthy origin" (like a
        // missing Origin from curl/legacy GET), NOT as a cross-origin attack, or
        // real logins 403. Only a present, concrete, DIFFERENT origin is blocked.
        const origin = req.headers.origin;
        const hasConcreteOrigin = typeof origin === "string" && origin !== "null";
        if (req.method === "POST" && hasConcreteOrigin && opts.controlPlaneUrl && origin !== opts.controlPlaneUrl) {
          return send(res, 403, { error: "cross-origin handoff refused" });
        }
        // a failed handoff should return the user to a FRESH chooser, not a raw
        // JSON 400 (long-lived /workspaces tabs carry tokens that expire after 5m)
        const backToChooser = () =>
          opts.controlPlaneUrl
            ? redirect(res, `${opts.controlPlaneUrl}/workspaces`)
            : send(res, 400, { error: "invalid or expired handoff token" });
        // token arrives in the POST body (out of the URL — no log/Referer/history
        // leak) or a legacy ?token=
        let token = url.searchParams.get("token");
        if (req.method === "POST") token = new URLSearchParams((await readBody(req)).toString()).get("token") ?? token;
        const user = opts.sessions.verifyHandoff(token, opts.handoffSecret);
        const existing = opts.sessions.get(readCookie(req.headers.cookie, COOKIE));
        if (!user) {
          // invalid/expired token: already signed in (browser back) → just enter;
          // otherwise send them back for a freshly-signed handoff
          return existing ? redirect(res, "/") : backToChooser();
        }
        // valid token for the SAME user already signed in → idempotent enter. A
        // DIFFERENT login must NOT be ignored (account switch at the control plane)
        // — fall through and mint a fresh session for the new identity.
        if (existing && existing.user.login === user.login) return redirect(res, "/");
        // single-use: a replayed (already-consumed) token can't mint a new session
        if (user.jti && !opts.sessions.consumeHandoff(user.jti, user.handoffExp * 1000)) {
          return existing ? redirect(res, "/") : backToChooser();
        }
        const { jti, handoffExp, ...identity } = user;
        const session = opts.sessions.create(identity); // no grant — zero stored user token
        console.log(`handoff login: @${identity.login}`);
        return redirect(res, "/", { "set-cookie": sessionCookie(session.id, secure) });
      }

      // ── OAuth: LOGIN = AUTHENTICATION ONLY (repos authorize per request) ─
      const authStart = url.pathname.match(/^\/auth\/([a-z]+)$/);
      if (authStart) {
        const provider = opts.providers.get(authStart[1] ?? "");
        if (!provider) return send(res, 404, { error: `provider '${authStart[1]}' not configured` });
        const redirectUri = `${opts.publicUrl}/auth/${provider.id}/callback`;
        // bind the flow to THIS browser: the nonce rides in both the signed state and
        // a short-lived cookie; the callback requires both (login-CSRF / fixation fix)
        const { state, nonce } = opts.sessions.issueState(provider.id);
        return redirect(res, provider.authorizeUrl(redirectUri, state), { "set-cookie": oauthCookie(nonce, secure) });
      }
      const authCb = url.pathname.match(/^\/auth\/([a-z]+)\/callback$/);
      if (authCb) {
        const provider = opts.providers.get(authCb[1] ?? "");
        if (!provider) return send(res, 404, { error: "provider not configured" });
        // Two legitimate entries: (a) our own login redirect, carrying our HMAC
        // state; (b) GitHub-initiated authorization straight after app install
        // (request_oauth_on_install) — no state from us, identified by GitHub's
        // setup parameters. Everything else is rejected.
        const installInitiated = url.searchParams.has("installation_id") || url.searchParams.has("setup_action");
        if (
          !installInitiated &&
          !opts.sessions.verifyState(
            url.searchParams.get("state"),
            provider.id,
            readCookie(req.headers.cookie, OAUTH_COOKIE),
          )
        ) {
          return send(res, 400, { error: "invalid OAuth state" }, { "set-cookie": clearOauthCookie(secure) });
        }
        if (installInitiated) {
          // GitHub-initiated post-install callback carries NO browser-bound state, so
          // we must NOT mint a session from its code — that is a login-CSRF surface
          // (anyone can craft ?setup_action=install&code=<their own>&installation_id=
          // <a known id>). Sync the new install so its repos appear, verify it exists
          // for OUR app, then bounce to a FRESH, browser-bound login (the install-time
          // code is never exchanged). Mirrors the control-plane's setup_action handling.
          await opts.registry
            .requestSync(true)
            .catch((e) => console.log(`post-install sync failed: ${(e as Error).message}`));
          const instId = Number(url.searchParams.get("installation_id"));
          const known = opts.registry.list().some((r) => r.installationId === instId);
          if (opts.registry.appConfigured && !known) {
            return send(res, 400, { error: "unknown installation" });
          }
          opts.access.invalidate();
          return redirect(res, `/auth/${provider.id}`);
        }
        // only the state-verified (browser-bound) path reaches here
        const code = url.searchParams.get("code");
        if (!code) return send(res, 400, { error: "missing code" }, { "set-cookie": clearOauthCookie(secure) });
        const grant = await provider.exchangeCode(code, `${opts.publicUrl}/auth/${provider.id}/callback`);
        const user = await provider.fetchUser(grant.accessToken);
        const session = opts.sessions.create(user, grant);
        console.log(`login: @${user.login} via ${provider.id}`);
        // single-use: drop the OAuth binding cookie once the login completes
        return redirect(res, "/", { "set-cookie": [sessionCookie(session.id, secure), clearOauthCookie(secure)] });
      }

      // ── session-facing API ───────────────────────────────────────────
      if (url.pathname === "/api/config") {
        return send(res, 200, {
          providers: [...opts.providers.values()].map((p) => ({ id: p.id, label: p.label })),
          installUrl: opts.connectionSource?.connectUrl() ?? null,
        } satisfies AppConfig);
      }
      if (url.pathname === "/api/me") {
        const session = sessionOf(req);
        if (!session) return send(res, 401, { error: "not logged in" });
        return send(res, 200, { user: session.user, wsToken: session.id } satisfies Me);
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        const sid = readCookie(req.headers.cookie, COOKIE);
        if (sid) opts.sessions.delete(sid);
        return send(res, 200, { ok: true }, { "set-cookie": clearCookie() });
      }

      // repo OVERVIEW
      if (url.pathname === "/api/repos") {
        const session = sessionOf(req);
        if (!session) return send(res, 401, { error: "not logged in" });
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
      const repoRoute = url.pathname.match(
        /^\/api\/repos\/(.+)\/(processes|decisions|folders|changes|sync|history(?:\/content)?|todos(?:\/([0-9A-Za-z-]+)\/close)?|release(?:\/([^/]+))?)$/,
      );
      if (repoRoute) {
        const session = sessionOf(req);
        if (!session) return send(res, 401, { error: "not logged in" });
        const repo = await repoOf(res, session, repoRoute[1] ?? "");
        if (!repo) return;
        if (repoRoute[2] === "processes") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = await jsonBody<CreateProcessBody>(req, res);
            if (body === undefined) return;
            if (typeof body?.name !== "string" || body.name.trim().length === 0) {
              return send(res, 400, { error: "name must be a non-empty string" });
            }
            if (body.folder !== undefined && typeof body.folder !== "string") {
              return send(res, 400, { error: "folder must be a string" });
            }
            const created = await createProcess(repo, workspace, { name: body.name, folder: body.folder });
            console.log(`process created in ${repo.fullName} by @${session.user.login}: ${created.bpmn}`);
            return send(res, 201, created satisfies ProcessInfo);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await listProcesses(opts, repo, workspace));
        }
        if (repoRoute[2] === "decisions") {
          const workspace = await opts.workspaces.ensure(repo);
          if (req.method === "POST") {
            const body = await jsonBody<CreateDecisionBody>(req, res);
            if (body === undefined) return;
            if (typeof body?.name !== "string" || body.name.trim().length === 0) {
              return send(res, 400, { error: "name must be a non-empty string" });
            }
            if (body.folder !== undefined && typeof body.folder !== "string") {
              return send(res, 400, { error: "folder must be a string" });
            }
            const created = await createDecision(repo, workspace, { name: body.name, folder: body.folder });
            console.log(`decision created in ${repo.fullName} by @${session.user.login}: ${created.path}`);
            return send(res, 201, created satisfies DecisionInfo);
          }
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await listDecisions(opts, repo, workspace));
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
            await opts.issues.closeTodo(repo.fullName, todoId, session.user.login);
            console.log(`todo closed in ${repo.fullName} by @${session.user.login}: #${todoId}`);
            return send(res, 200, { ok: true });
          }
          if (req.method === "GET") {
            const todos = await opts.issues.listTodos(repo.fullName, url.searchParams.get("process") ?? undefined);
            return send(res, 200, todos satisfies TodoWire[]);
          }
          if (req.method === "POST") {
            const body = await jsonBody<CreateTodoBody>(req, res);
            if (body === undefined) return;
            if (typeof body?.title !== "string" || body.title.trim().length === 0) {
              return send(res, 400, { error: "title must be a non-empty string" });
            }
            if (typeof body?.anchor?.process !== "string" || body.anchor.process.trim().length === 0) {
              return send(res, 400, { error: "anchor.process must be a non-empty string" });
            }
            const todo = await opts.issues.createTodo(repo.fullName, {
              title: body.title.trim(),
              body: typeof body.body === "string" ? body.body : "",
              anchor: {
                process: body.anchor.process.trim(),
                file: typeof body.anchor.file === "string" ? body.anchor.file : null,
                elements: (Array.isArray(body.anchor.elements) ? body.anchor.elements : [])
                  .filter((el) => typeof el?.id === "string" && el.id.length > 0)
                  .map((el) => ({ id: el.id, name: typeof el.name === "string" ? el.name : null })),
                processVersion: typeof body.anchor.processVersion === "string" ? body.anchor.processVersion : null,
              },
              // attribution: the platform login of the SESSION is authoritative,
              // never a client-supplied author field
              author: session.user.login,
            });
            console.log(`todo created in ${repo.fullName} by @${session.user.login}: #${todo.id} "${todo.title}"`);
            return send(res, 201, todo satisfies TodoWire);
          }
          return send(res, 405, { error: "method not allowed" });
        }
        // the release dialog's selection pool: every file differing from origin
        if (repoRoute[2] === "changes") {
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          await opts.workspaces.ensure(repo);
          return send(res, 200, (await listChanges(opts, repo)) satisfies ChangedFileWire[]);
        }
        // file-selection release: ship exactly the picked changed files as one PR
        if (repoRoute[2] === "release" && req.method === "POST") {
          const provider = opts.providers.get(session.user.provider) ?? opts.github;
          const body = await jsonBody<ReleaseFilesBody>(req, res);
          if (body === undefined) return;
          if (!Array.isArray(body?.files) || body.files.some((f) => typeof f !== "string")) {
            return send(res, 400, { error: "files must be an array of repo-relative paths" });
          }
          if (body.title !== undefined && typeof body.title !== "string") {
            return send(res, 400, { error: "title must be a string" });
          }
          const result = await releaseFiles(opts, session, provider, repo, { files: body.files, title: body.title });
          console.log(`released ${repo.fullName} (${result.files.length} file(s)) by @${result.by} → ${result.pr}`);
          return send(res, 200, result satisfies ReleaseResult);
        }
        if (repoRoute[2]?.startsWith("release/") && req.method === "POST") {
          const provider = opts.providers.get(session.user.provider) ?? opts.github;
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
        authed = Boolean(sessionOf(req));
      } catch {
        /* degraded storage — treat as anonymous */
      }
      // typed AppErrors (release gates: 409/422/404) carry their own status +
      // machine code; plain Errors map to exactly the previous 500 body.
      const { status, body } = errorBody(e, { authenticated: authed });
      return send(res, status, body);
    }
  });
  httpServer.listen(port, () => {
    console.log(
      `api + web + ws : http://localhost:${port}  (providers: ${[...opts.providers.keys()].join(", ") || "none — set GITHUB_CLIENT_ID/SECRET"})`,
    );
  });
  return httpServer;
}
