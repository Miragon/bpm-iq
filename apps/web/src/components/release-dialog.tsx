/**
 * "Release → PR" dialog — pick exactly the changed files to ship. The
 * workspace is SHARED per repo, so the pool (GET /changes) may contain
 * colleagues' in-progress edits: nothing beyond `preselect` is checked by
 * default, and files somebody currently has open carry a warning badge.
 * Mounted on open, so state resets by unmounting (create-dialog convention).
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect, useState } from "react";

import { type ChangedFileWire } from "@/lib/api";
import { useChanges, useReleaseFiles } from "@/lib/queries";

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

function statusBadge(file: ChangedFileWire) {
  if (file.status === "deleted") return <Badge variant="destructive">deleted</Badge>;
  if (file.status === "added") return <Badge variant="success">new</Badge>;
  return <Badge variant="outline">modified</Badge>;
}

export function ReleaseDialog({
  repo,
  preselect = [],
  onClose,
}: {
  repo: string;
  /** repo-relative paths to check initially (e.g. the file open in the editor) */
  preselect?: string[];
  onClose: () => void;
}) {
  const changes = useChanges(repo, true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(preselect));
  const [title, setTitle] = useState("");
  const release = useReleaseFiles(repo);

  // no close while the release runs — an unmounted dialog would drop the
  // mutation's onSuccess (toast + refetch), same as the create dialogs
  const close = () => {
    if (!release.isPending) onClose();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !release.isPending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, release.isPending]);

  const pool = changes.data ?? [];
  // only files that are actually in the pool count — a preselected path that
  // is not dirty (or healed meanwhile) silently drops out
  const files = pool.filter((c) => selected.has(c.path)).map((c) => c.path);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // the PR toast is HOOK-level in useReleaseFiles (it must survive an unmount
  // mid-release) — this callback only closes the dialog
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0 || release.isPending) return;
    release.mutate({ files, ...(title.trim() ? { title: title.trim() } : {}) }, { onSuccess: () => onClose() });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <form
        className="bg-background flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-sm font-semibold">Release → PR</h2>
        <p className="text-muted-foreground mt-1.5 text-xs">
          Ship exactly the files you pick as one pull request. The workspace is shared — files marked{" "}
          <Badge variant="warning">active</Badge> are open in a live session and may be mid-edit.
        </p>

        {changes.isLoading ? (
          <p className="text-muted-foreground mt-4 text-sm">Loading changes…</p>
        ) : changes.error ? (
          <p className="text-destructive mt-4 text-sm">{changes.error.message}</p>
        ) : pool.length === 0 ? (
          <p className="text-muted-foreground mt-4 text-sm">
            No changes to release — the workspace matches the default branch.
          </p>
        ) : (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border">
            {pool.map((c) => (
              <label
                key={c.path}
                className="hover:bg-accent/50 flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0"
              >
                <input
                  type="checkbox"
                  className="accent-primary size-4 shrink-0"
                  checked={selected.has(c.path)}
                  onChange={() => toggle(c.path)}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.path}>
                  {c.path}
                </span>
                {statusBadge(c)}
                {c.liveSessions > 0 && <Badge variant="warning">{c.liveSessions} active</Badge>}
              </label>
            ))}
          </div>
        )}

        {pool.length > 0 && (
          <>
            <label className="mt-3 block text-xs font-medium" htmlFor="release-title">
              Title <span className="text-muted-foreground font-normal">(optional — becomes the PR title)</span>
            </label>
            <input
              id="release-title"
              className={fieldClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q3 credit policy update"
            />
          </>
        )}

        {release.error && <p className="text-destructive mt-3 text-sm">{release.error.message}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={release.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={release.isPending || files.length === 0}>
            {release.isPending ? "Creating PR…" : `Release ${files.length} file${files.length === 1 ? "" : "s"} → PR`}
          </Button>
        </div>
      </form>
    </div>
  );
}
