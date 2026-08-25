/**
 * Modal comparing one historical commit against the LIVE document (right side
 * is a snapshot taken when Compare was opened; live edits during the diff are
 * not streamed in). Two views:
 *
 *   diagram (the default when the notation's plugin provides a DiffSpec) —
 *     the plugin's lazy diagram-diff component (e.g. the bpmn plugin's two
 *     synced viewers with semantic change markers). If it reports itself
 *     unavailable (invalid intermediate content), the dialog falls back to
 *     the text view with a notice.
 *   xml — Monaco text diff (the only view for notations without a DiffSpec)
 *
 * Mounted on open, so state resets by unmounting (todo-create-dialog
 * precedent). "Restore" needs the same two-click confirm as the panel — it
 * overwrites unreleased live edits for everyone; the parent owns the mutation
 * and closes on success.
 */
import { Button } from "@bpmiq/ui-kit/components/button";
import { GitCompare, RotateCcw, X } from "lucide-react";
import * as monaco from "monaco-editor";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import type { FileCommitWire } from "@/lib/api";
import type { DiffSpec } from "@/notations/registry";

export function HistoryDiffDialog({
  commit,
  historical,
  current,
  language,
  diagramDiff,
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
  /** the notation plugin's visual diff (the default view then) — absent = text only */
  diagramDiff?: DiffSpec;
  restorePending: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const monacoHostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"diagram" | "xml">(diagramDiff ? "diagram" : "xml");
  /** the plugin's diff could not render this pair (invalid intermediate content) */
  const [diagramFailed, setDiagramFailed] = useState(false);
  const onDiagramUnavailable = useCallback(() => {
    setDiagramFailed(true);
    setView("xml");
  }, []);
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
          {diagramDiff && !diagramFailed && (
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
          {showDiagram && diagramDiff && (
            <span className="flex shrink-0 items-center gap-2">
              {diagramDiff.legend.map((m) => (
                <span key={m.label} className="flex items-center gap-1">
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
            Diagram view unavailable — one side is not importable right now; showing the text diff.
          </div>
        )}
        {showDiagram && diagramDiff ? (
          <Suspense fallback={null}>
            <diagramDiff.component historical={historical} current={current} onUnavailable={onDiagramUnavailable} />
          </Suspense>
        ) : (
          <div ref={monacoHostRef} className="min-h-0 flex-1" />
        )}
      </div>
    </div>
  );
}
