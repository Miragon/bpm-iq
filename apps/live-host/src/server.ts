/**
 * The Live Host — sync server + workspace service in ONE process
 * (docs/platform-concept.md rev 2; multi-repo: docs/multi-repo-architecture.md).
 *
 * MULTI-REPO MODEL: one instance serves many connected repositories. The
 * connected set derives from the central GitHub App's installations
 * (RepoRegistry); each repo gets its own workspace checkout
 * (WorkspaceManager — the host's own repo keeps using this checkout).
 *
 * Room name = "<owner>/<repo>/<repo-relative-path>", Y.Text field 'content':
 *
 *   onAuthenticate   → session (from OAuth login) + PER-REPO write permission
 *                      for the room being joined (AccessCache)
 *   onLoadDocument   → restore Yjs lineage from SQLite, else seed from the
 *                      repo's workspace tree
 *   onStoreDocument  → persist lineage + debounced write-through to the tree
 *
 * Run:  pnpm live-host   (HTTP + WebSocket on ONE port, http://localhost:8301)
 */
import { existsSync, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { loadPrivateKey } from "@bpmiq/github-app";
import { Server } from "@hocuspocus/server";

import type { AppCredentials } from "./adapters/github/app-auth.ts";
import { createGitHubAppSource } from "./adapters/github/app-source.ts";
import { createGitHubIssueTracker } from "./adapters/github/issues.ts";
import { createGitHubProvider } from "./adapters/github/provider.ts";
import { LineageStore } from "./adapters/sqlite/lineage-store.ts";
import { SessionStore } from "./adapters/sqlite/sessions.ts";
import { makeCollabHooks } from "./application/collab.ts";
import { ConnectionLimiter } from "./domain/conn-limit.ts";
import { DocSizeGuard } from "./domain/doc-size-guard.ts";
import { startApi } from "./http/api.ts";
import type { GitProvider } from "./ports/git-provider.ts";
import { AccessCache } from "./repos/access.ts";
import { RepoRegistry } from "./repos/registry.ts";
import { localMintFn, remoteMintFn, TokenService } from "./repos/token-minter.ts";
import { WorkspaceManager } from "./repos/workspaces.ts";

// vendor app credentials from apps/live-host/.env (written by `pnpm create-app`)
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// ONE port for HTTP + WebSocket (Fly maps 443 → this internal port)
const PORT = Number(process.env.PORT ?? 8301);
const PUBLIC_URL = process.env.LIVE_PUBLIC_URL ?? `http://localhost:${PORT}`;
/** the content repo served in place for local dev (registry fallback) */
const HOST_REPO = process.env.GITHUB_REPO ?? "Miragon/bpm-iq";
/** the bpmiq monorepo root: apps/live-host/src → ../../.. */
const MONO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** local host content (the process-documentation example) served without a clone */
const HOST_CONTENT = process.env.LIVE_HOST_CONTENT_DIR ?? resolve(MONO_ROOT, "process-documentation");
/** platform validator (packages/validator) — runs against any checkout, never content-repo code */
const VALIDATOR_SCRIPT = resolve(MONO_ROOT, "packages", "validator", "src", "validate.ts");
const VALIDATOR_DIR = resolve(MONO_ROOT, "packages", "validator");
/** built web app served on the same port */
const WEB_DIST = resolve(MONO_ROOT, "apps", "web", "dist");
/** host-owned state (Yjs lineages, sessions, registry, workspace clones) */
const DATA_DIR = process.env.LIVE_DATA_DIR ?? join(MONO_ROOT, ".live");
const GH_BASE = process.env.GITHUB_BASE_URL ?? "https://github.com";
const GH_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const liveDocs = new Set<string>();
// cap the size of a single room (DoS guard), enforced twice: at INGEST (an update
// that would push the doc past the cap is rejected in beforeHandleMessage — bounds
// in-memory growth, a CRDT can't be shrunk after the fact) and at PERSIST (an
// oversized doc is never written to SQLite or the workspace file). Env-overridable.
const MAX_DOC_BYTES = Number(process.env.LIVE_MAX_DOC_BYTES ?? 8_000_000);
const docGuard = new DocSizeGuard(MAX_DOC_BYTES);

// Yjs persistence: the SAME document lineage must survive restarts, otherwise
// reconnecting clients merge their old history into a freshly seeded doc and
// every character duplicates (observed live — see apps/live-host/README.md).
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "live.db"));
const lineage = new LineageStore(db, HOST_REPO);

