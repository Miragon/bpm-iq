/**
 * BPM Live Workspace — the "thin client" from the platform concept (revision 2):
 * no Live-Share clone, just a FileSystemProvider for `bpm-live://` whose file
 * contents are bound to the Live Host's Y.Text documents.
 *
 * The Miragon BPMN Modeler (a CustomTextEditorProvider matching *.bpmn by glob,
 * scheme-independent) opens these virtual documents like any other file.
 *
 * Identity: the editor sign-in (auth.ts) — the Live Host's own provider / OIDC
 * login, bounced back through this extension's URI handler; the session id it
 * yields is the ws token AND the REST bearer. Without a sign-in the dev-token
 * setting applies (local spike mode). Presence: every live document announces
 * the signed-in person (or the dev-token identity) in the room's roster.
 *
 * Documented limits (the M1 sync layer, see apps/live-host/README.md):
 *  - writeFile applies a minimal diff into the shared Y.Text (concept sync rule 2,
 *    via @bpmiq/live-client updateText — same rule as the web app)
 *  - remote changes reach VS Code via FileChangeType.Changed; VS Code re-reads the
 *    file only while the local document is not dirty. Live two-way binding into a
 *    dirty open document is the M1 sync layer (WorkspaceEdit application), the
 *    verified pattern of the OCT VS Code extension.
 */
import type { PresenceUser } from "@bpmiq/contracts/live";
import type { ModelInfo, RepoInfo } from "@bpmiq/contracts/live-host";
import { type LiveSession, openLiveSession } from "@bpmiq/live-client";
import { updateText } from "@bpmiq/live-client/text";
import * as vscode from "vscode";
import WebSocket from "ws";
import type * as Y from "yjs";

import { LiveAuth } from "./auth.ts";
import { hostJson } from "./host-api.ts";
import { hostUrls } from "./login-flow.ts";
import { modelItems, modelUri, repoItems } from "./model-picker.ts";

const SCHEME = "bpm-live";

interface LiveDoc {
  session: LiveSession;
  ytext: Y.Text;
  mtime: number;
}

/** what the file system needs from the outside — connection + identity */
interface LiveDeps {
  wsUrl(): string;
  token(): Promise<string>;
  presence(): PresenceUser;
  /** the host refused our credential (expired session, wrong dev token) */
  onAuthFailed(room: string, reason: string): void;
}

class LiveFileSystem implements vscode.FileSystemProvider {
  private readonly docs = new Map<string, LiveDoc>();
  /** sessions being opened — stat + readFile race for the same uri, one socket */
  private readonly opening = new Map<string, Promise<LiveDoc>>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly deps: LiveDeps;

  constructor(deps: LiveDeps) {
    this.deps = deps;
  }

  /** Room name = repo-qualified path = uri.path without the leading slash. */
  private ensure(uri: vscode.Uri): Promise<LiveDoc> {
    const name = uri.path.replace(/^\//, "");
    const existing = this.docs.get(name);
    if (existing) return Promise.resolve(existing);
    let opening = this.opening.get(name);
    if (!opening) {
      opening = this.open(name, uri).finally(() => this.opening.delete(name));
      this.opening.set(name, opening);
    }
    return opening;
  }

  private async open(name: string, uri: vscode.Uri): Promise<LiveDoc> {
    // one session (provider + its own socket) per live document — session.destroy()
    // tears BOTH down (the spike destroyed only providers and leaked the sockets)
    const session = openLiveSession({
      url: this.deps.wsUrl(),
      room: name,
      token: await this.deps.token(),
      WebSocketPolyfill: WebSocket,
      onAuthenticationFailed: (reason) => {
        // also fires on a RE-connect (a session expired mid-day): forget the doc
        // so the next open reconnects with a fresh credential
        if (this.docs.get(name)?.session === session) {
          this.docs.delete(name);
          session.destroy();
        }
        this.deps.onAuthFailed(name, reason);
      },
    });
    session.setUser(this.deps.presence());
    try {
      await session.whenSynced(10_000);
    } catch (err) {
      session.destroy(); // a failed session must not leak its socket either
      throw toFsError(err);
    }

    const ytext = session.content;
    const doc: LiveDoc = { session, ytext, mtime: Date.now() };
    ytext.observe(() => {
      doc.mtime = Date.now();
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    });
    this.docs.set(name, doc);
    return doc;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const doc = await this.ensure(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: doc.mtime, size: doc.ytext.length };
  }

  readDirectory(): [string, vscode.FileType][] {
    return []; // documents are opened directly by path (M1: tree from the workspace API)
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const doc = await this.ensure(uri);
    return new TextEncoder().encode(doc.ytext.toString());
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const doc = await this.ensure(uri);
    // minimal diff into the shared Y.Text (concept sync rule 2) — a full replace
    // would clobber concurrent remote edits; no-ops when the content matches
    updateText(doc.ytext, new TextDecoder().decode(content));
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("read/edit only");
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions("deletion goes through git releases");
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions("renames go through git releases");
  }

  /** drop every live session (provider AND socket); open editors reconnect
   *  on their next read/write with the then-current credential */
  closeAll(): void {
    for (const doc of this.docs.values()) doc.session.destroy();
    this.docs.clear();
  }

  dispose(): void {
    this.closeAll();
    this.emitter.dispose();
  }
}

function toFsError(err: unknown): vscode.FileSystemError {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("auth failed")
    ? vscode.FileSystemError.NoPermissions(message)
    : vscode.FileSystemError.Unavailable(message);
}

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration("bpmLive");
  const serverUrl = () => config().get<string>("serverUrl") ?? "http://localhost:8301";
  const auth = new LiveAuth(context, serverUrl, () => config().get<string>("token") ?? "demo");

