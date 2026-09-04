/**
 * The ONE Context Map text codec: JSON text ⇄ the schema-model's CmDocument.
 * Both consumers of the renderer share it — the SPA's live binding
 * (notations/context-map-editor.ts) and the MCP-App widget's engine
 * (mcp-app/engines/context-map.ts) — so a CAS save from the widget and the
 * live export from the web editor serialize the SAME bytes (the tt-codec
 * rule: serialize options drifting between the two would show up as phantom
 * diffs and break the widget's byte-equality reconcile after a live outage).
 *
 * parseDocument is deliberately LENIENT (the modeler's own semantics): any
 * object migrates to a valid document with defaults — typing "{}" in the text
 * tab is a legal empty map, not a rejected edit. Only unparsable JSON and a
 * schema rejection are `ok: false` (the caller keeps its last good canvas).
 */
import { type CmDocument, parseDocument, serializeDocument } from "@miragon/context-maps-schema-model";

export type CmCodecResult = { ok: true; document: CmDocument } | { ok: false; error?: unknown };

export const cmCodec = {
  parse(text: string): CmCodecResult {
    try {
      const parsed = parseDocument(JSON.parse(text));
      return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: parsed.error };
    } catch (e) {
      return { ok: false, error: e };
    }
  },
  /** deterministic, pretty — the modeler's house serialization */
  serialize(document: unknown): string {
    return serializeDocument(document as CmDocument, true);
  },
};