// deep liveness (ADR 0002): a cell that cannot persist edits must fail its Fly
// health check, not stay "ok". Checks SQLite writability and disk headroom.
db.exec("CREATE TABLE IF NOT EXISTS health (k INTEGER PRIMARY KEY, at INTEGER)");
const healthWrite = db.prepare(
  "INSERT INTO health (k, at) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at",
);
async function deepHealth(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  const checks: Record<string, unknown> = {
    tenant: process.env.TENANT_INSTALLATION_ID ?? null,
    liveDocs: liveDocs.size,
  };
  let ok = true;
  try {
    healthWrite.run(Date.now());
    checks.sqlite = "ok";
  } catch (e) {
    ok = false;
    checks.sqlite = (e as Error).message.split("\n")[0];
  }
  try {
    const s = await statfs(DATA_DIR);
    const freeRatio = s.blocks > 0n ? Number(s.bavail) / Number(s.blocks) : 1;
    checks.diskFreeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e6);
    checks.diskUsedPct = Math.round((1 - freeRatio) * 100);
    if (freeRatio < 0.05) {
      ok = false;
      checks.disk = "critically low";
    } // <5% free
  } catch (e) {
    checks.disk = (e as Error).message.split("\n")[0];
  }
  return { ok, checks };
}

// ── Authentication: login authenticates, repos authorize ────────────────────
// encrypt persisted provider tokens at rest with a key from ENV (Fly secret, off the
// data volume) so a leaked live.db yields no usable GitHub credential. Prefer an
// explicit SESSION_ENC_KEY; else reuse a persistent env secret (the cipher sha256-
// derives its key). Cell mode stores no user token, so this only matters standalone.
const SESSION_ENC_KEY = process.env.SESSION_ENC_KEY ?? process.env.CELL_TOKEN_KEY ?? process.env.GITHUB_CLIENT_SECRET;
const sessions = new SessionStore(db, SESSION_ENC_KEY);
const appSlug = process.env.GITHUB_APP_SLUG;

// server-as-app credentials (installation enumeration = the repo overview). The
// private key comes from the shared loader (@bpmiq/github-app): raw PEM env,
// _FILE path, _B64 one-liner, else the first *.pem dropped into apps/live-host/
// (that dir is gitignored for .pem, so a downloaded key just works). undefined in
// cell mode (no key — tokens are minted remotely by the control plane).
const appPrivateKey = loadPrivateKey(process.env, { pemDir: dirname(ENV_FILE), log: (m) => console.log(m) });
const appCreds: AppCredentials | undefined =
  process.env.GITHUB_APP_ID && appPrivateKey
    ? {
        appId: process.env.GITHUB_APP_ID,
        privateKey: appPrivateKey,
        apiUrl: GH_API.replace(/\/$/, ""),
      }
    : undefined;

// SaaS cell mode (ADR 0002): TENANT_INSTALLATION_ID restricts this instance to
// one org's installation. Unset = today's behavior (serve every installation).
const TENANT_INSTALLATION_ID = process.env.TENANT_INSTALLATION_ID
  ? Number(process.env.TENANT_INSTALLATION_ID)
  : undefined;
if (process.env.TENANT_INSTALLATION_ID && !Number.isInteger(TENANT_INSTALLATION_ID)) {
  throw new Error(`TENANT_INSTALLATION_ID must be an integer, got '${process.env.TENANT_INSTALLATION_ID}'`);
}

