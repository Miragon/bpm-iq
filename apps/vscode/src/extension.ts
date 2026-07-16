/**
 * M0 spike skeleton — the "thin client" from the platform concept (revision 2):
 * no Live-Share clone, just a FileSystemProvider for `bpm-live://` whose file
 * contents are bound to the Live Host's Y.Text documents.
 *
 * The Miragon BPMN Modeler (a CustomTextEditorProvider matching *.bpmn by glob,
 * scheme-independent) opens these virtual documents like any other file.
 *
 * Spike scope, documented limits:
 *  - writeFile applies a minimal diff into the shared Y.Text (concept sync rule 2,
 *    via @bpmiq/live-client updateText — same rule as the web app)
 *  - remote changes reach VS Code via FileChangeType.Changed; VS Code re-reads the
 *    file only while the local document is not dirty. Live two-way binding into a
 *    dirty open document is the M1 sync layer (WorkspaceEdit application), the
 *    verified pattern of the OCT VS Code extension.
 */
import { type LiveSession, openLiveSession } from "@bpmiq/live-client";
import { updateText } from "@bpmiq/live-client/text";
import * as vscode from "vscode";
import WebSocket from "ws";
import type * as Y from "yjs";

const SCHEME = "bpm-live";

interface LiveDoc {
  session: LiveSession;
  ytext: Y.Text;
  mtime: number;
}

class LiveFileSystem implements vscode.FileSystemProvider {
  private readonly docs = new Map<string, LiveDoc>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly getConfig: () => { serverUrl: string; token: string }) {}

  /** Room name = repo-relative path = uri.path without the leading slash. */
  private async ensure(uri: vscode.Uri): Promise<LiveDoc> {
    const name = uri.path.replace(/^\//, "");
    const existing = this.docs.get(name);
    if (existing) return existing;

    const { serverUrl, token } = this.getConfig();
    // one session (provider + its own socket) per live document — session.destroy()
    // tears BOTH down (the spike destroyed only providers and leaked the sockets)
    const session = openLiveSession({ url: serverUrl, room: name, token, WebSocketPolyfill: WebSocket });
    try {
      await session.whenSynced(10_000);
    } catch (err) {
      session.destroy(); // a failed session must not leak its socket either
      throw err;
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
    return []; // spike: documents are opened directly by path (M1: tree from the workspace API)
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

  dispose(): void {
    for (const doc of this.docs.values()) doc.session.destroy(); // provider AND socket
    this.docs.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const fsProvider = new LiveFileSystem(() => {
    const cfg = vscode.workspace.getConfiguration("bpmLive");
    return {
      serverUrl: cfg.get<string>("serverUrl") ?? "ws://localhost:8301",
      token: cfg.get<string>("token") ?? "demo",
    };
  });

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    { dispose: () => fsProvider.dispose() },
    vscode.commands.registerCommand("bpmLive.open", async () => {
      const path = await vscode.window.showInputBox({
        prompt: "Model path on the Live Host: <owner>/<repo>/<repo-relative-path>",
        value: "Miragon/bpm-iq/process-documentation/processes/order-to-cash/order-to-cash.bpmn",
      });
      if (!path) return;
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(`${SCHEME}:/${path}`));
    }),
  );
}

export function deactivate(): void {}
