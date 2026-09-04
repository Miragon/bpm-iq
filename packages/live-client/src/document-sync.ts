/**
 * Y.Text ↔ document-modeler binding — the shared adapter for the Miragon
 * diagram-js modelers whose file format is ONE JSON document with a
 * schema-model codec (importDocument/exportDocument): team topology (.tt)
 * and context map (.cm.json). The shared text lane carries the JSON; the
 * codec — Zod-validated, non-throwing parse on the way in, deterministic
 * serialize on the way out — is INJECTED by the caller so this package never
 * depends on a renderer's schema package. Per notation only the module name
 * differs (tt-sync, context-map-sync); the traits are shared:
 *  - importDocument replaces every shape but leaves the command stack
 *    UNTOUCHED — an undo would then operate on stale, removed objects
 *    (silent no-ops, id-coincidence deletions). History is erased like
 *    bpmn-js does on import, silently (clear(false): no 'changed' echo).
 *  - the codec's parse IS the rule-4 pre-gate: a half-typed JSON keeps the
 *    last good canvas without an import round-trip.
 *  - every canvas edit runs through the command stack, and the document
 *    meta (title) has no editing surface on the canvas — commandStack.changed
 *    is the ONE change event to observe.
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

export interface DocumentModelerLike {
  get(service: "commandStack"): { clear(emitChanged?: boolean): void };
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  importDocument(document: unknown): unknown;
  exportDocument(): unknown;
}

export interface DocumentCodec {
  /** non-throwing parse — `ok: false` keeps the last good canvas (rule 4) */
  parse(text: string): { ok: true; document: unknown } | { ok: false; error?: unknown };
  /** deterministic serialization (diff-friendly, the modeler's house rule) */
  serialize(document: unknown): string;
}

export function bindDocumentModeler(
  modeler: DocumentModelerLike,
  codec: DocumentCodec,
  /** the notation's noun for the rejection message, e.g. "team-topology" */
  notation: string,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindModelSync(
    {
      importText: async (text) => {
        const parsed = codec.parse(text);
        if (!parsed.ok) throw new Error(`not a ${notation} document: ${String(parsed.error ?? "parse failed")}`);
        modeler.importDocument(parsed.document);
        // the renderer's importDocument replaces every shape but leaves the
        // command stack UNTOUCHED — erase history like bpmn-js does on
        // import, silently (no 'changed' echo)
        modeler.get("commandStack").clear(false);
      },
      exportText: async () => codec.serialize(modeler.exportDocument()),
      // rule-4 pre-gate: the codec's Zod parse IS the gate — run it cheaply
      // here so a half-typed JSON keeps the last good canvas without an
      // import round-trip
      looksRenderable: (text) => codec.parse(text).ok,

      beforeImport(isFirstImport) {
        const canvas = modeler.get("canvas");
        let viewbox: { x: number; y: number; width: number; height: number } | undefined;
        try {
          viewbox = canvas.viewbox();
        } catch {
          /* first import: no viewbox yet */
        }
        return () => {
          if (viewbox && viewbox.width > 0 && !isFirstImport) canvas.viewbox(viewbox);
          else canvas.zoom("fit-viewport");
        };
      },

      observeModel(onChanged) {
        modeler.on("commandStack.changed", onChanged);
        return () => modeler.off("commandStack.changed", onChanged);
      },
    },
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}
