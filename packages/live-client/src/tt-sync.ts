/**
 * Y.Text ↔ team-topologies-modeler binding — the team-topology adapter on
 * the shared document engine (document-sync.ts; the four rules live in
 * model-sync.ts). The Miragon renderer works on a typed TtDocument, so the
 * text lane goes through the schema-model codec: parse (Zod-validated,
 * non-throwing) on the way in, deterministic serialize on the way out —
 * INJECTED by the caller so this package never depends on the renderer's
 * schema package.
 */
import type * as Y from "yjs";

import { bindDocumentModeler, type DocumentCodec, type DocumentModelerLike } from "./document-sync.ts";

export type TtCodec = DocumentCodec;

export function bindTeamTopology(
  modeler: DocumentModelerLike,
  codec: TtCodec,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindDocumentModeler(modeler, codec, "team-topology", ytext, doc, onConflict, onImportError);
}
