/**
 * The ONE text codec of the Miragon JSON renderers: JSON text ⇄ the
 * schema-model's typed document. Both consumers of a renderer share it — the
 * SPA's live binding and the MCP-App widget's engine (both through the
 * spec's `load()`) — so a CAS save from the widget and the live export from
 * the web editor serialize the SAME bytes (serialize options drifting
 * between the two would show up as phantom diffs and break the widget's
 * byte-equality reconcile after a live outage).
 *
 * parseDocument is deliberately LENIENT (the modeler's own semantics): any
 * object migrates to a valid document with defaults — typing "{}" in the text
 * tab is a legal empty board, not a rejected edit. Only unparsable JSON and a
 * schema rejection are `ok: false` (the caller keeps its last good canvas).
 */
import type { DocumentCodec } from "@bpmiq/live-client/miragon-sync";

/** what every Miragon schema-model package exports
 *  (@miragon/team-topologies-schema-model, @miragon/context-maps-schema-model) */
export interface SchemaModel<D> {
  parseDocument(input: unknown): { ok: true; document: D } | { ok: false; error?: unknown };
  serializeDocument(document: D, pretty?: boolean): string;
}

export function schemaModelCodec<D>(schema: SchemaModel<D>): DocumentCodec {
  return {
    parse(text) {
      try {
        const parsed = schema.parseDocument(JSON.parse(text));
        return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: parsed.error };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    // deterministic, pretty — the modeler's house serialization
    serialize: (document) => schema.serializeDocument(document as D, true),
  };
}
