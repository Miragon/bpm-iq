# ADR 0005 — AI write access in-process: /mcp + content REST on the Live Host, OIDC resource server, no self-built AS

- **Status:** accepted (2026-07-24), amended (2026-08-03, 2026-08-04 and 2026-09-04 — see below)
- **Context:** adversarially reviewed against a fully built alternative (a
  separate broker-based MCP server); the review's confirmed findings drove this
  decision
- **Related:** [0001](0001-zero-stored-user-tokens.md) (auth model, unchanged),
  [0002](0002-multi-tenant-cell-architecture.md) (cells serve /mcp per tenant),
  [0004](0004-open-source-split.md) (one live-host artifact, unchanged)

## Context

Agents need WRITE access to the live platform state: read a process, edit it,
release it as a PR — the read-only `packages/mcp` server only covers checkouts.
The first iteration was a **separate MCP server** (`apps/live-mcp`, never
merged) built around two properties of the Live Host that were treated as
immutable: _no REST for current content_ (read/edit only via the Hocuspocus
Yjs room) and _a session id as the only credential_. Designing around them
forced, in the separate process: a client-side Yjs session cache (per-principal
warm WebSockets — with confirmed concurrency leaks, a ~10-minute authz
staleness window, success-acks before the socket flush, and socket-budget
collisions), plus a **session-mint endpoint** gated by a static broker secret
so the MCP server could obtain downstream credentials — an identity-assertion
oracle weaker than the platform's own signed handoff machinery, and a second
credential system to operate.

Both "immutable" properties are our own code. The MCP spec forbids forwarding
the client's token downstream (token passthrough); GitHub cannot act as the
authorization server for our API (opaque tokens, no audience binding, no DCR);
and the user decision stands: **no self-built SSO/authorization server —
anywhere**.

## Decision

1. **An IdP is the operating prerequisite for remote AI clients.**
   Authenticating MCP/headless clients requires a ready-made OIDC IdP
   (Keycloak, WorkOS, Auth0, …) issuing **audience-bound JWTs**; git providers
   (GitHub, later GitLab) are social connections _behind_ it. In the SaaS the
   IdP fronts GitHub as the only login method; on-prem the IdP and the login
   claim are per-customer configuration.

2. **No self-built authorization server.** The Live Host is only an OAuth 2.1
   **resource server**: it verifies `iss`/`aud`/`exp`/signature against the
   IdP's JWKS (`src/auth/oidc.ts`, `LIVE_OIDC_*` env) and maps the **login
   claim** (default `github_login`) to an identity. The claim must carry the
   IdP-verified git-provider login; a token without it is refused — **fail
   closed**, deliberately no `preferred_username`/`sub` fallback (those are
   user-editable in many IdPs; a fallback would turn an IdP misconfiguration
   into impersonation of an arbitrary GitHub identity). RFC 9728 metadata +
   `WWW-Authenticate` challenges make the IdP discoverable to MCP clients.

3. **Content REST via server-side direct connections.** The Live Host exposes
   `GET/PUT /api/repos/:repo/content?path=` over the **same live Y.Doc** the
   collaborative rooms edit (Hocuspocus `openDirectConnection` — no second
   data path, no second truth). PUT is validation-gated and **compare-and-set**
   on a content-derived token (a state-vector token would be blind to
   delete-only edits AND die on every doc unload/reseed; the ABA objection to
   a content hash is neutralized by the minimal-diff writer — overwriting
   identical bytes is a no-op): a stale token returns the current content
   instead of overwriting. Authorization runs **per request** through the same
   `canWrite` gate as every repo route — strictly stronger than the ws model's
   authorize-once-at-socket-open.

4. **/mcp lives in the Live Host process.** A stateless Streamable-HTTP
   endpoint on the official `@modelcontextprotocol/sdk`, one server instance
   per request, tools calling the application use-cases **in-process** with the
   caller's session. No second deployable, no downstream hop — and therefore
   **no session mint, no broker secret, no token exchange**: the passthrough
   problem dissolves because no downstream credential exists. In the cloud each
   cell serves its tenant's /mcp under the tenant URL (ADR 0002 isolation
   preserved); on-prem it is the same single container. `LIVE_MCP_READONLY=1`
   ships a read-only tool surface for cautious deployments.

5. **Authorization stays provider-native.** The JWT only authenticates. Whether
   an identity may touch a repository is still decided per (user, repo) against
   real git-provider permissions (`AccessCache`, app-side installation check —
   ADR 0001 unchanged); releases remain PRs whose merge rights live at the
   provider.

## Consequences

- **One deployable, one port, one auth story** (`sessionOf`): cookie sessions
  for humans, bearer JWTs for machines, the dev token for local spikes. The
  web app's GitHub-OAuth login is untouched; platform SSO for the _browser_
  (login via the same IdP) is the designated next step on the existing seam
  (docs/extending/sso.md).
- The content REST surface benefits every future integration, not just MCP —
  and eliminates the entire warm-socket client machinery class of defects.
- **OIDC identities require the app-side authz path** (GitHub App connection
  source): a JWT session holds no user token, so the user-token fallback is
  structurally closed.
- **Known cost — account linking:** identity mapping rides on the login claim.
  An enterprise-SSO user _without_ a linked git-provider identity
  authenticates but sees no writable repositories until an explicit linking
  step exists (IdP account linking). Deliberately deferred; documented in
  docs/extending/sso.md step 4.
- The Live Host absorbs JWT verification and the MCP protocol surface (larger
  single-process blast radius) — bounded by the pinned official SDK, `jose`,
  and per-request statelessness.
