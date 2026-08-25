/**
 * The DMN web plugin MANIFEST — light, eager data. The engine (dmn-js + the
 * simulation add-on + bindDmn) loads behind the dynamic import; the Checks
 * panel (FEEL engine + DMN parser via @bpmiq/decisions) stays its own lazy
 * chunk — only a .dmn author who OPENS the panel pays for it.
 */
import { ShieldCheck } from "lucide-react";
import { lazy } from "react";

import type { NotationPanelProps, WebNotationPlugin } from "./registry";

const ChecksPanel = lazy(() =>
  import("@/components/decision-checks-panel").then((m) => ({
    // adapter: the generic panel feed (content) is the panel's xml
    default: (p: NotationPanelProps) => (
      <m.DecisionChecksPanel repo={p.repo} xml={p.content} docPath={p.docPath} onClose={p.onClose} />
    ),
  })),
);

export const dmnPlugin: WebNotationPlugin = {
  id: "dmn",
  canvasClassName: "dmn-canvas",
  mountEditor: async (container, ctx) => {
    const { mountDmnEditor } = await import("./dmn-editor");
    return mountDmnEditor(container, ctx);
  },
  assistNotation: "dmn",
  panels: [
    {
      id: "checks",
      label: "Checks",
      buttonTitle: "Analyse this decision and try a scenario — runs in the browser",
      icon: ShieldCheck,
      component: ChecksPanel,
    },
  ],
};
