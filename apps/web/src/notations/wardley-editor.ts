/**
 * The Wardley editor ENGINE — loaded on demand by the manifest (wardley.tsx).
 * The Miragon wardley-maps-modeler (diagram-js) bound to the shared Y.Text
 * via bindWardley: the OWM DSL round-trips losslessly (importDSL/exportDSL),
 * so the text tab and the canvas edit the same document.
 */
import "@miragon/wardley-renderer/assets/wardley.css";

import { bindWardley } from "@bpmiq/live-client/wardley-sync";
import { Modeler } from "@miragon/wardley-renderer";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountWardleyEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindWardley(modeler as never, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