- **Rejected alternatives:** the separate broker service (`apps/live-mcp`:
  second deployable, mint endpoint + static broker secret as a parallel
  credential system, client-side Yjs session cache with its confirmed defect
  class, and the mcp-use dependency tree incl. telemetry postinstalls);
  Live-Host-as-AS (violates the no-self-built-AS decision); GitHub-as-AS
  (opaque tokens, no audience binding, no DCR).

## Amendment (2026-08-03): client registration without DCR; the no-AS rule becomes conditional

Re-evaluated after two facts changed:

1. **The MCP spec deprecated DCR.** Revision 2026-07-28 orders client
   registration as: pre-registered client information first, Client ID
   Metadata Documents second, DCR as a deprecated fallback — and states MCP
   clients SHOULD accept static client credentials. Real customers run IdPs
   without DCR; that is now the spec's normal case, not a gap.
2. **mcp-use re-checked (2026-07-31)** against its shipped server SDK: its
   OAuth presets exist but are reachable only through its Hono-based
   `MCPServer` owning the HTTP lifecycle (incompatible with the one-port
   `node:http` server and the three-credential `sessionOf` funnel), pin a
   conflicting SDK version, and bring inspector/CLI/telemetry as runtime
   dependencies. Rejection stands unchanged.

**Decided:**

- **Pre-registration is the supported registration path** for DCR-less IdPs: a
  statically registered public client (PKCE, no secret) at the customer's IdP,
  handed to clients out of band (`--client-id`, connector settings —
  docs/extending/mcp-idp-setup.md). CIMD needs no Live Host work at any point:
  it is purely AS-side; capable clients adopt it on their own when the IdP
  does.
- **Directories that cannot front MCP at all** (Entra ID rejects the
  `resource` parameter; ADFS/SAML-only have no usable AS) get a topology
  answer, not code: a broker IdP (WorkOS AuthKit, Keycloak with identity
  brokering) in front of the corporate directory. This transfers operating
  cost to the customer and must be stated as such.
- **The resource-server surface was hardened for exact-match clients**
  (per-resource RFC 9728 metadata for `/mcp`, audience literal-set with
  trailing-slash twins, optional challenge scopes, CORS on the public auth
  surface) — resource-server work, consistent with this ADR.
- **"No self-built AS — anywhere" is narrowed from an absolute to a
  conditional.** It holds because every known client×IdP combination is served
  by pre-registration, CIMD, or a broker — and because a `/register`/token
  endpoint would re-import the SSRF/confused-deputy attack class into the
  single-writer multi-tenant process this ADR shrank. **Trigger to revisit:**
  a named customer whose MCP client offers no static `client_id`, whose IdP
  supports neither pre-registration usable by that client nor CIMD, and who
  rejects the broker topology. Until all three hold at once, no AS is built.
- The `github_login` account-linking gap (above, "Known cost") is untouched by
  ALL of this: it is a token-issuance/identity-mapping problem, not a
  registration problem. For corporate directories it remains the real blocker
  and keeps its own seam (docs/extending/sso.md).

## Amendment (2026-08-04): single-use ws tickets for the MCP-App widget

The embedded modeler (MCP App, `open_modeler`) gained a live Hocuspocus/Yjs
mode. The iframe holds no credential — bridge tool calls ride the host's
authenticated backend, the OAuth token never reaches it — so the ws
`onAuthenticate` gate (session id / dev token) was unreachable. Decision: a
`mint_ws_ticket` tool issues a **single-use, room-bound ticket with a 60s
TTL** (`application/ws-tickets.ts`), redeemed once in `onAuthenticate`.

This is a deliberate, narrow exception to "no session mint" — and NOT the
broker mint this ADR rejected. The differences are the decision:

| Rejected broker mint (`apps/live-mcp`) | ws ticket                                     |
| -------------------------------------- | --------------------------------------------- |
| static broker secret as the credential | derives from a live, authenticated session    |
| identity ASSERTED by a second service  | identity checked by THIS host, seconds before |
| minted long-lived downstream sessions  | 60s TTL, consumed on first use                |
| all-repos authority                    | exactly one room (repo + file)                |
| second credential system to operate    | in-memory map, gone on restart                |

Authorization runs at mint time (`requireRepo` → `canWrite`); the redeem
window is far shorter than the AccessCache TTL, so no re-check on redeem. The
tool is app-visibility, absent under `LIVE_MCP_READONLY=1`. The widget treats
the whole path as progressive enhancement: if the host CSP does not honour
`connectDomains` (claude.ai's enforcement is partially buggy as of 2026-08),
it stays on the bridge-autosave fallback (`lint:"warn"` saves — the ws rooms'
trust level, which never gated live edits).

Single-use stays single-use across reconnects: the provider's automatic
reconnect re-sends the consumed ticket and can never re-authenticate, so the
widget treats ANY post-upgrade ws drop as the death of the session. It then
reconciles over the bridge — server still byte-equal to the session's last
replica: re-mint (the mint tool re-runs the write check) and resume live;
diverged: a banner hands the choice to the user. The server never widens a
ticket's lifetime to accommodate reconnects.

_2026-09-04 (#156):_ the ticket tool is registered ONCE for the live-capable
modeler widgets the web dist carries (bpmn, wardley, team-topology,
event-storming — the DMN widget never mints), no longer inside the BPMN
widget's block — bound, as before, to the first such widget's resource (bpmn
when its bundle is present) — so a dist without the BPMN bundle still lets the
other widgets go live. Still app-visibility, still absent under
`LIVE_MCP_READONLY=1` and without a served live-capable widget.
