/**
 * "Move to…" dialog (#182, #210) — pick the target folder for one model or a
 * whole selection from the repo's folder tree (the root included). A model
 * keeps its file stem (= its id), so links from other models keep resolving;
 * a decision's tests sidecar and unreleased live edits move along. Server
 * errors (409: open in a live session, destination taken) surface inline —
 * one refused file refuses the whole move.
 */
import { Badge } from "@designiq/ui-kit/components/badge";
import { cn } from "@designiq/ui-kit/lib/utils";
import { Folder, FolderRoot } from "lucide-react";
import { useState } from "react";

import { DialogShell } from "@/components/dialog-shell";
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
  models,
  folders,
  onClose,
  onMoved,
}: {
  repo: string;
  models: MovableModel[];
  /** every folder under the processes root, processes-root-relative */
  folders: string[];
  onClose: () => void;
  onMoved: (folder: string, result: MoveModelsResult) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const move = useMoveModels(repo);

  const open = models.filter((m) => m.liveSessions > 0);
  const homes = new Set(models.map((m) => m.folder));
  // the folder they ALL sit in already — nothing would move there
  const current = homes.size === 1 ? [...homes][0] : undefined;
  const options = ["", ...[...folders].sort()];
  const single = models.length === 1 ? models[0] : undefined;

  return (
    <DialogShell
      title={
        single ? (
          <>
            Move <span className="font-mono">{single.name}</span>
          </>
        ) : (
          `Move ${models.length} models`
        )
      }
      blurb={`${single ? "The model keeps its id" : "Every model keeps its id"}, so links from other models keep working. Unreleased changes move along; the next release ships the move.`}
      pending={move.isPending}
      error={move.error}
      submitLabel="Move"
      pendingLabel="Moving…"
      submitDisabled={target === null || open.length > 0}
      onSubmit={() => {
        if (target === null) return;
        move.mutate({ paths: models.map((m) => m.path), folder: target }, { onSuccess: (r) => onMoved(target, r) });
      }}
      onClose={onClose}
    >
      {open.length > 0 && (
        <p className="mt-3 text-xs">
          <Badge variant="warning">active</Badge>{" "}
          {single ? "Open" : `${open.map((m) => m.name).join(", ")} ${open.length === 1 ? "is" : "are"} open`} in a live
          editing session — close {open.length === 1 ? "it" : "them"} before moving.
        </p>
      )}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border" role="radiogroup" aria-label="Folder">
        {options.map((folder) => {
          const here = folder === current;
          const depth = folder === "" ? 0 : folder.split("/").length;
          return (
            <label
              key={folder || "(root)"}
              className={cn(
                "flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0",
                here ? "text-muted-foreground" : "hover:bg-accent/50 cursor-pointer",
              )}
              style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
            >
              <input
                type="radio"
                name="move-target"
                className="accent-primary size-4 shrink-0"
                checked={target === folder}
                disabled={here || open.length > 0}
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
              {here && <span className="text-xs">current</span>}
            </label>
          );
        })}
      </div>
    </DialogShell>
  );
}
