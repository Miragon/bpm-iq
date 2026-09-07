/**
 * The editor ENGINE of every Miragon renderer — loaded on demand by the
 * manifest (plugin.ts) together with the spec's `load()`: the renderer's
 * Modeler bound to the shared Y.Text through live-client's miragon-sync (the
 * spec's text lane decides how), with live presence attached.
 */
import { bindMiragon } from "@bpmiq/live-client/miragon-sync";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "../registry";
import type { LoadedMiragonRenderer } from "./spec";

export function mountMiragonEditor(
  renderer: LoadedMiragonRenderer,
  container: HTMLElement,
  ctx: EditorContext,
): MountedEditor {
  const modeler = new renderer.Modeler({ container });
  const unbind = bindMiragon(modeler, renderer.lane, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
