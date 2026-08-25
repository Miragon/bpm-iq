/**
 * The BPMN diagram diff — two read-only bpmn-js viewers side by side with
 * semantic change markers from bpmn-js-differ (added / removed / changed /
 * moved), viewboxes kept in sync so panning one pans the other. Extracted
 * from history-diff-dialog.tsx as the bpmn plugin's DiffSpec component so
 * bpmn-js and the differ stay OUT of the eager bundle; the dialog owns the
 * chrome, the view toggle and the Monaco text-diff fallback.
 *
 * If either side fails to import (invalid intermediate XML), onUnavailable()
 * hands control back to the dialog — the text diff still works.
 */
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { diff } from "bpmn-js-differ";
import { useEffect, useRef } from "react";

import type { DiagramDiffProps } from "./registry";

/** minimal structural view of the bpmn-js services we touch (bindBpmn pattern) */
interface ViewboxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CanvasLike {
  zoom(mode: "fit-viewport"): unknown;
  viewbox(): ViewboxLike;
  viewbox(box: ViewboxLike): unknown;
  addMarker(elementId: string, marker: string): void;
}
interface ViewerLike {
  importXML(xml: string): Promise<unknown>;
  getDefinitions(): unknown;
  get(service: "canvas"): CanvasLike;
  get(service: "elementRegistry"): { get(id: string): unknown };
  on(event: "canvas.viewbox.changed", callback: () => void): void;
  off(event: "canvas.viewbox.changed", callback: () => void): void;
  destroy(): void;
}

export function BpmnDiagramDiff({ historical, current, onUnavailable }: DiagramDiffProps) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!leftRef.current || !rightRef.current) return;
    let disposed = false;
    const left = new NavigatedViewer({ container: leftRef.current }) as unknown as ViewerLike;
    const right = new NavigatedViewer({ container: rightRef.current }) as unknown as ViewerLike;
    const offFns: (() => void)[] = [];

    void (async () => {
      try {
        await left.importXML(historical);
        await right.importXML(current);
      } catch {
        // one side is not importable BPMN (e.g. a live intermediate state) —
        // the text diff still works, so fall back instead of a broken canvas
        if (!disposed) onUnavailable();
        return;
      }
      if (disposed) return;

      const changes = diff(left.getDefinitions(), right.getDefinitions());
      const mark = (viewer: ViewerLike, ids: string[], marker: string) => {
        const registry = viewer.get("elementRegistry");
        const canvas = viewer.get("canvas");
        for (const id of ids) if (registry.get(id)) canvas.addMarker(id, marker);
      };
      mark(left, Object.keys(changes._removed), "bpm-diff-removed");
      mark(right, Object.keys(changes._added), "bpm-diff-added");
      for (const viewer of [left, right]) {
        mark(viewer, Object.keys(changes._changed), "bpm-diff-changed");
        mark(viewer, Object.keys(changes._layoutChanged), "bpm-diff-layout");
      }

      // fit BOTH first, then couple the viewboxes — panning/zooming one side
      // follows on the other (the guard stops the echo of the programmatic set)
      const leftCanvas = left.get("canvas");
      const rightCanvas = right.get("canvas");
      leftCanvas.zoom("fit-viewport");
      rightCanvas.zoom("fit-viewport");
      let syncing = false;
      const follow = (src: CanvasLike, dst: CanvasLike) => () => {
        if (syncing) return;
        syncing = true;
        dst.viewbox(src.viewbox());
        syncing = false;
      };
      const leftMoved = follow(leftCanvas, rightCanvas);
      const rightMoved = follow(rightCanvas, leftCanvas);
      left.on("canvas.viewbox.changed", leftMoved);
      right.on("canvas.viewbox.changed", rightMoved);
      offFns.push(() => left.off("canvas.viewbox.changed", leftMoved));
      offFns.push(() => right.off("canvas.viewbox.changed", rightMoved));
    })();

    return () => {
      disposed = true;
      for (const off of offFns) off();
      left.destroy();
      right.destroy();
    };
  }, [historical, current, onUnavailable]);

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={leftRef} className="bpm-diff-viewer min-w-0 flex-1 border-r" />
      <div ref={rightRef} className="bpm-diff-viewer min-w-0 flex-1" />
    </div>
  );
}
