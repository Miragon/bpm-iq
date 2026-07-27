# Connecting an OIDC IdP for MCP & headless clients

The Live Host authenticates headless clients (MCP, CI, editor plugins) with
**audience-bound JWTs from a ready-made OIDC IdP** — it is only a resource
server ([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md)),
never an authorization server. This page is the deployment recipe: what ANY
IdP must provide, and a **verified, click-by-click WorkOS AuthKit setup**
(tested end-to-end 2026-07-27 against a real GitHub App installation).

## What any IdP must provide

| Requirement                                                                                                               | Why                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authorization-server metadata** (RFC 8414) + **Dynamic Client Registration** (RFC 7591)                                 | MCP clients (claude.ai, Claude Code) discover the IdP through the Live Host's 401 challenge and register themselves — without DCR the flow dies before login                                                    |
| **Resource indicators** (RFC 8707) → `aud` = the Live Host's public URL                                                   | the Live Host rejects tokens not issued FOR it (`auth/wrong-audience`) — this is what makes a leaked token useless elsewhere                                                                                    |
| **The login claim** (`LIVE_OIDC_LOGIN_CLAIM`, default `github_login`) carrying the **IdP-verified git-provider username** | authorization runs against real git-provider permissions per request; the claim must never be user-editable (no `preferred_username`!). A token without the claim is refused fail-closed (`auth/missing-claim`) |
| PKCE (S256)                                                                                                               | required by the MCP authorization flow                                                                                                                                                                          |

The git provider stays the **only** login method at the IdP — that is what
guarantees the claim is populated and the identity maps to real repository
permissions. Identity ≠ authorization: see [sso.md](sso.md).

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

- enable **Dynamic Client Registration**
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
LIVE_OIDC_AUDIENCE=<the registered resource indicator>   # default: LIVE_PUBLIC_URL
# LIVE_OIDC_LOGIN_CLAIM=github_login                      # the default
```

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
brokered GitHub/GitLab identity (no metadata detour needed); GitLab identities
even arrive as standard OIDC claims. A verified Keycloak recipe is a welcome
contribution.
