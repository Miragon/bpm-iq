/**
 * Y.Text ↔ wardley-maps-modeler binding — the wardley adapter on the shared
 * DSL engine (dsl-sync.ts; the four rules live in model-sync.ts). The Miragon
 * renderer round-trips the OWM DSL losslessly (importDSL/exportDSL).
 *
 * The one wardley specific, from the modeler's own VS-Code-webview recipe:
 * config edits (axis labels via setEvolutionLabels) fire
 * `wardley.config.changed`, NOT `commandStack.changed` — observe both.
 */
import type * as Y from "yjs";

import { bindDslModeler, type DslModelerLike } from "./dsl-sync.ts";

export function bindWardley(
  modeler: DslModelerLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindDslModeler(
    modeler,
    ["commandStack.changed", "wardley.config.changed"],
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}