// Installation-token minting (ADR 0002): REMOTE via the control plane (the app
// key never lives in a cell) when TOKEN_MINT_URL + CELL_SECRET are set; else
// LOCAL with the app key. Persisted to SQLite for degraded-mode survival.
const MINT_URL = process.env.TOKEN_MINT_URL;
const CELL_SECRET = process.env.CELL_SECRET;
const tokenMintFn =
  MINT_URL && CELL_SECRET ? remoteMintFn(MINT_URL, CELL_SECRET) : appCreds ? localMintFn(appCreds) : undefined;
const tokens = tokenMintFn
  ? new TokenService(tokenMintFn, { db, encryptionKey: process.env.CELL_TOKEN_KEY ?? CELL_SECRET, proactive: true })
  : undefined;
if (MINT_URL && !CELL_SECRET) throw new Error("TOKEN_MINT_URL set but CELL_SECRET missing");
if (MINT_URL && TENANT_INSTALLATION_ID === undefined) {
  throw new Error("remote token minting requires TENANT_INSTALLATION_ID (a cell serves one tenant)");
}

// PLATFORM-credentialed provider seam: where connected repos come from.
// GitHub = App installations; a GitLab source will be an OAuth application +
// explicit project selection behind the same interface.
const connectionSource = tokens
  ? createGitHubAppSource({
      apiUrl: GH_API,
      tokens,
      // app-JWT creds only in LOCAL mode; a remote-minting cell holds no key
      creds: MINT_URL ? undefined : appCreds,
      appSlug,
      // LOCAL: verify GitHub webhooks with the App secret. REMOTE cell: the
      // control plane forwards events re-signed with the cell's own secret, so
      // verify with CELL_SECRET (the cell never learns the App webhook secret).
      webhookSecret: MINT_URL ? CELL_SECRET : process.env.GITHUB_WEBHOOK_SECRET,
      baseUrl: GH_BASE,
      tenantInstallationId: TENANT_INSTALLATION_ID,
    })
  : undefined;
// the static fallback repo (GITHUB_REPO) is a single-tenant/local-dev convenience;
// in a cell the connected set is defined solely by the tenant's installation
const registry = new RepoRegistry(db, connectionSource, TENANT_INSTALLATION_ID ? undefined : HOST_REPO);
const workspaces = new WorkspaceManager({
  dataDir: DATA_DIR,
  hostRepo: HOST_REPO,
  hostRoot: HOST_CONTENT,
  registry,
  githubBaseUrl: GH_BASE,
});
// reconcile safety: never fast-forward under live sessions; after a fast-forward,
// drop the Yjs lineage of changed files so the next open reseeds from the new tree
workspaces.hooks = {
  hasLiveDocs: (repo) => [...liveDocs].some((d) => d.startsWith(`${repo.fullName}/`)),
  onReconciled: (repo, changedPaths) => {
    for (const path of changedPaths) {
      lineage.drop(`${repo.fullName}/${path}`);
    }
    console.log(`lineages invalidated for ${repo.fullName}: ${changedPaths.join(", ")}`);
  },
};

// Issue-tracker seam (model-anchored todos): GitHub Issues, acting with the SAME
// per-repo installation-token path the connection source uses (bot-authored,
// human attributed — ADR 0001). Constructed iff the platform can mint tokens
// (same condition family as connectionSource); tokenFor composes registry →
// TokenService HERE, so the adapter never reads env and stays swappable.
const issues = tokens
  ? createGitHubIssueTracker({
      apiUrl: GH_API,
      tokenFor: async (repoFullName) => {
        const installationId = registry.get(repoFullName)?.installationId;
        if (installationId == null) {
          throw new Error(`no app installation for ${repoFullName} — cannot act on its issue tracker`);
        }
        return tokens.mint(installationId);
      },
    })
  : undefined;

