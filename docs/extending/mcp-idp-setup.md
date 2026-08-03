# Connecting an OIDC IdP for MCP & headless clients

The Live Host authenticates headless clients (MCP, CI, editor plugins) with
**audience-bound JWTs from a ready-made OIDC IdP** — it is only a resource
server ([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md)),
never an authorization server. This page is the deployment recipe: what ANY
IdP must provide, and a **verified, click-by-click WorkOS AuthKit setup**
(tested end-to-end 2026-07-27 against a real GitHub App installation).

## What any IdP must provide

| Requirement                                                                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authorization-server metadata** (RFC 8414) + **a client-registration path** — pre-registration, CIMD, or DCR (see below) | MCP clients discover the IdP through the Live Host's 401 challenge; for the `client_id` the MCP spec (revision 2026-07-28) prioritizes **pre-registered client information first**, then Client ID Metadata Documents, with DCR (RFC 7591) as a deprecated fallback — an IdP without DCR is fully workable                                                                                                  |
| An `aud` the Live Host accepts — **resource indicators** (RFC 8707) or a statically minted audience                        | the Live Host rejects tokens not issued FOR it (`auth/wrong-audience`) — this is what makes a leaked token useless elsewhere. It accepts its public URL and `<public URL>/mcp` (trailing-slash tolerant); an IdP without RFC 8707 (e.g. Keycloak) mints a fixed audience instead — set `LIVE_OIDC_AUDIENCE`. Fatal is only an IdP that REJECTS the `resource` parameter (Entra ID — see the broker section) |
| **The login claim** (`LIVE_OIDC_LOGIN_CLAIM`, default `github_login`) carrying the **IdP-verified git-provider username**  | authorization runs against real git-provider permissions per request; the claim must never be user-editable (no `preferred_username`!). A token without the claim is refused fail-closed (`auth/missing-claim`)                                                                                                                                                                                             |
| PKCE (S256), public client (`token_endpoint_auth_method=none`)                                                             | required by the MCP authorization flow; a `client_secret` handed to end users has zero confidentiality                                                                                                                                                                                                                                                                                                      |

The git provider stays the **only** login method at the IdP — that is what
guarantees the claim is populated and the identity maps to real repository
permissions. Identity ≠ authorization: see [sso.md](sso.md).

## Client registration without DCR (pre-registration)

Most enterprise IdPs ship with DCR disabled or absent — that is fine. An admin
pre-registers **one public client** (PKCE S256, no secret) at the IdP and hands
its `client_id` to users; every MCP client that matters accepts it out of band.
What the admin must allowlist as redirect URIs differs per client — check the
client's current docs, the URIs below were verified 2026-07-31:

| Client              | Where the `client_id` goes                              | Redirect URI to register                                                                  |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claude Code         | `--client-id` (+ `--callback-port`) on `claude mcp add` | `http://localhost:<port>/callback` — pick a port, pass the SAME one via `--callback-port` |
| claude.ai / Desktop | custom connector → Advanced settings                    | `https://claude.ai/api/mcp/auth_callback`                                                 |
| Cursor              | `auth.CLIENT_ID` in the MCP server config               | see Cursor's connector docs (web callback + localhost)                                    |
| VS Code             | `oauth.clientId` in `.vscode/mcp.json`                  | `http://127.0.0.1:33418/` + `https://vscode.dev/redirect`                                 |
| MCP Inspector       | client-ID field in the auth settings                    | its own loopback URI                                                                      |
| others (no field)   | wrap with `mcp-remote --static-oauth-client-info`       | mcp-remote's loopback URI                                                                 |

Two sharp edges:

- **Loopback ports are exact-match at most IdPs.** RFC 8252 §7.3 port
  flexibility applies to the `127.0.0.1`/`[::1]` literals, not the `localhost`
  hostname — and IdPs disagree on which they honor. A **fixed, documented
  callback port** (registered verbatim, used via `--callback-port`) sidesteps
  the whole matrix.
- **One client per client-surface where the IdP allows it** — a single fleet
  `client_id` spanning Claude, Cursor and VS Code destroys per-client consent,
  audit attribution and revocation at the IdP. One extra line in the admin
  checklist, zero code.

If a user's IdP supports **Client ID Metadata Documents** (CIMD), capable
clients switch to it by themselves — CIMD is purely AS-side, the Live Host has
no role in it and needs no change.

## Verified recipe: WorkOS AuthKit (GitHub)

### 1. Authentication methods

Enable **GitHub** as a social connection — and **disable every other method**
(email+password, magic link). The claim contract depends on GitHub being the
only way in.

The GitHub connection needs a GitHub **OAuth App** (Settings → Developer
settings → OAuth Apps): set its _Authorization callback URL_ to the **Redirect
URI shown in the WorkOS GitHub dialog** — copy it exactly. WorkOS requests the
`user:email` scope itself.

> **Gotcha (verified the hard way):** reusing a GitHub **App**'s OAuth
> credentials fails with `Error fetching GitHub profile` unless the app has the
> _Email addresses: Read-only_ account permission — WorkOS must read the user's
> email. A dedicated OAuth App avoids this entirely.

### 2. Connect configuration (the MCP-critical toggles)

Under **Connect → Configuration**:

- enable **Dynamic Client Registration** (convenient here; where a customer
  policy forbids it, pre-register a client instead — see the section above)
