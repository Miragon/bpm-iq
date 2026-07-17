/**
 * Y.Text ↔ visual-modeler sync engine — the four sync rules from
 * docs/platform-concept.md, notation-agnostic:
 *
 *  1. one pinned modeler version across all clients (package.json)
 *  2. minimal diffs into Y.Text, never replace-all (common prefix/suffix trim)
 *  3. debounced re-import of remote changes with view-state restore and echo
 *     suppression (Yjs transaction origin + last-export equality)
 *  4. validate merged XML before import; keep rendering the last good state on
 *     rare invalid interleavings — the next update usually heals the document
 *
 * What differs per notation (how change events are observed, how the view
 * state survives a re-import) lives in a SyncAdapter; bpmn-sync and dmn-sync
 * are the two adapters. Consumers import those, never this module.
 */
import type * as Y from "yjs";

import { diffRegion } from "./text-diff.ts";

/** Shared origin marker: transactions tagged with it are our own canvas edits. */
export const CANVAS_ORIGIN = "bpm-canvas";

export interface SyncAdapter {
  /** parse + render `xml`; a rejection keeps the last good state (rule 4) */
  importXML(xml: string): Promise<unknown>;
  /** serialize the current model, formatted */
  saveXML(): Promise<string | undefined>;
  /**
   * snapshot the view state right before an import; returns the restore to
   * run after the import succeeded
   */
  beforeImport(isFirstImport: boolean): () => void;
  /** subscribe to local model-change events; returns the unsubscribe */
  observeModel(onChanged: () => void): () => void;
}

export function bindModelSync(
  adapter: SyncAdapter,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  /**
   * fires when the FIRST import fails (the document is malformed from the
   * start — there is no last good state to keep rendering), at most once until
   * an import succeeds; later rejections are transient interleavings that the
   * next update usually heals, those stay on the console
   */
  onImportError?: (message: string) => void,
): () => void {
  let importing = false;
  let lastExport = "";
  let lastLocalEdit = 0;
  let pendingLocalExport = false;
  let importErrorReported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const looksValidXml = (s: string): boolean =>
    s.trim().length > 0 &&
    new DOMParser().parseFromString(s, "application/xml").getElementsByTagName("parsererror").length === 0;

  async function importFromY(): Promise<void> {
    // Local edits win: importXML replaces the whole canvas, so an in-flight user
    // edit would be lost. Wait for a short quiet period — the local edit exports
    // into ytext first, and the next observer round imports the merged state.
    if (Date.now() - lastLocalEdit < 600) {
      scheduleImport();
      return;
    }
    const xml = ytext.toString();
    if (xml === lastExport) return; // echo of our own edit
    if (!looksValidXml(xml)) return; // rule 4: keep last good canvas, wait for next update
    importing = true;
    try {
      const isFirstImport = lastExport === "";
      const restoreView = adapter.beforeImport(isFirstImport);
      await adapter.importXML(xml);
      restoreView();
      lastExport = xml;
      importErrorReported = false;
    } catch (err) {
      console.warn("[bpm-live] remote XML not importable, keeping last good state", err);
      if (lastExport === "" && !importErrorReported) {
        importErrorReported = true;
        onImportError?.(err instanceof Error ? err.message : String(err));
      }
    } finally {
      importing = false;
      if (pendingLocalExport) {
        // a canvas edit landed while we were importing — never swallow it,
        // re-export now (no-ops if the import made it obsolete)
        pendingLocalExport = false;
        void onModelChanged();
      }
    }
  }

  const scheduleImport = (): void => {
    clearTimeout(timer);
    timer = setTimeout(importFromY, 350);
  };

  const observer = (_event: unknown, tx: { origin: unknown }): void => {
    if (tx.origin !== CANVAS_ORIGIN) scheduleImport();
  };
  ytext.observe(observer as never);

  const onModelChanged = async (): Promise<void> => {
    if (importing) {
      // fires for the commandStack 'clear' of our own importXML (harmless no-op
      // on re-run) AND for real user edits racing the import. Known limit of
      // text-level sync: an edit landing inside the ~10ms importXML window is
      // replaced along with the model (v2 operation-level sync removes this).
      pendingLocalExport = true;
      lastLocalEdit = Date.now();
      return;
    }
    lastLocalEdit = Date.now();
    const xml = await adapter.saveXML();
    if (!xml || xml === lastExport) return;
    applyLocalEdit(xml);
  };
  const unobserveModel = adapter.observeModel(() => void onModelChanged());

  /**
   * Rule 2, merge-aware: export the canvas edit as a diff against the canvas's
   * LAST serialization (lastExport), never against the live ytext. If remote
   * edits arrived in between, a plain ytext diff would isolate exactly the
   * colleague's change as "the differing middle" and delete it — silent data
   * loss inside the debounce window. Instead the local change region is located
   * in the current text by its surrounding context; disjoint edits merge, a
   * true overlap keeps the remote edit and reports the conflict.
   */
  function applyLocalEdit(next: string): void {
    const base = lastExport;
    const current = ytext.toString();

    if (current === base) {
      // no concurrent remote change — plain minimal diff
      const { start, endPrev, endNext } = diffRegion(base, next);
      doc.transact(() => {
        if (endPrev > start) ytext.delete(start, endPrev - start);
        if (endNext > start) ytext.insert(start, next.slice(start, endNext));
      }, CANVAS_ORIGIN);
      lastExport = next;
      return;
    }

    // remote edits landed since our last sync — merge if regions are disjoint.
    // Locate the local change region in the current text by its surrounding
    // context; wide context first (position safety), shrinking so that a nearby
    // -but-disjoint remote edit inside the window doesn't masquerade as overlap.
    const { start, endPrev, endNext } = diffRegion(base, next);
    const delText = base.slice(start, endPrev);
    const insText = next.slice(start, endNext);
    for (const ctx of [64, 32, 16, 8]) {
      const ctxL = base.slice(Math.max(0, start - ctx), start);
      const ctxR = base.slice(endPrev, endPrev + ctx);
      const needle = ctxL + delText + ctxR;
      const at = current.indexOf(needle);
      if (at < 0 || current.indexOf(needle, at + 1) >= 0) continue; // absent or ambiguous
      const pos = at + ctxL.length;
      doc.transact(() => {
        if (delText) ytext.delete(pos, delText.length);
        if (insText) ytext.insert(pos, insText);
      }, CANVAS_ORIGIN);
      // canvas still lacks the remote part — bring it in on the next quiet moment
      lastExport = next;
      scheduleImport();
      return;
    }

    // overlapping edits: the remote change wins, the local canvas op is undone —
    // explicitly, not silently (rule 4 fallback semantics)
    onConflict?.(
      "Gleichzeitige Änderung am selben Element — deine letzte Aktion wurde durch die Änderung einer Kollegin/eines Kollegen ersetzt.",
    );
    pendingLocalExport = false;
    lastLocalEdit = 0; // bypass the quiet period: re-import now
    void importFromY();
  }

  void importFromY();

  return () => {
    ytext.unobserve(observer as never);
    unobserveModel();
    clearTimeout(timer);
  };
}
