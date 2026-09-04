/**
 * The Context Map editor ENGINE — loaded on demand by the manifest
 * (context-map.tsx). The Miragon context-maps-modeler (diagram-js) bound to
 * the shared Y.Text via bindContextMap; the schema-model codec
 * (Zod-validated, migrating parse, deterministic serialize) is injected so
 * the shared live-client adapter never depends on the renderer's packages.
 */
import "@miragon/context-maps-renderer/assets/context-maps.css";

import { bindContextMap } from "@bpmiq/live-client/context-map-sync";
import { Modeler } from "@miragon/context-maps-renderer";
import { type CmDocument, parseDocument, serializeDocument } from "@miragon/context-maps-schema-model";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountContextMapEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindContextMap(
    modeler as never,
    {
      // parseDocument is deliberately LENIENT (the modeler's own semantics):
      // any object migrates to a valid document with defaults — typing "{}"
      // in the text tab is a legal empty map, not a rejected edit
      parse: (text) => {
        try {
          const parsed = parseDocument(JSON.parse(text));
          return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: parsed.error };
        } catch (e) {
          return { ok: false, error: e };
        }
      },
      serialize: (document) => serializeDocument(document as CmDocument, true),
    },
    ctx.ytext,
    ctx.doc,
    ctx.onSyncError,
    ctx.onImportFailed,
  );
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
