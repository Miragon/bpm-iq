# ADR 0001 — Zero stored user tokens: authorization via installation token

- **Status:** accepted (2026-07-10). Write-path attribution DECIDED 2026-07-11:
  **variant A (bot-authored)** — implemented (`apps/live-host/src/api.ts` release()).
- **Context:** SaaS direction (docs/adr/0002); security research 2026-07-10 (26 primary sources, verified)

## Context

The platform authenticates users via the central GitHub App's OAuth flow and
authorizes per (user, repo): write permission on the connected repository is
the entry ticket. Until now the user's OAuth access token was stored
server-side (SQLite `sessions.provider_token`) and used for two things:

1. **Authorization checks** — `GET /repos/{owner}/{repo}` with the user token
   on every API access and websocket room join (5-min cache).
2. **Releases as the user** — `git push` + PR creation with the user token, so
   the branch and PR belong to a person.

The question: must those tokens be stored at all?

### What the industry does (research 2026-07-10, primary sources)

Three patterns exist among GitHub-based SaaS:

- **Bot-authored writes, no stored user tokens (majority):** Vercel, Netlify,
  Render, GitBook, Mintlify, ReadMe, Renovate, Mergify. Writes run on 1h
  installation tokens as the app bot. Attribution via git metadata — GitBook's
  pattern: human as git _author_, `gitbook-bot` as _committer_ (GitHub UI
  shows the human).
- **Stored user tokens, heavily hardened (minority):** Graphite (app-layer
  AES-256, key in AWS Secrets Manager, separate from DB key), Sourcegraph
  Batch Changes, Terraform Cloud OAuth mode. GitHub's own best-practices doc
  permits this — expiring tokens (8h + single-use 6-month refresh), encrypted
  at rest, refresh tokens stored separately.
- **Store nothing:** Mintlify after their March 2024 incident (token stays
  client-side, deleted after first use), GitHub's remote MCP server (in-memory
  only).

Every major stored-token incident had the token store as the crown jewel:
Heroku/Travis CI 2022 (private repos of dozens of orgs cloned, npm pivot →
~100k credentials), CircleCI 2023 (**encryption at rest did not help** — keys
were pulled from the running process), Waydev 2020, Mintlify 2024 (91 tokens).
Post-incident, the industry converged on installation-token architectures.

### The empirical unblocking fact

`GET /repos/{owner}/{repo}/collaborators/{username}/permission` requires only
**Metadata (read)** — the mandatory baseline permission of every GitHub App —
and is callable with an **installation token**
(docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
Verified 2026-07-10 against our production app (`bpm-live`, permissions:
contents write, metadata read, pull_requests write): returns the **effective**
permission incl. team-derived rights (`role_name: admin`), and a clean
`permission: none` for non-collaborators. A stale comment in
`auth/github.ts` claimed otherwise; it was wrong for today's permission set.

Tenant discovery at login needs no stored token either:
`GET /user/installations` (called once with the transient login token, then
discarded) lists exactly the installations of THIS app the user can access —
explicitly including access via org membership AND via repo collaborator
status (covers outside collaborators).

## Decision

1. **Authorization never uses a stored user token.** `canWrite(user, repo)` is
   answered app-side: installation token + `collaborators/{username}/permission`.
   The user's OAuth token is used at login for identity (`/user`) and tenant
   discovery (`/user/installations`), then **discarded**. Nothing user-scoped
   is persisted beyond the session row (login, name, avatar).
2. **Sessions carry no provider credential.** The session id (httpOnly cookie /
   ws token) remains the only client credential; a session without
   `provider_token` is the target state.
3. **Server-side git operations** (clone/fetch, release worktrees) continue to
   run on installation tokens — they never needed user tokens.

### Write-path attribution — DECIDED: bot-authored (variant A)

The release flow (`release()` in `apps/live-host/src/api.ts`) pushes the branch
and opens the PR with the app **installation token**; the commit carries the
releasing human as git author plus a `Co-authored-by` trailer. Consequences,
all verified by the release E2E:

- **The human can approve their own release** — the PR is authored by the app
  bot, not the user, so GitHub's "can't approve your own PR" does not apply.
  This strengthens merge = approval.
- **Zero user credentials needed** — a handoff/cell session (no stored user
  token) can release. This completes the zero-token model.
- **Attribution preserved** — GitHub shows the human as the commit author.

Fallback: when there is no app installation (legacy OAuth-only dev mode), the
release uses the session's user token as before. Variant B (JIT re-grant, push
as the user) was considered and rejected as the default — it adds a redirect
round-trip per release for a cosmetic gain (PR authored by the user) that the
bot-authored model deliberately trades away to enable self-approval.

## Consequences

- The strongest possible answer in enterprise security reviews: _we do not
  store your employees' GitHub credentials._
- Authorization keeps working for users whose token would have expired
  (checks no longer depend on user-token freshness); the token-refresh
  machinery becomes unnecessary once the write path migrates.
- Rate-limit profile shifts to the installation budget (5,000+/h per
  installation, scales with repos/users) — inherently per-tenant.
- The `GitProvider` seam keeps `checkRepoAccess` for providers where app-side
  lookup is unavailable; the GitHub path prefers the connection-source lookup.
- MCP tokens (0002) dereference to user identity + this authorization path —
  no user tokens there either.
