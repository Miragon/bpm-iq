/**
 * GitHub implementation of the RepoConnectionSource port — the App mechanics:
 * installation enumeration (app JWT, local mode) or the single tenant
 * installation (cell mode), installation-token clone credentials, the install
 * picker URL, and HMAC-verified webhooks.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { paginate } from "@bpmiq/github-app";

import type {
  ConnectionSnapshot,
  RepoConnectionSource,
  RepoPermission,
  SourceRepo,
} from "../../ports/connection-source.ts";
import type { TokenService } from "../../repos/token-minter.ts";
import { type AppCredentials, appRest, githubApi } from "./app-auth.ts";

export function createGitHubAppSource(args: {
  /** REST base, e.g. https://api.github.com */
  apiUrl: string;
  /** installation-token minting seam (local app key OR remote control plane) */
  tokens: TokenService;
  /** app-JWT credentials — LOCAL mode only; enables /app/installations enumeration */
  creds?: AppCredentials;
  appSlug?: string;
  webhookSecret?: string;
  baseUrl: string;
  /**
   * SaaS cell mode (ADR 0002): restrict this instance to ONE installation.
   * When set, the registry, workspaces and rooms only ever see that tenant's
   * repos. Unset = today's behavior (serve every installation of the app).
   * In REMOTE mint mode (no app key in the cell) this is REQUIRED — the cell
   * cannot enumerate installations, only list its own tenant's repos.
   */
  tenantInstallationId?: number;
}): RepoConnectionSource {
  const { apiUrl, tokens, creds, appSlug, webhookSecret, baseUrl, tenantInstallationId } = args;
  const api = apiUrl.replace(/\/$/, "");

  /** list a single installation's repos with its installation token */
  async function reposFor(installationId: number): Promise<SourceRepo[]> {
    const token = await tokens.mint(installationId);
    const repos = (await paginate(githubApi(api), "/installation/repositories?per_page=100", { token })) as Array<{
      full_name: string;
      default_branch: string;
      private: boolean;
      owner: { avatar_url?: string };
    }>;
    return repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
      avatarUrl: r.owner.avatar_url ?? null,
      connectionRef: installationId,
    }));
  }

  return {
    id: "github-app",
    // enumerable if we can act as the app (local) OR we are a scoped cell (remote)
    canEnumerate: creds !== undefined || tenantInstallationId !== undefined,

    async listConnectedRepos() {
      const snapshot: ConnectionSnapshot = {
        repos: [],
        knownRefs: new Set(),
        enumeratedRefs: new Set(),
        suspendedRefs: new Set(),
      };

      // REMOTE cell mode: no app key here — just list this tenant's repos via a
      // minted token. Suspension is enforced upstream (mint refuses a suspended
      // installation), so a mint failure keeps last state rather than pruning.
      if (!creds) {
        if (tenantInstallationId === undefined) {
          throw new Error("no app credentials and no tenant installation — cannot enumerate");
        }
        snapshot.knownRefs.add(tenantInstallationId);
        snapshot.enumeratedRefs.add(tenantInstallationId);
        snapshot.repos.push(...(await reposFor(tenantInstallationId)));
        return snapshot;
      }

      // LOCAL mode: enumerate installations via the app JWT.
      let installations: Array<{ id: number; suspended_at: string | null }>;
      if (tenantInstallationId) {
        const res = await appRest(creds, `/app/installations/${tenantInstallationId}`);
        if (!res.ok) throw new Error(`installation ${tenantInstallationId} → ${res.status} ${await res.text()}`);
        installations = [(await res.json()) as { id: number; suspended_at: string | null }];
      } else {
        installations = (await paginate(githubApi(api), "/app/installations?per_page=100", {
          key: creds,
        })) as typeof installations;
      }
      for (const inst of installations) {
        snapshot.knownRefs.add(inst.id);
        if (inst.suspended_at !== null) {
          snapshot.suspendedRefs.add(inst.id);
          snapshot.enumeratedRefs.add(inst.id); // suspension is authoritative, not a failure
          continue;
        }
        try {
          snapshot.repos.push(...(await reposFor(inst.id)));
          snapshot.enumeratedRefs.add(inst.id);
        } catch (e) {
          // transient failure — this installation's repos must NOT be pruned this round
          console.log(
            `installation ${inst.id}: repository listing failed (${(e as Error).message.split("\n")[0]}) — kept as-is`,
          );
        }
      }
      return snapshot;
    },

    async cloneToken(connectionRef) {
      if (connectionRef === null) return undefined;
      return tokens.mint(connectionRef);
    },

    async checkUserPermission(connectionRef, username, repo) {
      // GET /repos/{owner}/{repo}/collaborators/{username}/permission works with
      // Metadata (read) — the mandatory baseline permission — via the installation
      // token, and returns the EFFECTIVE permission incl. team-derived rights.
      const token = await tokens.mint(connectionRef);
      const res = await fetch(`${api}/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "bpm-live-host",
        },
      });
      // 404 = user is not a collaborator / app not installed on this repo → no access
      if (res.status === 404) return "none";
      if (!res.ok) throw new Error(`permission check ${repo}/${username} → ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { permission?: string; role_name?: string };
      const p = (body.role_name ?? body.permission ?? "none").toLowerCase();
      return (["admin", "maintain", "write", "read"].includes(p) ? p : "none") as RepoPermission;
    },

    connectUrl() {
      return appSlug ? `${baseUrl}/apps/${appSlug}/installations/new` : undefined;
    },

    verifyWebhook(headers, rawBody) {
      // FAIL CLOSED: without a configured secret we cannot verify authenticity
      if (!webhookSecret) return undefined;
      const sig = headers["x-hub-signature-256"];
      const expected = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
      const authentic =
        typeof sig === "string" &&
        sig.length === expected.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      const event = headers["x-github-event"];
      return {
        authentic,
        membershipChanged: authentic && (event === "installation" || event === "installation_repositories"),
      };
    },
  };
}
