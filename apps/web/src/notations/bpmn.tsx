/**
 * The BPMN web plugin MANIFEST — light, eager data. The engine (bpmn-js +
 * bindBpmn + the todo canvas) and the diagram differ load behind the dynamic
 * imports below, each as its own chunk.
 */
import { StickyNote } from "lucide-react";
import { lazy } from "react";

import type { WebNotationPlugin } from "./registry";

const ModerationPanel = lazy(() =>
  import("@/components/moderation-panel").then((m) => ({ default: m.ModerationPanel })),
);

export const bpmnPlugin: WebNotationPlugin = {
  id: "bpmn",
  canvasClassName: "bpmn-canvas",
  mountEditor: async (container, ctx) => {
    const { mountBpmnEditor } = await import("./bpmn-editor");
    return mountBpmnEditor(container, ctx);
  },
  panels: [
    {
      id: "moderation",
      label: "Moderation",
      buttonTitle: "Stickies on this diagram, grouped by kind — the facilitator's t.BPM view",
      icon: StickyNote,
      component: ModerationPanel,
    },
  ],
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