- register the Live Host's public URL as a **Resource Indicator**
  (e.g. `https://live.example.com` — locally `http://localhost:8301`).
  Clients send it as the `resource` parameter; WorkOS binds it into `aud`.

### 3. Organization = tenant

Create an Organization per tenant and set its **External ID to the GitHub App
`installation_id`** (the platform's tenant key — External IDs are unique per
environment and queryable via _get organization by external id_, which the
provisioning/reconcile path relies on). Add the users as members.

### 4. JWT template

Authentication → Sessions → _Configure JWT Template_:

```json
{
  "github_login": {{user.metadata.github_login}},
  "installation_id": {{organization.external_id}}
}
```

`org_id` is a standard claim on organization-scoped tokens. Null-handling drops
absent claims — a user without the metadata gets a token WITHOUT
`github_login`, which the Live Host refuses fail-closed (`auth/missing-claim`).

**Verified:** the template applies to DCR/Connect access tokens (not just
AuthKit browser sessions) — the decoded MCP token carries both custom claims.

### 5. The github_login metadata sync

JWT templates cannot read the GitHub identity directly, and WorkOS identities
expose only the **numeric** GitHub id. The sync (per user, once):

```
GET  /user_management/users/:id/identities   → idp_id  (numeric GitHub id)
GET  api.github.com/user/{idp_id}            → login   (public profile — no scopes needed)
PUT  /user_management/users/:id              → external_id = idp_id (stable anchor),
                                               metadata.github_login = login
```

In production this is the control plane's `user.created` webhook (or a
synchronous WorkOS **Action**, which closes the first-login race: with the
webhook, the very first token may miss the claim until the token refresh —
fail-closed either way). The numeric id in `external_id` is the rename-proof
key for the kick/reconcile path (_get user by external id_).

### 6. Live Host configuration

```sh
LIVE_OIDC_ISSUER=https://<env>.authkit.app
LIVE_OIDC_JWKS_URL=https://<env>.authkit.app/oauth2/jwks
LIVE_OIDC_AUDIENCE=<the registered resource indicator>   # default: LIVE_PUBLIC_URL; comma-separated for several
# LIVE_OIDC_LOGIN_CLAIM=github_login                      # the default
# LIVE_MCP_SCOPES=                                        # scopes advertised in the PRM + 401 challenge; unset = none
```

`<public URL>/mcp` is always accepted as an additional audience (it is the
resource identifier the `/mcp` protected-resource metadata advertises), and
every audience matches trailing-slash tolerantly — RFC 8707 clients derive the
`resource` from a URL, which normalizes a bare origin to `origin/`.

### 7. Connect a client

```sh
claude mcp add --transport http bpm-live https://live.example.com/mcp
```

The client hits `/mcp` → 401 + `WWW-Authenticate` → fetches
`/.well-known/oauth-protected-resource` → discovers AuthKit → DCR → browser
login (GitHub) → token. Organization selection is built into the hosted flow
(single org: auto-selected).

### Verified end-to-end (what the token looks like)

```json
{
  "github_login": "…",              ← JWT template ✓
  "installation_id": "145…",        ← organization external_id ✓
  "org_id": "org_…",                ← auto-selected organization ✓
  "aud": "http://localhost:8301",   ← resource indicator ✓
  "iss": "https://<env>.authkit.app",
  "exp": …                          ← 300 s; refresh_token grant verified ✓
}
```

With this token the full MCP surface was exercised: `list_repos` returns only
the repos the GitHub login can actually write (per-request authorization —
no god access), reads/derive, `validate_bpmn`, the `baseVersion`
conflict guard, and the validation gate.

### Failure modes (all fail closed)

| Situation                                               | Response                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| token without the login claim (metadata not yet synced) | `401 auth/missing-claim`                                           |
| token for another resource / garbage token              | `401 auth/wrong-audience` / `401 auth/invalid-token`               |
| valid identity without repository permission            | authenticated, but `list_repos` is empty and every repo route 403s |
| no credentials                                          | `401` + `WWW-Authenticate: Bearer resource_metadata="…"`           |

## Other IdPs

Any OIDC provider meeting the table above works — the Live Host side is pure
configuration. Keycloak maps the login claim with a protocol mapper on the
brokered GitHub/GitLab identity (no metadata detour needed) and mints the
audience via a client scope + audience mapper (it does not honor RFC 8707);
GitLab identities even arrive as standard OIDC claims. A verified Keycloak
recipe is a welcome contribution.

## When the corporate IdP cannot front MCP: broker topology

Some directories cannot act as an MCP authorization server at all, no matter
how registration is handled:

- **Entra ID** rejects the `resource` parameter that MCP clients send once
  protected-resource metadata exists (`AADSTS901002` / `AADSTS9010010`), and
  its AS metadata lacks both `code_challenge_methods_supported` and `"none"`
  in `token_endpoint_auth_methods_supported` — none of which a tenant admin
  can fix.
- **ADFS** and **SAML-only** directories have no usable OAuth AS for this flow.

The answer is topology, not Live Host code: put a **broker IdP** in front —
WorkOS AuthKit or Keycloak with identity brokering — with the corporate
directory as its upstream SSO connection. The broker is what fronts MCP (this
page's recipe applies to it verbatim); the corporate directory keeps owning
who may log in. Be explicit with the customer about the trade: it adds an
operated component (or a SaaS dependency) to their auth path, and the login
claim still needs a source — a corporate identity without a linked
git-provider login authenticates but sees no repositories
([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md),
"account linking").
