/**
 * Y.Text ↔ DSL-modeler binding — the shared adapter for the Miragon
 * diagram-js modelers whose file format is a lossless line-DSL round-trip
 * (importDSL/exportDSL): wardley (OWM) and event storming (.storm). The
 * shared text lane carries the DSL directly; per notation only the CHANGE
 * EVENTS differ (wardley-sync, event-storming-sync).
 *
 * Two traits every such modeler shares, both from their VS-Code-webview
 * recipes:
 *  - importDSL runs commandStack.clear(), which EMITS 'changed' (unlike
 *    bpmn-js, which clears silently). Without suppression that echo would
 *    re-export the canvas's CANONICAL serialization after every import —
 *    reordering a hand-authored file on open and replacing half-typed Monaco
 *    text after every debounce. The reference webviews drop the echo the
 *    same way (`if (importing) return` in their pushEdit).
 *  - the DSLs are lenient by design (unknown lines are preserved), so the
 *    rule-4 pre-gate is "any non-empty text"; the parser stays the judge
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

export interface DslModelerLike {
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  importDSL(text: string): Promise<unknown>;
  exportDSL(): string;
}

export function bindDslModeler(
  modeler: DslModelerLike,
  /** the events after which the canvas is re-exported into the text lane */
  changeEvents: readonly string[],
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  let importing = false;
  return bindModelSync(
    {
      importText: async (text) => {
        importing = true;
        try {
          await modeler.importDSL(text);
        } finally {
          importing = false;
        }
      },
      exportText: async () => modeler.exportDSL(),
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
        for (const event of changeEvents) modeler.on(event, handler);
        return () => {
          for (const event of changeEvents) modeler.off(event, handler);
        };
      },
    },
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}