  const fsProvider = new LiveFileSystem({
    wsUrl: () => hostUrls(serverUrl()).ws,
    token: () => auth.token(),
    presence: () => auth.presence(),
    onAuthFailed: (room, reason) => {
      void vscode.window
        .showErrorMessage(`BPM Live: access to ${room} denied (${reason}).`, "Sign in")
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand("bpmLive.login");
        });
    },
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const renderStatus = () => {
    const me = auth.me();
    const host = hostUrls(serverUrl()).http;
    status.text = me ? `$(account) BPM Live: @${me.login}` : "$(account) BPM Live: sign in";
    status.tooltip = me
      ? `Signed in to ${host} as ${me.name || me.login}`
      : `Sign in to the Live Host at ${host} (the dev token applies until then)`;
    status.command = me ? "bpmLive.open" : "bpmLive.login";
    status.show();
  };
  renderStatus();

  context.subscriptions.push(
    auth,
    status,
    auth.onDidChange(renderStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bpmLive")) renderStatus();
    }),
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    { dispose: () => fsProvider.dispose() },
    // the sign-in callback: <uriScheme>://miragon-gmbh.bpm-live/auth?code=…&state=…
    vscode.window.registerUriHandler({ handleUri: (uri) => auth.handleUri(uri) }),
    vscode.commands.registerCommand("bpmLive.login", async () => {
      try {
        const me = await auth.login();
        void vscode.window.showInformationMessage(`BPM Live: signed in as ${me.user.name || me.user.login}.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`BPM Live: sign-in failed — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("bpmLive.logout", async () => {
      await auth.logout();
      fsProvider.closeAll();
      void vscode.window.showInformationMessage("BPM Live: signed out.");
    }),
    vscode.commands.registerCommand("bpmLive.open", async () => {
      const { http } = hostUrls(serverUrl());
      const token = await auth.token();
      // the picker's data path is the host's overview: the repos this session
      // may write, then every model of every notation in the chosen one
      let repos: RepoInfo[];
      try {
        repos = await hostJson<RepoInfo[]>(`${http}/api/repos`, { token });
      } catch (err) {
        return offerSignIn(`could not list the repositories on ${http} — ${(err as Error).message}`);
      }
      const repoChoices = repoItems(repos);
      if (repoChoices.length === 0) {
        void vscode.window.showWarningMessage(`BPM Live: no repository with write access on ${http}.`);
        return;
      }
      const repo =
        repoChoices.length === 1
          ? repoChoices[0]?.value
          : (await vscode.window.showQuickPick(repoChoices, { placeHolder: "Repository" }))?.value;
      if (!repo) return;
      let models: ModelInfo[];
      try {
        models = await hostJson<ModelInfo[]>(`${http}/api/repos/${repo.fullName}/models`, { token });
      } catch (err) {
        return offerSignIn(`could not list the models of ${repo.fullName} — ${(err as Error).message}`);
      }
      const byHand = { label: "$(edit) Enter a path…", description: "repo-relative model path", value: undefined };
      const pick = await vscode.window.showQuickPick([...modelItems(models), byHand], {
        placeHolder: `Model in ${repo.fullName}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) return;
      const path =
        pick.value?.path ??
        (await vscode.window.showInputBox({
          prompt: `Model path in ${repo.fullName} (repo-relative)`,
          value: "processes/",
        }));
      if (!path) return;
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(modelUri(repo.fullName, path)));
    }),
  );

  function offerSignIn(message: string): void {
    void vscode.window.showErrorMessage(`BPM Live: ${message}`, "Sign in").then((choice) => {
      if (choice) void vscode.commands.executeCommand("bpmLive.login");
    });
  }
}

export function deactivate(): void {}
