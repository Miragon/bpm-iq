/**
 * The BPMN editor ENGINE — loaded on demand by the manifest (bpmn.tsx). One
 * bpmn-js modeler bound to the shared Y.Text (bindBpmn), with the todo canvas
 * attached for EVERY bpmn file, not only process members: the selection feeds
 * the todo buttons AND the Analyse-with-AI handover (a sub-process has no
 * process id, but its selection matters just the same). Badges re-attach on
 * every import.done (bindBpmn re-imports remote changes); without todos the
 * list stays empty and no badge ever renders.
 */
import { bindBpmn } from "@bpmiq/live-client/bpmn-sync";
import BpmnModeler from "bpmn-js/lib/Modeler";

import { attachTodoCanvas } from "@/lib/todo-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountBpmnEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new BpmnModeler({ container });
  const unbind = bindBpmn(modeler as never, ctx.ytext, ctx.doc, ctx.onSyncError);
  const todoCanvas = attachTodoCanvas(modeler as never, {
    onBadgeClick: ctx.onBadgeClick,
    onSelectionChanged: ctx.onSelectionChanged,
  });
  return {
    elements: todoCanvas,
    destroy: () => {
      todoCanvas.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
