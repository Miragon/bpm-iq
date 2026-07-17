/**
 * "Load latest from <default branch>" confirmation — shown only when the repo
 * has unreleased live changes the reset would DISCARD (a clean repo syncs
 * without asking). Lists the affected processes so the discard is an informed
 * choice. Mounted on open, so state resets by unmounting; the reset itself
 * (mutation, toast) is owned by the parent (routes/repo.tsx).
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect } from "react";

export function SyncRepoDialog({
  branch,
  dirtyProcesses,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  /** the default branch the workspace is reset onto */
  branch: string;
  /** names of processes with unreleased live edits the reset will discard */
  dirtyProcesses: string[];
  pending: boolean;
  error: Error | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        className="bg-background w-full max-w-md rounded-lg border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">Load latest from {branch}?</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          This resets the workspace to <code className="bg-muted rounded px-1">{branch}</code> and{" "}
          <strong className="text-foreground">discards the unreleased live changes</strong> in{" "}
          {dirtyProcesses.length === 1 ? "this process" : `these ${dirtyProcesses.length} processes`}:
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dirtyProcesses.map((name) => (
            <Badge key={name} variant="warning" className="max-w-64" title={name}>
              <span className="truncate">{name}</span>
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          Release them first if you want to keep them. This can't be undone.
        </p>
        {error && <p className="text-destructive mt-3 text-sm">{error.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? "Loading…" : "Discard & load latest"}
          </Button>
        </div>
      </div>
    </div>
  );
}
