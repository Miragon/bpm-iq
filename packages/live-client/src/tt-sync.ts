/**
 * Y.Text ↔ team-topologies-modeler binding — the team-topology adapter for
 * the shared sync engine (model-sync.ts, the four rules). The Miragon
 * renderer works on a typed TtDocument, so the text lane goes through the
 * schema-model codec: parse (Zod-validated, non-throwing) on the way in,
 * deterministic serialize on the way out — INJECTED by the caller so this
 * package never depends on the renderer's schema package.
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

interface TtModelerLike {
  get(service: "commandStack"): { clear(emitChanged?: boolean): void };
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  importDocument(document: unknown): unknown;
  exportDocument(): unknown;
}

export interface TtCodec {
  /** non-throwing parse — `ok: false` keeps the last good canvas (rule 4) */
  parse(text: string): { ok: true; document: unknown } | { ok: false; error?: unknown };
  /** deterministic serialization (diff-friendly, the modeler's house rule) */
  serialize(document: unknown): string;
}

export function bindTeamTopology(
  modeler: TtModelerLike,
  codec: TtCodec,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindModelSync(
    {
      importText: async (text) => {
        const parsed = codec.parse(text);
        if (!parsed.ok) throw new Error(`not a team-topology document: ${String(parsed.error ?? "parse failed")}`);
        modeler.importDocument(parsed.document);
        // the renderer's importDocument replaces every shape but leaves the
        // command stack UNTOUCHED — an undo would then operate on stale,
        // removed objects (silent no-ops, id-coincidence deletions). Erase
        // history like bpmn-js does on import, silently (no 'changed' echo).
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
