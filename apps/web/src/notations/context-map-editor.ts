/**
 * The Context Map editor ENGINE — loaded on demand by the manifest
 * (context-map.tsx). The Miragon context-maps-modeler (diagram-js) bound to
 * the shared Y.Text via bindContextMap; the schema-model codec
 * (lib/cm-codec.ts — shared with the MCP-App widget so both serialize the
 * same bytes) is injected so the live-client adapter never depends on the
 * renderer's packages.
 */
import "@miragon/context-maps-renderer/assets/context-maps.css";

import { bindContextMap } from "@bpmiq/live-client/context-map-sync";
import { Modeler } from "@miragon/context-maps-renderer";

import { cmCodec } from "@/lib/cm-codec";
import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountContextMapEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindContextMap(modeler as never, cmCodec, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
