/**
 * The BPMN web plugin MANIFEST — light, eager data. The engine (bpmn-js +
 * bindBpmn + the todo canvas) and the diagram differ load behind the dynamic
 * imports below, each as its own chunk.
 */
import { lazy } from "react";

import type { WebNotationPlugin } from "./registry";

export const bpmnPlugin: WebNotationPlugin = {
  id: "bpmn",
  canvasClassName: "bpmn-canvas",
  mountEditor: async (container, ctx) => {
    const { mountBpmnEditor } = await import("./bpmn-editor");
    return mountBpmnEditor(container, ctx);
  },
  assistNotation: "bpmn",
  diff: {
    component: lazy(() => import("./bpmn-diff").then((m) => ({ default: m.BpmnDiagramDiff }))),
    legend: [
      { label: "added", color: "var(--success)" },
      { label: "removed", color: "var(--destructive)" },
      { label: "changed", color: "var(--warning)" },
      { label: "moved", color: "var(--muted-foreground)" },
    ],
  },
};
