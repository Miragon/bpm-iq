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
 * yields is the ws token AND the REST bearer. A LIVE_AUTH=none host needs no
 * sign-in (everyone is its local principal). Presence: every live document
 * announces the identity the host reports in the room's roster.
 *
 * Sync (the M1 layer, live-binding.ts): an OPEN document is bound two-way to
 * its room — local changes go into the shared Y.Text at once as minimal diffs
 * (sync rule 2, the same updateText the web app uses), remote transactions
 * come back as WorkspaceEdits, dirty or not, and the document is kept clean.
 * Documents nobody has open only exist on the host; writeFile (a save) is the
 * same minimal diff, a no-op once bound.
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
import { LiveBinding } from "./live-binding.ts";
import { hostUrls } from "./login-flow.ts";
import { modelItems, modelUri, repoItems } from "./model-picker.ts";

const SCHEME = "bpm-live";

/** room name = repo-qualified path = uri.path without the leading slash */
const roomOf = (uri: vscode.Uri): string => uri.path.replace(/^\//, "");

interface LiveDoc {
  session: LiveSession;
  ytext: Y.Text;
  mtime: number;
}

/** what the file system needs from the outside — connection + identity */
interface LiveDeps {
  wsUrl(): string;
  token(): Promise<string>;
  presence(): Promise<PresenceUser>;
  /** the host refused our credential (expired session, or not signed in to an authenticated host) */
  onAuthFailed(room: string, reason: string): void;
}

class LiveFileSystem implements vscode.FileSystemProvider {
  private readonly docs = new Map<string, LiveDoc>();
  /** sessions being opened — stat + readFile race for the same uri, one socket */
  private readonly opening = new Map<string, Promise<LiveDoc>>();
  /** open TextDocuments bound two-way to their room (live-binding.ts), by room */
  private readonly bindings = new Map<string, LiveBinding>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly deps: LiveDeps;

  constructor(deps: LiveDeps) {
    this.deps = deps;
  }

  private ensure(uri: vscode.Uri): Promise<LiveDoc> {
    const name = roomOf(uri);
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
    // credential + the identity the host assigns it (one /api/me per credential)
    const [token, presence] = await Promise.all([this.deps.token(), this.deps.presence()]);
    // one session (provider + its own socket) per live document — session.destroy()
    // tears BOTH down (the spike destroyed only providers and leaked the sockets)
    const session = openLiveSession({
      url: this.deps.wsUrl(),
      room: name,
      token,
      WebSocketPolyfill: WebSocket,
      onAuthenticationFailed: (reason) => {
        // also fires on a RE-connect (a session expired mid-day): forget the doc
        // so the next open reconnects with a fresh credential
        if (this.docs.get(name)?.session === session) {
          this.docs.delete(name);
          this.detach(name);
          session.destroy();
        }
        this.deps.onAuthFailed(name, reason);
      },
    });
    session.setUser(presence);
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
      // a bound document follows the room itself (WorkspaceEdit); the Changed
      // event would make VS Code re-read a CLEAN file on top of that
      if (!this.bindings.has(name)) this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    });
    this.docs.set(name, doc);
    // a document already open on this uri (a session re-opened after sign-out
    // or an auth failure) gets its binding back
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === SCHEME && roomOf(d.uri) === name);
    if (openDoc) this.attach(name, openDoc, ytext);
    return doc;
  }

  private attach(name: string, textDoc: vscode.TextDocument, ytext: Y.Text): void {
    if (this.bindings.has(name) || textDoc.isClosed) return;
    this.bindings.set(name, new LiveBinding(textDoc, ytext));
  }

  private detach(name: string): void {
    this.bindings.get(name)?.dispose();
    this.bindings.delete(name);
  }

  /** an opened TextDocument of ours → bind it two-way to its room */
  async bind(textDoc: vscode.TextDocument): Promise<void> {
    if (textDoc.uri.scheme !== SCHEME) return;
    const doc = await this.ensure(textDoc.uri);
    this.attach(roomOf(textDoc.uri), textDoc, doc.ytext);
  }

  /** a closed TextDocument of ours → drop the binding (the session stays for
   *  the next open; closeAll() ends it) */
  unbind(textDoc: vscode.TextDocument): void {
    if (textDoc.uri.scheme !== SCHEME) return;
    this.detach(roomOf(textDoc.uri));
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
    for (const name of this.bindings.keys()) this.detach(name);
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
  const auth = new LiveAuth(context, serverUrl);

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
  /** the identity the HOST reports for our credential: the signed-in person,
   *  a none-mode host's local principal, or nobody (→ offer the sign-in) */
  const renderStatus = async () => {
    const host = hostUrls(serverUrl()).http;
    const me = await auth.identity();
    status.text = me ? `$(account) BPM Live: @${me.login}` : "$(account) BPM Live: sign in";
    status.tooltip = !me
      ? `Sign in to the Live Host at ${host}`
      : me.provider === "local"
        ? `${host} runs without authentication — you are @${me.login}`
        : `Signed in to ${host} as ${me.name || me.login}`;
    status.command = me ? "bpmLive.open" : "bpmLive.login";
    status.show();
  };
  void renderStatus();
  /** (re)connect every open live document — at activation (a restored window)
   *  and after a credential change, so open editors move to the new identity */
  const rebindOpen = () => {
    fsProvider.closeAll();
    for (const d of vscode.workspace.textDocuments) void fsProvider.bind(d);
  };
  rebindOpen();

  context.subscriptions.push(
    auth,
    status,
    auth.onDidChange(() => void renderStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bpmLive")) void renderStatus();
    }),
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    { dispose: () => fsProvider.dispose() },
    // the live binding follows the document lifecycle
    vscode.workspace.onDidOpenTextDocument((d) => void fsProvider.bind(d)),
    vscode.workspace.onDidCloseTextDocument((d) => fsProvider.unbind(d)),
    // the sign-in callback: <uriScheme>://miragon-gmbh.bpm-live/auth?code=…&state=…
    vscode.window.registerUriHandler({ handleUri: (uri) => auth.handleUri(uri) }),
    vscode.commands.registerCommand("bpmLive.login", async () => {
      try {
        const me = await auth.login();
        rebindOpen();
        void vscode.window.showInformationMessage(`BPM Live: signed in as ${me.user.name || me.user.login}.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`BPM Live: sign-in failed — ${(err as Error).message}`);
      }
    }),
    // the manual route: a session token pasted from a browser login — for hosts
    // without the editor sign-in (older Live Hosts), or when no browser can
    // reach this editor's URI scheme
    vscode.commands.registerCommand("bpmLive.loginWithToken", async () => {
      const { http } = hostUrls(serverUrl());
      const token = await vscode.window.showInputBox({
        prompt: `Session token for ${http}: sign in there in the browser, open ${http}/api/me and paste its wsToken`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) return;
      try {
        const me = await auth.useToken(token.trim());
        rebindOpen();
        void vscode.window.showInformationMessage(`BPM Live: signed in as ${me.user.name || me.user.login}.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`BPM Live: the token was not accepted — ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("bpmLive.logout", async () => {
      await auth.logout();
      rebindOpen();
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
