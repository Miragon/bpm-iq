/**
 * Y.Text ↔ bpmn-js binding — the bpmn adapter for the shared sync engine
 * (model-sync.ts, the four rules from docs/platform-concept.md). bpmn-js is a
 * single-view modeler: one command stack on the modeler's event bus, one
 * diagram-js canvas whose viewbox survives a re-import.
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

interface ModelerLike {
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
  importXML(xml: string): Promise<unknown>;
  saveXML(options: { format: boolean }): Promise<{ xml?: string }>;
}

export function bindBpmn(
  modeler: ModelerLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
): () => void {
  return bindModelSync(
    {
      importXML: (xml) => modeler.importXML(xml),
      saveXML: async () => (await modeler.saveXML({ format: true })).xml,

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
  );
}
