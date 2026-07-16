# Extending bpmiq: git connectors

A connector teaches the Live Host a new git vendor — GitLab is the worked example
throughout. The seam is three ports in `apps/live-host/src/ports/`; GitHub is one
implementation of each, a new vendor is a second implementation, not a rewrite
([ADR 0003](../adr/0003-module-architecture-and-shared-packages.md),
[ADR 0004](../adr/0004-open-source-split.md)).

## The three ports

The provider abstraction is deliberately split by **whose credential acts**:

- `GitProvider` — the USER-credentialed half (the person's OAuth grant).
- `RepoConnectionSource` — the PLATFORM-credentialed half (the instance's own credential).
- `IssueTracker` — model-anchored todos as first-class items in the customer's own tracker.

A complete connector implements the first two; `IssueTracker` enables the todo feature
(the `/todos` API answers 501 without it).

### `GitProvider` — `apps/live-host/src/ports/git-provider.ts`

Everything a provider does with the user's grant: the OAuth dance (incl. refresh),
the per-(user,repo) permission gate, the authenticated push URL, PR/MR creation.
The release flow and the session layer never mention a concrete provider.

```ts
export interface GitProvider {
  readonly id: string;
  readonly label: string;
  authorizeUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>;
  refreshGrant?(refreshToken: string): Promise<TokenGrant>;
  fetchUser(token: string): Promise<GitUser>;
  checkRepoAccess(token: string, user: GitUser, repo: string): Promise<boolean>;
  pushUrl(token: string, repo: string): string;
  createPullRequest(
    token: string,
    repo: string,
    args: { branch: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef>;
}
```

| Member                                 | One line                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                   | Provider id used in routes (`/auth/<id>`) and sessions — `"gitlab"`.                                                                     |
| `label`                                | Human label for the login button.                                                                                                        |
| `authorizeUrl(redirectUri, state)`     | Full authorize URL the browser is redirected to (state included — the host signs and browser-binds it, you just carry it).               |
| `exchangeCode(code, redirectUri)`      | Exchange the callback code for the user's `TokenGrant`.                                                                                  |
| `refreshGrant?(refreshToken)`          | Refresh an expiring grant — **not optional for GitLab**: its OAuth tokens always expire (2h); a provider that drops it strands sessions. |
| `fetchUser(token)`                     | The authenticated user's identity (`GitUser`: login, name, avatar, provider).                                                            |
| `checkRepoAccess(token, user, repo)`   | True if the user may WRITE the given repo — the per-(user,repo) entry ticket ("login authenticates, repos authorize").                   |
| `pushUrl(token, repo)`                 | HTTPS remote URL carrying the user's token, consumed by `git push`.                                                                      |
| `createPullRequest(token, repo, args)` | Open a pull/merge request AS THE USER on the given repo — GitLab returns the MR's `web_url` + `iid` as `PullRequestRef`.                 |

`TokenGrant` carries `accessToken` + optional `refreshToken`/`expiresAt` (epoch ms;
undefined = non-expiring). Every repo-scoped capability takes the target repo's full
path per call — the provider represents the CONNECTION to a git host, not a repository.

### `RepoConnectionSource` — `apps/live-host/src/ports/connection-source.ts`

Where the set of connected repositories comes from and how the server clones them.
GitHub implements it with App mechanics (installations, installation tokens, install
picker, HMAC webhooks). GitLab has none of those concepts — its source will be an
OAuth application + explicit project selection (or group access tokens) and
`X-Gitlab-Token` webhooks — but the registry and the API only ever talk to this interface.

```ts
export interface RepoConnectionSource {
  readonly id: string;
  readonly canEnumerate: boolean;
  listConnectedRepos(): Promise<ConnectionSnapshot>;
  cloneToken(connectionRef: number | null): Promise<string | undefined>;
  connectUrl(): string | undefined;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookVerdict | undefined;
  checkUserPermission?(connectionRef: number, username: string, repo: string): Promise<RepoPermission>;
}
```

| Member                                            | One line                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                              | Source id used in logs (`"github-app"` → `"gitlab-oauth"`).                                                                                                   |
| `canEnumerate`                                    | False = no platform credentials: connect URL/webhooks may still work, but `listConnectedRepos` throws.                                                        |
| `listConnectedRepos()`                            | Authoritative `ConnectionSnapshot` of the connected-repo set (`repos` + `knownRefs`/`enumeratedRefs`/`suspendedRefs` so pruning is safe on partial listings). |
| `cloneToken(connectionRef)`                       | Short-lived credential for server-side `git clone`/`fetch` of ONE repo.                                                                                       |
| `connectUrl()`                                    | Where a user connects more repos (GitHub: the app's install picker; GitLab: your project-selection page).                                                     |
| `verifyWebhook(headers, rawBody)`                 | Verify + classify an incoming webhook (`authentic`? `membershipChanged`?); undefined = webhooks not configured. The HTTP layer FAILS CLOSED on your verdict.  |
| `checkUserPermission?(connectionRef, user, repo)` | A user's effective `RepoPermission` resolved with the PLATFORM credential — no user token needed (ADR 0001); undefined = fall back to the user-token path.    |

`SourceRepo.fullName` is the provider-unique full path — multi-segment GitLab paths
(`group/sub/project`) are supported end to end (rooms, API routes and the registry
match the repo as a greedy prefix; the route shape never assumes `owner/name`).

### `IssueTracker` — `apps/live-host/src/ports/issue-tracker.ts`

The third port carries model-anchored **todos**: work items that live in the customer's
OWN tracker, never in a platform database. GitHub implements it with repo issues +
labels; GitLab maps 1:1 onto project issues; Jira maps a repo to a project via adapter
config — which is why `Todo.id` is an opaque string and nothing in the contract assumes
numbers, labels, or markdown. The anchor codec (which process, which BPMN elements) is
platform domain (`domain/todo-anchor.ts`); an adapter only decides WHERE the encoded
block is stored (GitHub: the issue body).

## The rule (ADR 0003)

A new vendor is **one new folder**: `apps/live-host/src/adapters/<vendor>/`
(mirror `adapters/github/`: `provider.ts` for `GitProvider`, a source module for
`RepoConnectionSource`). Zero changes to `domain/` and `application/` — they only
see the ports. `server.ts` is the ONLY place that reads env and wires adapters;
follow the existing pattern there: construct the adapter behind its env detection
(`GITLAB_*` set → construct), add the provider to the `providers` map (the
`/auth/:provider` routes derive from `provider.id`), pass the source where
`connectionSource` flows today (registry, access cache, HTTP webhook route).

These boundaries are CI-enforced: `pnpm arch` (dependency-cruiser) rejects adapter
imports from `application/`, cross-vendor imports, and I/O outside designated
adapters — so maintainers can review connector PRs **structurally**, not by reading
every line. A connector that ships standalone graduates to
`@bpmiq/connector-<vendor>` against the same ports (follow-up ADR, per ADR 0003).

## GitLab specifics

From the live-host README (GitLab section): the architecture carries GitLab, the
implementation was **deliberately deferred** — a full GitLab draft exists in git
history (`08b6c20` era, pre-`TokenGrant`), and the ports already carry its lessons:

- Token login maps 1:1 onto GitLab **personal access tokens**.
- `createPullRequest` opens a **merge request** — same `PullRequestRef` shape.
- `TokenGrant.refreshToken`/`expiresAt` exist because GitLab OAuth tokens always
  expire (2h) — implement `refreshGrant`.
- Webhook verification is token-compare (`X-Gitlab-Token`), not HMAC — that is why
  `verifyWebhook` owns the whole verdict instead of the HTTP layer assuming a scheme.
- Known open item: repo RENAMES change the identity key (rooms, lineage PKs,
  workspace dirs) — the migration path is sketched in
  [multi-repo-architecture.md](../multi-repo-architecture.md).

## Offline development — the stub-provider harness

You never need real credentials (or internet) to develop a connector.
`apps/live-host/test/stub-provider.ts` is a GitHub-shaped fake of the whole vendor
surface — OAuth authorize/token, user + permissions, App installations +
installation tokens, PR creation — plus a `POST /_control` endpoint that flips the
permission gate, edits the installation directory, and records PR payloads for
assertions.

`apps/live-host/test/release-e2e.sh` shows the full pattern (run:
`pnpm --filter @bpmiq/live-host test`):

1. Start the stub (`node test/stub-provider.ts`, port 8399) and seed it via `_control`.
2. Point the host at it: `GITHUB_BASE_URL`/`GITHUB_API_URL=http://localhost:8399`,
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET=stub`, a throwaway RSA key as the app
   key (the stub never verifies JWT signatures).
3. Replace the network git remotes with local bare repos:
   `LIVE_GIT_URL_OVERRIDE=file://…` (clone/fetch) + `LIVE_PUSH_URL_OVERRIDE=file://….git` (push).
4. Drive the API with `LIVE_DEV_TOKEN=demo` and assert the release gates end to end
   (no-change rejection, unknown-process 404, branch + PR with correct paths,
   upstream-drift guard, monorepo-shaped `bpmiq.yml` folders).

A GitLab connector gets a sibling `test/stub-gitlab.ts` shaped like GitLab's API and
its own e2e script on the same skeleton — the whole login → repo-gate → session →
release path runs fully offline.

## What a connector PR must include

- `apps/live-host/src/adapters/<vendor>/` implementing both ports; wiring only in
  `server.ts`.
- A vendor-shaped stub + stub-based tests (unit tests for the adapter, an e2e on the
  `release-e2e.sh` skeleton).
- Env var documentation: `deploy/.env.example` + the live-host README.
- **No new dependencies** in `domain/`/`application/` — and ideally none at all
  (the GitHub adapters are plain `fetch`).
- `pnpm arch`, `pnpm -r test`, lint and typecheck green.
