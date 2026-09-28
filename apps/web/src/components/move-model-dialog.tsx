/**
 * "Move to…" dialog (#182) — pick the target folder for a model from the
 * repo's folder tree (the root included). The model keeps its file stem (=
 * its id), so links from other models keep resolving; a decision's tests
 * sidecar and unreleased live edits move along. Server errors (409: open in a
 * live session, destination taken) surface inline. Mounted on open, so state
 * resets by unmounting (create-dialog convention).
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { Folder, FolderRoot } from "lucide-react";
import { useEffect, useState } from "react";

import type { MoveModelsResult } from "@/lib/api";
import { useMoveModels } from "@/lib/queries";

export interface MovableModel {
  /** repo-relative path of the model file */
  path: string;
  name: string;
  /** processes-root-relative folder it sits in ("" = root) */
  folder: string;
  liveSessions: number;
}

export function MoveModelDialog({
  repo,
  model,
  folders,
  onClose,
  onMoved,
}: {
  repo: string;
  model: MovableModel;
  /** every folder under the processes root, processes-root-relative */
  folders: string[];
  onClose: () => void;
  onMoved: (folder: string, result: MoveModelsResult) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const move = useMoveModels(repo);

  // no close while the move runs — an unmounted dialog would drop the
  // mutation's onSuccess (cache refresh + the caller's toast)
  const close = () => {
    if (!move.isPending) onClose();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !move.isPending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, move.isPending]);

  const open = model.liveSessions > 0;
  const options = ["", ...[...folders].sort()];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (target === null || open || move.isPending) return;
    move.mutate({ paths: [model.path], folder: target }, { onSuccess: (result) => onMoved(target, result) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <form
        className="bg-background flex max-h-[85vh] w-full max-w-md flex-col rounded-lg border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-sm font-semibold">
          Move <span className="font-mono">{model.name}</span>
        </h2>
        <p className="text-muted-foreground mt-1.5 text-xs">
          The model keeps its id, so links from other models keep working. Unreleased changes move along; the next
          release ships the move.
        </p>
        {open && (
          <p className="mt-3 text-xs">
            <Badge variant="warning">{model.liveSessions} active</Badge> Open in a live editing session — close it
            before moving.
          </p>
        )}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border" role="radiogroup" aria-label="Folder">
          {options.map((folder) => {
            const current = folder === model.folder;
            const depth = folder === "" ? 0 : folder.split("/").length;
            return (
              <label
                key={folder || "(root)"}
                className={cn(
                  "flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0",
                  current ? "text-muted-foreground" : "hover:bg-accent/50 cursor-pointer",
                )}
                style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
              >
                <input
                  type="radio"
                  name="move-target"
                  className="accent-primary size-4 shrink-0"
                  checked={target === folder}
                  disabled={current || open}
                  onChange={() => setTarget(folder)}
                />
                {folder === "" ? (
                  <FolderRoot className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <Folder className="text-muted-foreground size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate" title={folder || "root"}>
                  {folder === "" ? "Root" : folder.split("/").pop()}
                </span>
                {current && <span className="text-xs">current</span>}
              </label>
            );
          })}
        </div>
        {move.error && <p className="text-destructive mt-3 text-sm">{move.error.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={move.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={move.isPending || target === null || open}>
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </div>
      </form>
    </div>
  );
}
