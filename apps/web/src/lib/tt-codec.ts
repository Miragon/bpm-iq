/**
 * The ONE Team-Topology text codec: JSON text ⇄ the schema-model's TtDocument.
 * Both consumers of the renderer share it — the SPA's live binding
 * (notations/team-topology-editor.ts) and the MCP-App widget's engine
 * (mcp-app/engines/team-topology.ts) — so a CAS save from the widget and the
 * live export from the web editor serialize the SAME bytes (serialize
 * options drifting between the two would show up as phantom diffs and break
 * the widget's byte-equality reconcile after a live outage).
 *
 * parseDocument is deliberately LENIENT (the modeler's own semantics): any
 * object migrates to a valid document with defaults — typing "{}" in the text
 * tab is a legal empty board, not a rejected edit. Only unparsable JSON and a
 * schema rejection are `ok: false` (the caller keeps its last good canvas).
 */
import { parseDocument, serializeDocument, type TtDocument } from "@miragon/team-topologies-schema-model";

export type TtCodecResult = { ok: true; document: TtDocument } | { ok: false; error?: unknown };

export const ttCodec = {
  parse(text: string): TtCodecResult {
    try {
      const parsed = parseDocument(JSON.parse(text));
      return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: parsed.error };
    } catch (e) {
      return { ok: false, error: e };
    }
  },
  /** deterministic, pretty — the modeler's house serialization */
  serialize(document: unknown): string {
    return serializeDocument(document as TtDocument, true);
  },
};
