/**
 * Shared wire shapes used by more than one backend↔frontend seam.
 *
 * GitUserWire is the ONE user-identity shape the platform exchanges:
 *   - live-host      ports/git-provider.ts `GitUser`      (OAuth login, /api/me)
 *   - control-plane  adapters/github/api.ts `GitHubUser`  (/api/workspaces)
 *   - cell-protocol  `HandoffIdentity`                    (handoff-token claims)
 *
 * All three are byte-identical today; this type pins the wire shape. The
 * backend-internal types deliberately stay where they live (a port must not
 * depend on a wire contract) — the `satisfies` checks at the send sites are
 * what enforce the equivalence.
 */
export interface GitUserWire {
  /** provider-unique login, e.g. "dominikhorn93" */
  login: string;
  name: string;
  avatarUrl: string | null;
  /** provider id, e.g. "github" ("dev" for the headless dev-token session) */
  provider: string;
}
