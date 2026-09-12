/**
 * Editor sign-in (the VS Code extension): the SAME provider / OIDC login the
 * browser uses, with a different landing.
 *
 *   editor  → browser   GET /auth/<provider>?editor=<uri scheme>&editor_state=<nonce>
 *   browser → IdP → callback: the session is minted as always, but instead of
 *             the cookie the callback answers a page that sends the browser to
 *             <scheme>://miragon-gmbh.bpm-live/auth?code=<one-time>&state=<nonce>
 *   editor  → POST /auth/exchange {code} → Me (the session id as wsToken)
 *
 * Trust boundaries:
 *  - the (scheme, nonce) pair rides the flow in a browser-bound cookie exactly
 *    like the OAuth nonce — the callback can only land in the browser that
 *    started it
 *  - the return target is BUILT here from a validated scheme and the fixed
 *    extension id, never from a caller-supplied URL (no open redirect of a code)
 *  - the code is single-use and dies in 60s (application/login-codes.ts); the
 *    nonce lets the editor match the callback to its own pending sign-in
 *  - the browser gets NO session cookie: the editor's session and a web
 *    session are separate, so signing out of one never kills the other
 */
import { EDITOR_EXTENSION_ID, EDITOR_LOGIN_PATH } from "@bpmiq/contracts/live";

/** a custom URI scheme (RFC 3986 scheme grammar, lowercase): vscode,
 *  vscode-insiders, cursor … — what vscode.env.uriScheme reports */
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,63}$/;
/** the editor's nonce — base64url, at least 8 chars */
const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface EditorLogin {
  scheme: string;
  state: string;
}

/** the ?editor=&editor_state= pair of a login START: undefined for a plain
 *  browser login (neither present), null when present but malformed */
export function parseEditorLogin(params: URLSearchParams): EditorLogin | undefined | null {
  const scheme = params.get("editor");
  const state = params.get("editor_state");
  if (scheme === null && state === null) return undefined;
  if (scheme === null || state === null || !SCHEME_RE.test(scheme) || !STATE_RE.test(state)) return null;
  return { scheme, state };
}

/** cookie value for the flow — "<scheme>:<state>" (neither part carries a colon) */
export function encodeEditorCookie(login: EditorLogin): string {
  return `${login.scheme}:${login.state}`;
}

export function decodeEditorCookie(value: string | undefined): EditorLogin | undefined {
  if (!value) return undefined;
  const i = value.indexOf(":");
  if (i < 0) return undefined;
  const login = { scheme: value.slice(0, i), state: value.slice(i + 1) };
  return SCHEME_RE.test(login.scheme) && STATE_RE.test(login.state) ? login : undefined;
}

/** the URI the browser hands back to the editor — fixed authority, our query */
export function editorReturnUri(login: EditorLogin, code: string): string {
  const query = new URLSearchParams({ code, state: login.state });
  return `${login.scheme}://${EDITOR_EXTENSION_ID}${EDITOR_LOGIN_PATH}?${query}`;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** the callback's landing page: bounces the browser into the editor (a 302 to
 *  a custom scheme leaves the tab hanging on a blank page) and keeps a link in
 *  case the bounce is blocked */
export function editorReturnPage(returnUri: string, login: string): string {
  const href = escapeHtml(returnUri);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${href}">`,
    "<title>BPM Live — signed in</title>",
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}</style>",
    "</head><body>",
    `<h1>Signed in as @${escapeHtml(login)}</h1>`,
    `<p>Returning to your editor… <a href="${href}">Open the editor</a> if nothing happens.</p>`,
    "<p>You can close this tab.</p>",
    "</body></html>",
  ].join("\n");
}
