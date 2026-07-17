/**
 * Modal comparing one historical commit against the LIVE document (right side
 * is a snapshot taken when Compare was opened; live edits during the diff are
 * not streamed in). Two views:
 *
 *   diagram (BPMN only, the default) — two read-only bpmn-js viewers side by
 *     side with semantic change markers from bpmn-js-differ (added / removed /
 *     changed / moved), viewboxes kept in sync so panning one pans the other.
 *     If either side fails to import (invalid intermediate XML), the dialog
 *     falls back to the XML view with a notice.
 *   xml — Monaco text diff (the only view for non-BPMN notations)
 *
 * Mounted on open, so state resets by unmounting (todo-create-dialog
 * precedent). "Restore" needs the same two-click confirm as the panel — it
 * overwrites unreleased live edits for everyone; the parent owns the mutation
 * and closes on success.
 */
import { Button } from "@bpmiq/ui-kit/components/button";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { diff } from "bpmn-js-differ";
import { GitCompare, RotateCcw, X } from "lucide-react";
import * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";

import type { FileCommitWire } from "@/lib/api";

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

const MARKER_LEGEND = [
  { marker: "bpm-diff-added", label: "added", color: "var(--success)" },
  { marker: "bpm-diff-removed", label: "removed", color: "var(--destructive)" },
  { marker: "bpm-diff-changed", label: "changed", color: "var(--warning)" },
  { marker: "bpm-diff-layout", label: "moved", color: "var(--muted-foreground)" },
] as const;

export function HistoryDiffDialog({
  commit,
  historical,
  current,
  language,
  isBpmn,
  restorePending,
  onRestore,
  onClose,
}: {
  commit: FileCommitWire;
  /** file content at the commit (left, read-only) */
  historical: string;
  /** live document snapshot at open time (right, read-only) */
  current: string;
  language: string;
  /** enables the visual diagram diff view (the default view then) */
  isBpmn: boolean;
  restorePending: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const monacoHostRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"diagram" | "xml">(isBpmn ? "diagram" : "xml");
  /** one side did not import as BPMN (invalid intermediate XML) — XML only */
  const [diagramFailed, setDiagramFailed] = useState(false);
  // restore overwrites live edits for everyone — same two-click confirm as the panel
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // xml view — Monaco text diff
  useEffect(() => {
    if (view !== "xml" || !monacoHostRef.current) return;
    const original = monaco.editor.createModel(historical, language);
    const modified = monaco.editor.createModel(current, language);
    const editor = monaco.editor.createDiffEditor(monacoHostRef.current, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      renderOverviewRuler: false,
    });
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [view, historical, current, language]);

  // diagram view — two read-only viewers + semantic markers + synced panning
  useEffect(() => {
    if (view !== "diagram" || !leftRef.current || !rightRef.current) return;
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
        if (!disposed) {
          setDiagramFailed(true);
          setView("xml");
        }
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
  }, [view, historical, current]);

  const showDiagram = view === "diagram";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-background flex h-[85vh] w-full max-w-6xl flex-col rounded-lg border shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <GitCompare className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate text-sm font-medium">
            <span className="font-mono">{commit.sha.slice(0, 7)}</span> · {commit.subject}
          </span>
          <div className="flex-1" />
          {isBpmn && !diagramFailed && (
            <div className="flex rounded-md border">
              <Button
                variant={showDiagram ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-r-none text-xs"
                onClick={() => setView("diagram")}
              >
                Diagram
              </Button>
              <Button
                variant={showDiagram ? "ghost" : "secondary"}
                size="sm"
                className="h-7 rounded-l-none text-xs"
                onClick={() => setView("xml")}
              >
                XML
              </Button>
            </div>
          )}
          <Button
            variant={confirmRestore ? "destructive" : "outline"}
            size="sm"
            title="Write this commit's content into the live document (overwrites unreleased live edits)"
            disabled={restorePending}
            onClick={() => {
              if (!confirmRestore) return setConfirmRestore(true);
              setConfirmRestore(false);
              onRestore();
            }}
          >
            <RotateCcw />
            {restorePending ? "Restoring…" : confirmRestore ? "Really restore?" : "Restore this version"}
          </Button>
          <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="text-muted-foreground flex items-center gap-4 border-b px-4 py-1 text-xs">
          <span className="flex-1 truncate">
            commit <span className="font-mono">{commit.sha.slice(0, 7)}</span> — {commit.author},{" "}
            {new Date(commit.authoredAt).toLocaleString()}
          </span>
          {showDiagram && (
            <span className="flex shrink-0 items-center gap-2">
              {MARKER_LEGEND.map((m) => (
                <span key={m.marker} className="flex items-center gap-1">
                  <span className="size-2 rounded-full" style={{ background: m.color }} />
                  {m.label}
                </span>
              ))}
            </span>
          )}
          <span className="flex-1 truncate text-right">live document (snapshot from when Compare was opened)</span>
        </div>
        {diagramFailed && (
          <div className="text-muted-foreground border-b px-4 py-1 text-xs">
            Diagram view unavailable — one side is not importable BPMN right now; showing the XML diff.
          </div>
        )}
        {showDiagram ? (
          <div className="flex min-h-0 flex-1">
            <div ref={leftRef} className="bpm-diff-viewer min-w-0 flex-1 border-r" />
            <div ref={rightRef} className="bpm-diff-viewer min-w-0 flex-1" />
          </div>
        ) : (
          <div ref={monacoHostRef} className="min-h-0 flex-1" />
        )}
      </div>
    </div>
  );
}
