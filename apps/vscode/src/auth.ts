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

  /** how we show up in a room's roster — the signed-in person (same name and
   *  color as in the web app), else the dev-token identity the host assigns */
  presence(): PresenceUser {
    const me = this.me();
    return {
      name: me ? me.name || me.login : "dev-token",
      color: presenceColor(me?.login ?? "dev-token"),
      avatarUrl: me?.avatarUrl ?? null,
    };
  }

  /** the browser round-trip; resolves to the signed-in identity, throws on
   *  cancel/timeout — the caller reports */
  async login(): Promise<Me> {
    const { http } = hostUrls(this.serverUrl());
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
    await this.context.secrets.store(this.key("session"), me.wsToken);
    await this.context.globalState.update(this.key("me"), me.user);
    this.changed.fire();
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
