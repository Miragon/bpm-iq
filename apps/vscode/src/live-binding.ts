/**
 * The M1 sync layer: a two-way binding between an OPEN TextDocument and its
 * room's Y.Text — the pattern the OCT VS Code extension verified.
 *
 *  - local → shared: every document change (typing, the Miragon modeler's
 *    WorkspaceEdits, a paste) is written into the Y.Text at once as a minimal
 *    diff (updateText, sync rule 2) — no waiting for a save; save is a no-op
 *  - shared → local: a remote transaction becomes ONE WorkspaceEdit replacing
 *    the changed middle (diffRegion), so the document keeps following the room
 *    while dirty — the spike relied on VS Code's auto-revert of CLEAN files,
 *    which stops after the first local edit
 *  - the document is kept clean: a live document has no "unsaved" state, the
 *    Live Host holds the working copy — so no save prompts for others' edits
 *
 * Echo prevention and the race: local pushes carry an origin the observer
 * skips; while an inbound edit is in flight (applyEdit is async), local
 * change events are ignored — they ARE the inbound edit. A keystroke landing
 * in exactly that window shows up as a document version beyond our own edit;
 * the document is then pushed as a whole (minimal diff), so the person's text
 * wins and both sides converge. A remote edit in that same few-ms window can
 * be reverted for the peer — the accepted v1 cost, the web app's y-monaco
 * binding has no such window (Monaco edits are synchronous with Yjs).
 */
import { diffRegion, updateText } from "@bpmiq/live-client/text";
import * as vscode from "vscode";
import type * as Y from "yjs";

/** transaction origin of our own pushes — the observer skips them */
const LOCAL = { source: "bpm-live/vscode" };
const SAVE_DEBOUNCE_MS = 300;

export class LiveBinding implements vscode.Disposable {
  private readonly doc: vscode.TextDocument;
  private readonly ytext: Y.Text;
  private readonly subscription: vscode.Disposable;
  private readonly observer: (event: Y.YTextEvent, txn: Y.Transaction) => void;
  private applying = false;
  private pendingRemote = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(doc: vscode.TextDocument, ytext: Y.Text) {
    this.doc = doc;
    this.ytext = ytext;
    this.subscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== this.doc || this.applying || e.contentChanges.length === 0) return;
      this.push();
    });
    this.observer = (_event, txn) => {
      if (txn.origin === LOCAL) return;
      void this.pull();
    };
    ytext.observe(this.observer);
    // the document may already differ (opened before the binding attached)
    if (doc.getText() !== ytext.toString()) void this.pull();
  }

  /** local → shared: the whole document as a minimal diff */
  private push(): void {
    updateText(this.ytext, this.doc.getText(), LOCAL);
    this.keepClean();
  }

  /** shared → local: one replace of the changed middle; loops while remote
   *  changes keep arriving during the apply */
  private async pull(): Promise<void> {
    if (this.applying) {
      this.pendingRemote = true;
      return;
    }
    this.applying = true;
    try {
      for (let round = 0; round < 8 && !this.disposed; round++) {
        this.pendingRemote = false;
        const prev = this.doc.getText();
        const next = this.ytext.toString();
        if (prev === next) break;
        const { start, endPrev, endNext } = diffRegion(prev, next);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this.doc.uri,
          new vscode.Range(this.doc.positionAt(start), this.doc.positionAt(endPrev)),
          next.slice(start, endNext),
        );
        const version = this.doc.version;
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) break; // closed or refused — the next remote change retries
        if (this.doc.version > version + 1) {
          // a local edit landed inside the apply window — the person's text
          // wins: push the document as it is now (folds the remote edit in)
          this.applying = false;
          this.push();
          return;
        }
        if (!this.pendingRemote) break;
      }
    } finally {
      this.applying = false;
    }
    this.keepClean();
    if (this.pendingRemote) void this.pull();
  }

  /** a live document never stays dirty — save (a no-op write) once it settles */
  private keepClean(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (!this.disposed && this.doc.isDirty && !this.doc.isClosed) void this.doc.save();
    }, SAVE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.ytext.unobserve(this.observer);
    this.subscription.dispose();
  }
}
