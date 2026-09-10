/**
 * The editor half of the Live Host's editor sign-in (live-host
 * http/editor-login.ts) — pure helpers, free of the vscode API so they are
 * unit-testable (src/test/unit/login-flow.test.ts):
 *
 *   start URL   GET <host>/auth/<provider>?editor=<uri scheme>&editor_state=<nonce>
 *   callback    <scheme>://miragon-gmbh.bpm-live/auth?code=<one-time>&state=<nonce>
 *   exchange    POST <host>/auth/exchange {code} → Me
 */
import { EDITOR_LOGIN_PATH } from "@bpmiq/contracts/live";

/** both forms of the configured Live Host URL — the REST base and the
 *  Hocuspocus ws base; the setting accepts either */
export function hostUrls(configured: string): { http: string; ws: string } {
  const http = configured
    .trim()
    .replace(/\/+$/, "")
    .replace(/^ws(s?):\/\//, "http$1://");
  return { http, ws: http.replace(/^http(s?):\/\//, "ws$1://") };
}

export function loginStartUrl(httpBase: string, providerId: string, scheme: string, state: string): string {
  const url = new URL(`${httpBase}/auth/${providerId}`);
  url.searchParams.set("editor", scheme);
  url.searchParams.set("editor_state", state);
  return url.toString();
}

/** the callback the Live Host bounced the browser to — code + state, or
 *  undefined when the URI is not a sign-in callback at all */
export function parseLoginCallback(path: string, query: string): { code: string; state: string } | undefined {
  if (path !== EDITOR_LOGIN_PATH) return undefined;
  const q = new URLSearchParams(query);
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) return undefined;
  return { code, state };
}
