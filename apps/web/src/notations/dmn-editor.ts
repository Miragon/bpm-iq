/**
 * The DMN editor ENGINE — loaded on demand by the manifest (dmn.tsx). One
 * dmn-js modeler (DRD + decision table + literal expression) with the SAME
 * simulation add-on the MCP-App decision widget mounts: enter values in a
 * decision table and the matching rows light up. It evaluates with `feelin`,
 * as does @bpmiq/decisions in the Checks panel and on the server — one
 * semantics, three places.
 */
import { bindDmn } from "@bpmiq/live-client/dmn-sync";
import DmnModeler from "dmn-js/lib/Modeler";

import { dmnSimulationViews } from "@/lib/dmn-simulation";

import type { EditorContext, MountedEditor } from "./registry";

export function mountDmnEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new DmnModeler({ container, ...dmnSimulationViews });
  const unbind = bindDmn(
    modeler as never,
    ctx.ytext,
    ctx.doc,
    ctx.onSyncError,
    // malformed from the start: nothing to render — surface the error and
    // fall back to the text view, where the document stays editable
    ctx.onImportFailed,
  );
  return {
    destroy: () => {
      unbind();
      modeler.destroy();
    },
  };
}
