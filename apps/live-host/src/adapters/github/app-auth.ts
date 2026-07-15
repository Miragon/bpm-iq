/**
 * GitHub App REST access (docs/multi-repo-architecture.md, B): the wire work —
 * fresh RS256 app JWT per request, GitHub media type, header merge — lives in
 * @bpmiq/github-app (same plumbing the control plane uses, so they can't
 * drift); this adapter pins the live-host user-agent.
 *
 * Installation tokens (1h, per-installation) are minted+cached by TokenService
 * (repos/token-minter.ts), which can act LOCALLY (app JWT here) or REMOTELY
 * (control plane) so a cell never needs the app key — see ADR 0002.
 */
import { appRest as sharedAppRest, type GitHubApi } from "@bpmiq/github-app";

export interface AppCredentials {
  appId: string;
  /** PEM (decoded from GITHUB_APP_PRIVATE_KEY_B64) */
  privateKey: string;
  apiUrl: string;
}

/** this app's GitHubApi descriptor (the shared plumbing takes the UA as a parameter) */
export const githubApi = (apiUrl: string): GitHubApi => ({ apiUrl, userAgent: "bpm-live-host" });

export async function appRest(creds: AppCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  return sharedAppRest(creds, githubApi(creds.apiUrl), path, init);
}
