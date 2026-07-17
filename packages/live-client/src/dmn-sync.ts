/**
 * Y.Text ↔ dmn-js binding — the dmn adapter for the shared sync engine
 * (model-sync.ts, same four rules as bpmn-sync). What dmn-js does differently:
 *
 *  - it is MULTI-VIEW (DRD, decision table, literal/boxed expression), each
 *    view backed by its own viewer with its own command stack. Change events
 *    do not reach the manager's event bus, so the binding subscribes to every
 *    viewer the modeler creates (`viewer.created`) and — in case a viewer
 *    existed before binding — to the active viewer on `views.changed`.
 *  - only the DRD view is a diagram-js canvas; viewbox capture/restore applies
 *    there. Table/expression views manage their own scroll state.
 *  - importXML re-opens the previously active view (dmn-js Manager behavior),
 *    so remote re-imports keep the user's current view.
 */
import type * as Y from "yjs";

import { bindModelSync } from "./model-sync.ts";

interface DrdViewbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DrdCanvasLike {
  viewbox(): DrdViewbox;
  viewbox(box: DrdViewbox): void;
  zoom(mode: string): void;
}

interface DmnViewerLike {
  get(service: string, strict?: boolean): unknown;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
}

interface DmnModelerLike {
  getActiveView(): { type: string } | null | undefined;
  getActiveViewer(): DmnViewerLike | null | undefined;
  on(event: string, cb: (event: never) => void): void;
  off(event: string, cb: (event: never) => void): void;
  importXML(xml: string): Promise<unknown>;
  saveXML(options: { format: boolean }): Promise<{ xml?: string }>;
}

export function bindDmn(
  modeler: DmnModelerLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  /** first import failed — the document is malformed, offer the XML view */
  onImportError?: (message: string) => void,
): () => void {
  // the DRD viewer's canvas, or undefined in table/expression views
  const drdCanvas = (): DrdCanvasLike | undefined =>
    modeler.getActiveView()?.type === "drd"
      ? (modeler.getActiveViewer()?.get("canvas", false) as DrdCanvasLike | undefined)
      : undefined;

  return bindModelSync(
    {
      importXML: (xml) => modeler.importXML(xml),
      saveXML: async () => (await modeler.saveXML({ format: true })).xml,

      beforeImport(isFirstImport) {
        let viewbox: DrdViewbox | undefined;
        try {
          viewbox = drdCanvas()?.viewbox();
        } catch {
          /* no DRD open yet */
        }
        return () => {
          // re-resolve: the import re-opened a view, possibly not the DRD
          const canvas = drdCanvas();
          if (!canvas) return;
          if (viewbox && viewbox.width > 0 && !isFirstImport) canvas.viewbox(viewbox);
          else canvas.zoom("fit-viewport");
        };
      },

      observeModel(onChanged) {
        // one subscription per viewer for its whole lifetime — dmn-js caches
        // viewers per view type, and an inactive viewer's stack never fires
        const subscribed = new Set<DmnViewerLike>();
        const subscribe = (viewer: DmnViewerLike | null | undefined): void => {
          if (!viewer || subscribed.has(viewer)) return;
          subscribed.add(viewer);
          viewer.on("commandStack.changed", onChanged);
        };
        const onViewerCreated = ({ viewer }: { viewer: DmnViewerLike }) => subscribe(viewer);
        const onViewsChanged = () => subscribe(modeler.getActiveViewer());
        modeler.on("viewer.created", onViewerCreated);
        modeler.on("views.changed", onViewsChanged);
        subscribe(modeler.getActiveViewer());
        return () => {
          modeler.off("viewer.created", onViewerCreated);
          modeler.off("views.changed", onViewsChanged);
          for (const viewer of subscribed) viewer.off("commandStack.changed", onChanged);
        };
      },
    },
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}
