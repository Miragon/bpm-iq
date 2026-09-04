/**
 * Y.Text ↔ context-maps-modeler binding — the context-map adapter on the
 * shared document engine (document-sync.ts; the four rules live in
 * model-sync.ts). The Miragon renderer works on a typed CmDocument, so the
 * text lane goes through the schema-model codec: parse (Zod-validated,
 * non-throwing, migrating) on the way in, deterministic serialize (sorted by
 * id, rounded, version-stamped) on the way out — INJECTED by the caller so
 * this package never depends on the renderer's schema package.
 */
import type * as Y from "yjs";

import { bindDocumentModeler, type DocumentCodec, type DocumentModelerLike } from "./document-sync.ts";

export type ContextMapCodec = DocumentCodec;

export function bindContextMap(
  modeler: DocumentModelerLike,
  codec: ContextMapCodec,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  return bindDocumentModeler(modeler, codec, "context-map", ytext, doc, onConflict, onImportError);
}
