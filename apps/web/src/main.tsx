import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
// dmn-js view styles — its own diagram-js.css is skipped: bpmn-js already ships
// the (newer) copy and both target the same global .djs-* classes
import "dmn-js/dist/assets/dmn-js-shared.css";
import "dmn-js/dist/assets/dmn-js-drd.css";
import "dmn-js/dist/assets/dmn-js-decision-table.css";
import "dmn-js/dist/assets/dmn-js-decision-table-controls.css";
import "dmn-js/dist/assets/dmn-js-literal-expression.css";
import "dmn-js/dist/assets/dmn-js-boxed-expression.css";
import "dmn-js/dist/assets/dmn-js-boxed-expression-controls.css";
import "dmn-js/dist/assets/dmn-font/css/dmn.css";
import "./index.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { createRoot } from "react-dom/client";

import { queryClient } from "@/lib/queries";
import { router } from "@/router";

// json worker: .tt/.vc.json models are edited as JSON (notation registry)
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "json" ? new jsonWorker() : new editorWorker()),
};

// legacy hash-route deep links (#/r/owner/repo/p/id) from the pre-React client →
// rewrite to the real path so old bookmarks / shared links still land correctly.
if (location.hash.startsWith("#/")) {
  history.replaceState(null, "", location.hash.slice(1));
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
