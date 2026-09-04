/**
 * The Event Storming editor ENGINE — loaded on demand by the manifest
 * (event-storming.tsx). The Miragon event-storming-modeler (diagram-js)
 * bound to the shared Y.Text via bindEventStorming: the .storm DSL
 * round-trips losslessly (importDSL/exportDSL), so the text tab and the
 * board edit the same document.
 */
import "@miragon/event-storming-renderer/assets/event-storming.css";

import { bindEventStorming } from "@bpmiq/live-client/event-storming-sync";
import { Modeler } from "@miragon/event-storming-renderer";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountEventStormingEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindEventStorming(modeler as never, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
