import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
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