// REST backend — constructed even without login credentials (access checks +
// releases only need tokens passed per call); login buttons need client creds
const github = createGitHubProvider({
  clientId: process.env.GITHUB_CLIENT_ID ?? "",
  clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  baseUrl: GH_BASE,
  apiUrl: GH_API,
  appMode: Boolean(appSlug),
});
// authz prefers the app-side installation-token check (ADR 0001, no user token);
// falls back to the user-token GitProvider path for sources that can't answer
const access = new AccessCache(github, sessions, connectionSource);
const providers = new Map<string, GitProvider>();
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.set("github", github);
}

// Headless clients (tests, VS Code extension — until it gets its own OAuth
// flow). The dev token bypasses per-repo authorization (all-repos god access),
// so the convenience "demo" default is ONLY for the bare local spike: no login
// AND no app credentials. The moment app credentials populate the registry with
// real (private) repos, the default is off — it must be opted into explicitly
// (adversarial review, critical: app-configured-but-OAuth-pending must not
// silently expose every connected private repo).
const devToken = (): string | undefined =>
  process.env.LIVE_DEV_TOKEN ?? (providers.size === 0 && !connectionSource?.canEnumerate ? "demo" : undefined);

// rooms ("<repo-full-name>/<path>") → repo + on-disk path: splitRoom / toDiskPath
// live in ./repos/rooms.ts (pure + unit-tested). They take the registry/workspace
// singletons as arguments so they stay testable without booting the server.

const server = new Server({
  // no `port`: Hocuspocus does NOT open its own listener — we attach its
  // WebSocket upgrade to the single HTTP server below (one port for HTTP + ws,
  // so everything rides Fly's TLS on 443; see docs/multi-repo-architecture.md).
  ...makeCollabHooks({
    lineage,
    docGuard,
    maxDocBytes: MAX_DOC_BYTES,
    sessions,
    access,
    registry,
    workspaces,
    devToken,
    liveDocs,
  }),
});

const httpServer = startApi(PORT, {
  validatorScript: VALIDATOR_SCRIPT,
  validatorDir: VALIDATOR_DIR,
  webDist: WEB_DIST,
  publicUrl: PUBLIC_URL,
  providers,
  github,
  sessions,
  registry,
  workspaces,
  access,
  devToken,
  liveDocs: () => [...liveDocs],
  connectionSource,
  issues,
  handoffSecret: process.env.HANDOFF_SECRET,
  // control-plane origin (from the mint URL) — handoff CSRF check + failure redirect
  controlPlaneUrl: MINT_URL ? new URL(MINT_URL).origin : undefined,
  deepHealth,
  // cell mode: gate the /healthz DETAIL behind the cell secret (the control-plane
  // fleet poll presents it). Deliberate reuse of CELL_SECRET (not a dedicated health
  // key): it lets EXISTING cells gate on the next image-upgrade with no new env/
  // re-provision, and exposure is bounded — idle cells aren't polled and active ones
  // already transmit CELL_SECRET; a dedicated derive(masterKey,"health",id) is the
  // least-privilege follow-up when re-provisioning the fleet is on the table.
  // Unset/empty in standalone → detail stays public (single-tenant box, nothing to gate).
  healthAuth: CELL_SECRET,
});

// WebSocket connection ceiling (DoS guard): the upgrade path was uncapped, so an
// anon flood could exhaust the small cell's fds/memory. Global + per-IP caps; behind
// Fly the real client is Fly-Client-IP, not the proxy socket. Overridable via env.
const wsLimit = new ConnectionLimiter(
  Number(process.env.LIVE_MAX_WS ?? 400),
  Number(process.env.LIVE_MAX_WS_PER_IP ?? 40),
);

