/**
 * Sign-in for the extension: the Live Host's editor sign-in (live-host
 * http/editor-login.ts). The browser runs the provider's OAuth / the OIDC
 * login as usual; the callback bounces back into THIS editor through its URI
 * scheme with a one-time code, which we exchange for the session id — the one
 * credential the Live Host accepts on the websocket AND the REST routes.
 *
 * The session id lives in SecretStorage (per host URL), the identity in
 * globalState. Without a sign-in the configured dev token is used — the local
 * spike mode, where the Live Host runs without a login provider.
 */
import { randomBytes } from "node:crypto";

import { presenceColor, type PresenceUser } from "@bpmiq/contracts/live";
import type { AppConfig, EditorLoginExchangeBody, Me } from "@bpmiq/contracts/live-host";
import * as vscode from "vscode";

import { hostJson } from "./host-api.ts";
import { hostUrls, loginStartUrl, parseLoginCallback } from "./login-flow.ts";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export class LiveAuth implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly serverUrl: () => string;
  private readonly devToken: () => string;
  /** the sign-in waiting for its browser callback (one at a time) */
  private pending: { state: string; resolve: (code: string) => void } | undefined;
  /** the host's /api/me answer for the credential it was fetched with */
  private identityCache: { token: string; user: Me["user"] } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** fires after a sign-in or sign-out */
  readonly onDidChange = this.changed.event;

  constructor(context: vscode.ExtensionContext, serverUrl: () => string, devToken: () => string) {
    this.context = context;
    this.serverUrl = serverUrl;
    this.devToken = devToken;
  }

  private key(kind: "session" | "me"): string {
    return `bpmLive.${kind}:${hostUrls(this.serverUrl()).http}`;
  }

  /** who we are on the configured host — undefined while not signed in */
  me(): Me["user"] | undefined {
    return this.context.globalState.get<Me["user"]>(this.key("me"));
  }

  /** the ws/REST credential: the signed-in session, else the dev token */
  async token(): Promise<string> {
    return (await this.context.secrets.get(this.key("session"))) ?? this.devToken();
  }

  /** who the HOST says we are for the current credential — the signed-in
   *  person (also for a pasted session token) or the dev-token bot; the
   *  stored identity when the host cannot be asked */
  async identity(): Promise<Me["user"] | undefined> {
    const token = await this.token();
    if (this.identityCache?.token === token) return this.identityCache.user;
    try {
      const me = await hostJson<Me>(`${hostUrls(this.serverUrl()).http}/api/me`, { token });
      this.identityCache = { token, user: me.user };
      return me.user;
    } catch {
      return this.me();
    }
  }

  /** how we show up in a room's roster — the same name and color as in the
   *  web app; "dev-token" is what the host calls the dev-token session */
  async presence(): Promise<PresenceUser> {
    const me = await this.identity();
    const login = me?.login ?? "dev-token";
    return { name: me ? me.name || me.login : login, color: presenceColor(login), avatarUrl: me?.avatarUrl ?? null };
  }

  /** sign in with a pasted session token — the wsToken of <host>/api/me after
   *  a browser login there — for hosts without the editor sign-in */
  async useToken(token: string): Promise<Me> {
    const { http } = hostUrls(this.serverUrl());
    const me = await hostJson<Me>(`${http}/api/me`, { token });
    // a JWT bearer identifies over HTTP but its /api/me wsToken is synthetic —
    // it cannot open the live websocket; the dev token's session is "dev"
    if (me.wsToken !== token && me.user.provider !== "dev") {
      throw new Error(
        `this token cannot open the live websocket — paste the wsToken of ${http}/api/me from a browser login`,
      );
    }
    await this.remember(token, me.user);
    return me;
  }

  private async remember(token: string, user: Me["user"]): Promise<void> {
    await this.context.secrets.store(this.key("session"), token);
    await this.context.globalState.update(this.key("me"), user);
    this.identityCache = { token, user };
    this.changed.fire();
  }

  /** the browser round-trip; resolves to the signed-in identity, throws on
   *  cancel/timeout — the caller reports */
  async login(): Promise<Me> {
    const { http } = hostUrls(this.serverUrl());
    // an older host (no editor sign-in) would run a plain browser login and
    // never call back — probe first: the exchange route answers 401 where it
    // exists, 404 where it doesn't (501 = present but switched off)
    const probe = await fetch(`${http}/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (probe.status === 404 || probe.status === 501) {
      throw new Error(
        `${http} has no editor sign-in yet (older Live Host) — use "BPM Live: Sign in with a session token…"`,
      );
    }
    const config = await hostJson<AppConfig>(`${http}/api/config`);
    const provider = await pickProvider(config.providers);
    if (!provider) throw new Error("sign-in cancelled");
    const state = randomBytes(18).toString("base64url");
    const code = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `BPM Live: finish signing in via ${provider.label} in your browser…`,
        cancellable: true,
      },
      (_progress, cancel) =>
        new Promise<string>((resolve, reject) => {
          const settle = (finish: () => void) => {
            clearTimeout(timer);
            this.pending = undefined;
            finish();
          };
          const timer = setTimeout(() => settle(() => reject(new Error("sign-in timed out"))), LOGIN_TIMEOUT_MS);
          cancel.onCancellationRequested(() => settle(() => reject(new Error("sign-in cancelled"))));
          this.pending = { state, resolve: (c) => settle(() => resolve(c)) };
          void vscode.env.openExternal(
            vscode.Uri.parse(loginStartUrl(http, provider.id, vscode.env.uriScheme, state), true),
          );
        }),
    );
    const me = await hostJson<Me>(`${http}/auth/exchange`, {
      method: "POST",
      body: { code } satisfies EditorLoginExchangeBody,
    });
    await this.remember(me.wsToken, me.user);
    return me;
  }

  async logout(): Promise<void> {
    const { http } = hostUrls(this.serverUrl());
    const session = await this.context.secrets.get(this.key("session"));
    if (session) {
      // best effort — the local credential goes either way
      await hostJson(`${http}/api/logout`, { method: "POST", token: session }).catch(() => undefined);
    }
    await this.context.secrets.delete(this.key("session"));
    await this.context.globalState.update(this.key("me"), undefined);
    this.identityCache = undefined;
    this.changed.fire();
  }

  /** the URI handler: <scheme>://miragon-gmbh.bpm-live/auth?code=…&state=… */
  handleUri(uri: vscode.Uri): void {
    const callback = parseLoginCallback(uri.path, uri.query);
    if (!callback) return;
    const pending = this.pending;
    if (!pending || pending.state !== callback.state) {
      void vscode.window.showWarningMessage("BPM Live: ignored a sign-in callback that matches no pending sign-in.");
      return;
    }
    pending.resolve(callback.code);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

async function pickProvider(providers: AppConfig["providers"]): Promise<AppConfig["providers"][number] | undefined> {
  if (providers.length === 0) {
    throw new Error("the Live Host has no login provider configured — use the dev token (bpmLive.token)");
  }
  if (providers.length === 1) return providers[0];
  const picked = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.label, provider: p })),
    { placeHolder: "Sign in to the Live Host via…" },
  );
  return picked?.provider;
}
