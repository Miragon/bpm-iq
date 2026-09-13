# Identity provider quickstart — Keycloak

The Live Host has **one login: your OIDC identity provider**
([ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md)). This page gets you a working
one in minutes: Keycloak, shipped as a compose profile with a realm that already carries
everything the Live Host needs. Evaluate with it as is; for production keep the realm and
run Keycloak the way you run Keycloak (real database, TLS, `start` instead of `start-dev`).

Evaluating without any login at all? That is `LIVE_AUTH=none`
([README.md → operating modes](README.md#operating-modes)) — no IdP involved.

## What the realm carries

`deploy/keycloak/realm-bpmiq.json` — imported on Keycloak's first start:

| Item                                     | What / why                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| realm `bpmiq`                            | one realm for the platform; self-registration off                                                                                                                                                                                                                                            |
| client `bpmiq-web`                       | the browser login — public client, PKCE S256, redirect `http://localhost:8301/auth/oidc/callback`                                                                                                                                                                                            |
| client `bpmiq-mcp`                       | MCP clients — public client, PKCE S256, redirect `http://localhost:8765/callback` (Claude Code: `--client-id bpmiq-mcp --callback-port 8765`)                                                                                                                                                |
| two protocol mappers on each client      | **audience**: a fixed `aud: bpmiq` (Keycloak does not honor RFC 8707 resource indicators, so the Live Host is told the fixed value: `LIVE_OIDC_AUDIENCE=bpmiq`) — **`github_login`**: the user attribute as a claim in the access token (the login claim, `LIVE_OIDC_LOGIN_CLAIM`'s default) |
| user profile attribute `github_login`    | declared, **editable by admins only** — the claim decides which repositories a person may write, so the person must never be able to set it (the Live Host refuses tokens without it, and never falls back to `preferred_username`)                                                          |
| identity provider `github` (disabled)    | the production path: GitHub as the login method behind Keycloak, with a mapper that copies the verified GitHub `login` into `github_login` at every sign-in (sync mode FORCE) — enable it with your own GitHub OAuth App, see below                                                          |
| users `petra`/`petra`, `nobody`/`nobody` | demo users: petra carries `github_login = petra`; nobody carries no claim and is refused fail-closed — try both                                                                                                                                                                              |

## 1. Start Keycloak

```bash
cd deploy
docker compose --profile keycloak up -d keycloak
```

Admin console: http://localhost:8080 (`admin` / `admin`, override with `KEYCLOAK_ADMIN` /
`KEYCLOAK_ADMIN_PASSWORD`). The realm is imported on the first start; the container keeps
no state, so a `down -v` gives you a fresh realm.

## 2. Point the Live Host at it

`oidc` mode needs the IdP **and** a GitHub App — per-repo authorization runs on the App's
installation token, an identity alone can write nothing. Register the App first
([github-app-setup.md](github-app-setup.md)); to try the login without one, run the stub
provider the E2E uses (see "Verified" below).

From source, host on your machine, Keycloak in Docker:

```bash
LIVE_OIDC_ISSUER=http://localhost:8080/realms/bpmiq \
LIVE_OIDC_JWKS_URL=http://localhost:8080/realms/bpmiq/protocol/openid-connect/certs \
LIVE_OIDC_AUDIENCE=bpmiq \
LIVE_OIDC_CLIENT_ID=bpmiq-web \
LIVE_OIDC_LOGIN_LABEL=Keycloak \
pnpm live-host            # plus GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE / GITHUB_APP_SLUG
```

Both in containers (`docker compose --profile keycloak up -d`): the same values, except that
the Live Host reaches Keycloak over the compose network — JWKS and the token endpoint via
`http://keycloak:8080`, while the issuer and the authorize URL stay what the browser sees.
`.env.example` carries exactly this block (`LIVE_OIDC_JWKS_URL`, `LIVE_OIDC_TOKEN_URL`,
`LIVE_OIDC_AUTHORIZE_URL`); `KC_HOSTNAME` is pinned in the compose file so a token minted
over the container network carries the same issuer.

## 3. Sign in

Open http://localhost:8301 → **Sign in with Keycloak** → `petra` / `petra`. The overview
lists the repositories `petra` may write — as decided by your GitHub App, so for real
repositories set `github_login` on your own Keycloak user to your real GitHub login
(admin console → Users → the user → Attributes; only admins can).

Try `nobody` / `nobody`: Keycloak signs them in, the Live Host refuses the callback with
`auth/missing-claim` — a person without a verified git-provider login gets no session.

## 4. Connect an MCP client

```bash
claude mcp add --transport http bpm-live http://localhost:8301/mcp \
  --client-id bpmiq-mcp --callback-port 8765
```

The client hits `/mcp` → 401 + `WWW-Authenticate` → reads the protected-resource metadata
→ discovers Keycloak → runs the code+PKCE flow on the pre-registered `bpmiq-mcp` client →
presents an access token with `aud: bpmiq` and `github_login`. Other clients and their
redirect URIs: [extending/mcp-idp-setup.md](../extending/mcp-idp-setup.md#client-registration-without-dcr-pre-registration)
— register each client's callback on `bpmiq-mcp` (or one client per surface).

## 5. Your real users — GitHub as the login behind Keycloak

The demo users are local accounts with an admin-set attribute. For real people, make GitHub
the login method so the claim is populated by GitHub itself:

1. Create a GitHub **OAuth App** (org → Settings → Developer settings → OAuth Apps) with the
   authorization callback `http://localhost:8080/realms/bpmiq/broker/github/endpoint`
   (Keycloak's broker endpoint — your Keycloak URL in production).
2. Admin console → Identity providers → **GitHub**: paste client id + secret, enable.
3. The mapper _github_login from the GitHub profile_ is already there: at every sign-in it
   writes the verified GitHub `login` into the attribute (sync mode FORCE — a renamed
   GitHub account updates on the next login).
4. Optionally remove the username/password form from the browser flow (Authentication →
   browser) so GitHub is the **only** way in — the identity contract the Live Host assumes
   ([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md)).

This path is configuration; the automated verification below covers the local users
(it has no GitHub credentials).

## 6. Beyond localhost

- Realm: Clients → `bpmiq-web` → redirect URI and web origin = your `LIVE_PUBLIC_URL`;
  `bpmiq-mcp` → the callbacks of the MCP clients you allow.
- Compose: `KEYCLOAK_PUBLIC_URL` (the issuer origin every token carries) and
  `KEYCLOAK_ADMIN_PASSWORD` in `.env`; `LIVE_OIDC_ISSUER` / `LIVE_OIDC_AUTHORIZE_URL`
  follow it.
- Keycloak itself: a database, TLS and `start` — Keycloak's own production guide. The realm
  export is yours to keep; nothing in it is specific to dev mode.

## Verified

`apps/live-host/test/keycloak-e2e.sh` (needs Docker; not part of `pnpm test`) boots this
exact compose profile, a GitHub stub and a fresh Live Host in `oidc` mode, then proves: the
prerequisite check, the browser login through Keycloak's form, an MCP bearer from the
`bpmiq-mcp` code+PKCE flow at `/api/me` and `/mcp`, a release on that identity (PR at the
stub, the human as git author), and fail-closed refusal of a token without `github_login`
at `/api/me`, `/mcp` and the browser callback.

## Other identity providers

Any OIDC provider that issues audience-bound JWTs with the login claim works — the Live
Host side is pure configuration. The requirements table and the verified WorkOS AuthKit
recipe: [extending/mcp-idp-setup.md](../extending/mcp-idp-setup.md); the seam for
anything beyond OIDC: [extending/sso.md](../extending/sso.md).
