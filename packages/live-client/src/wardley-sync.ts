/**
 * Y.Text ↔ wardley-maps-modeler binding — the wardley adapter for the shared
 * sync engine (model-sync.ts, the four rules). The Miragon renderer is a
 * diagram-js modeler with a lossless OWM-DSL round-trip (importDSL/exportDSL),
 * so the shared text lane carries the DSL directly.
 *
 * Two wardley specifics, both from the modeler's own VS-Code-webview recipe:
 *  - config edits (axis labels via setEvolutionLabels) fire
 *    `wardley.config.changed`, NOT `commandStack.changed` — observe both
 *  - the OWM DSL is lenient by design (unknown lines are preserved), so the
 *    rule-4 pre-gate is "any non-empty text"; the parser stays the judge
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

interface WardleyModelerLike {
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  importDSL(text: string): Promise<unknown>;
  exportDSL(): string;
}

export function bindWardley(
  modeler: WardleyModelerLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  // importDSL runs commandStack.clear(), which EMITS 'changed' (unlike
  // bpmn-js, which clears silently). Without suppression that echo would
  // re-export the canvas's CANONICAL serialization after every import —
  // reordering a hand-authored file on open and replacing half-typed Monaco
  // text after every debounce. The reference webview drops the echo the same
  // way (`if (importing) return` in its pushEdit).
  let importing = false;
  return bindModelSync(
    {
      importXML: async (text) => {
        importing = true;
        try {
          await modeler.importDSL(text);
        } finally {
          importing = false;
        }
      },
      saveXML: async () => modeler.exportDSL(),
      looksRenderable: (text) => text.trim().length > 0,

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
        const handler = (): void => {
          if (!importing) onChanged();
        };
        modeler.on("commandStack.changed", handler);
        modeler.on("wardley.config.changed", handler);
        return () => {
          modeler.off("commandStack.changed", handler);
          modeler.off("wardley.config.changed", handler);
        };
      },
    },
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}