// one port for everything: route WebSocket upgrades into Hocuspocus, so ws
// shares the API's HTTP server (behind the TLS-terminating proxy: one endpoint on 443)
httpServer.on("upgrade", (request, socket, head) => {
  // Fly-Client-IP is set by Fly's edge proxy (the app is reachable only through it);
  // self-hosted reverse proxies should set the header too (docs/on-prem), else the
  // socket address makes everyone behind one proxy share a bucket. The GLOBAL cap is
  // the backstop if that assumption ever breaks; a shared-NAT office shares one bucket.
  const ip = (request.headers["fly-client-ip"] as string | undefined) ?? request.socket.remoteAddress ?? "unknown";
  if (!wsLimit.tryAcquire(ip)) {
    console.log(`ws upgrade refused: at connection cap (active ${wsLimit.active}, ip ${ip})`);
    socket.destroy();
    return;
  }
  socket.once("close", () => wsLimit.release(ip));
  (
    server as unknown as { crossws: { handleUpgrade: (r: unknown, s: unknown, h: unknown) => void } }
  ).crossws.handleUpgrade(request, socket, head);
});

// graceful shutdown: the platform sends SIGINT/SIGTERM on every deploy/stop
// (Fly, docker stop, compose down) — flush the debounced write-throughs (up to
// 10s of edits) instead of tearing them off mid-flight. Server.listen() is never
// called here, so Hocuspocus' own signal handling is inactive; we own the lifecycle.
//
// The hard-exit MUST stay below the deployment's kill timeout (Fly kill_timeout /
// compose stop_grace_period — 30s in both references) so we exit cleanly rather
// than being SIGKILLed mid-flush. A host with many open docs does one SQLite
// write + one file write per doc, so give it real room.
const SHUTDOWN_HARD_EXIT_MS = Number(process.env.LIVE_SHUTDOWN_MS ?? 25_000);
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} — flushing live documents, closing sockets`);
    const startedAt = Date.now();
    const hardExit = setTimeout(() => {
      console.log(`shutdown: hard exit after ${SHUTDOWN_HARD_EXIT_MS}ms — flush may be incomplete`);
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
    hardExit.unref();
    void server
      .destroy()
      .then(() => console.log(`flush complete: live documents persisted in ${Date.now() - startedAt}ms`))
      .catch((e) => console.log(`shutdown flush failed: ${(e as Error).message}`))
      .finally(() => httpServer.close(() => process.exit(0)));
  });
}

void (async () => {
  // seed the registry from the connection source (local app key OR remote mint)
  if (connectionSource?.canEnumerate) {
    await registry.sync().catch((e) => console.log(`registry sync failed: ${(e as Error).message}`));
  }
  console.log("──────────────────────────────────────────────────");
  console.log(
    `Live Host ready (${TENANT_INSTALLATION_ID ? `cell — installation ${TENANT_INSTALLATION_ID}` : "multi-repo"}, single port)`,
  );
  console.log(`host repo : ${HOST_REPO} (local content: ${HOST_CONTENT})`);
  console.log(`data dir  : ${DATA_DIR}`);
  console.log(`endpoint  : http://localhost:${PORT}  (HTTP + WebSocket, one port)`);
  console.log(
    `repos     : ${registry
      .list()
      .map((r) => r.fullName)
      .join(
        ", ",
      )}${connectionSource?.canEnumerate ? "" : "  (static — no connection source, installations not enumerated)"}`,
  );
  console.log(
    `minting   : ${MINT_URL ? `remote (control plane, tenant ${TENANT_INSTALLATION_ID})` : appCreds ? "local (app key)" : "none"}`,
  );
  console.log(
    `auth      : ${providers.size > 0 ? `github login (app: ${appSlug ?? "oauth"})` : "no login configured (pnpm create-app)"}${devToken() ? ` (+ dev token '${devToken()}')` : ""}`,
  );
  console.log(`room name = <owner>/<repo>/<path>, Y.Text field 'content'`);
  console.log("──────────────────────────────────────────────────");
})();
