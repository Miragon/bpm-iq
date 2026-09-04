/**
 * Y.Text ↔ event-storming-modeler binding — the event storming adapter on
 * the shared DSL engine (dsl-sync.ts; the four rules live in model-sync.ts).
 * The Miragon renderer round-trips the .storm DSL losslessly
 * (importDSL/exportDSL), so the text tab and the board edit one document.
 *
 * Every board edit (stickies, arrows, drawings, pinning, colors) runs
 * through the command stack, and the board config (title, level, style) has
 * no editing surface on the canvas — `commandStack.changed` is the ONE
 * change event to observe.
 */
import type * as Y from "yjs";

import { bindDslModeler, type DslModelerLike } from "./dsl-sync.ts";

export function bindEventStorming(
  modeler: DslModelerLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindDslModeler(modeler, ["commandStack.changed"], ytext, doc, onConflict, onImportError);
}
