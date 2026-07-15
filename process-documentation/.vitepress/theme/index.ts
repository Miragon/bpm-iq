import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

// Viewer styles (the components themselves load their libraries client-side only).
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import "dmn-js/dist/assets/diagram-js.css";
import "dmn-js/dist/assets/dmn-js-shared.css";
import "dmn-js/dist/assets/dmn-js-drd.css";
import "dmn-js/dist/assets/dmn-js-decision-table.css";
import "dmn-js/dist/assets/dmn-js-literal-expression.css";
import "dmn-js/dist/assets/dmn-font/css/dmn.css";
import "@miragon/wardley-renderer/assets/wardley.css";
import "@miragon/team-topologies-renderer/assets/team-topologies.css";
import "./portal.css";

import BpmnViewer from "./components/BpmnViewer.vue";
import DmnViewer from "./components/DmnViewer.vue";
import WardleyViewer from "./components/WardleyViewer.vue";
import TeamTopologyViewer from "./components/TeamTopologyViewer.vue";
import ValueChainViewer from "./components/ValueChainViewer.vue";
import ProcessPage from "./components/ProcessPage.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BpmnViewer", BpmnViewer);
    app.component("DmnViewer", DmnViewer);
    app.component("WardleyViewer", WardleyViewer);
    app.component("TeamTopologyViewer", TeamTopologyViewer);
    app.component("ValueChainViewer", ValueChainViewer);
    app.component("ProcessPage", ProcessPage);
  },
} satisfies Theme;
