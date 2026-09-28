/**
 * "Release → PR" dialog — pick exactly the changed files to ship. The
 * workspace is SHARED per repo, so the pool (GET /changes) may contain
 * colleagues' in-progress edits: nothing beyond `preselect` is checked by
 * default, and files somebody currently has open carry a warning badge. A
 * MOVED model (#182) is a delete + add pair that ships whole, so it is
 * selected whole too (moveUnits — the same rule the server applies). A file
 * in CONFLICT (#185: changed on the default branch while the workspace held
 * unreleased edits of it) cannot be picked — releasing it would silently
 * revert that change — until it is resolved right here: keep this version
 * (the release then deliberately replaces main's) or take main's (discards
 * the file's edits, confirmed first).
 * Mounted on open, so state resets by unmounting (create-dialog convention).
 */
import { moveUnits } from "@bpmiq/contracts/live-host";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect, useMemo, useState } from "react";

import { type ChangedFileWire } from "@/lib/api";
import { useChanges, useReleaseFiles, useRepos, useResolveConflict } from "@/lib/queries";

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

function statusBadge(file: ChangedFileWire, moved: boolean) {
  if (moved) return <Badge variant="secondary">{file.status === "deleted" ? "moved away" : "moved here"}</Badge>;
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
  const resolve = useResolveConflict(repo);
  // the conflict row whose "take main's version" awaits its confirmation
  const [discarding, setDiscarding] = useState<string | null>(null);
  const repos = useRepos();
  const branch = repos.data?.find((r) => r.fullName === repo)?.defaultBranch ?? "main";

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

  const pool = useMemo(() => changes.data ?? [], [changes.data]);
  const units = useMemo(() => moveUnits(pool), [pool]);
  const unitOf = (path: string) => units.get(path) ?? [path];
  // a move counts as selected when either half is (a preselected moved file
  // brings its other half along)
  const isSelected = (path: string) => unitOf(path).some((p) => selected.has(p));
  // only files that are actually in the pool count — a preselected path that
  // is not dirty (or healed meanwhile) silently drops out, and so does one in
  // conflict (the server would refuse it)
  const files = pool.filter((c) => !c.conflict && isSelected(c.path)).map((c) => c.path);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const unit = unitOf(path);
      const on = unit.some((p) => next.has(p));
      for (const p of unit) {
        if (on) next.delete(p);
        else next.add(p);
      }
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
            {pool.map((c) =>
              c.conflict ? (
                <ConflictRow
                  key={c.path}
                  file={c}
                  badge={statusBadge(c, units.has(c.path))}
                  branch={branch}
                  confirming={discarding === c.path}
                  pending={resolve.isPending}
                  onKeep={() => resolve.mutate({ path: c.path, keep: "workspace" })}
                  onDiscard={() => setDiscarding(c.path)}
                  onConfirm={() =>
                    resolve.mutate({ path: c.path, keep: "main" }, { onSettled: () => setDiscarding(null) })
                  }
                  onCancel={() => setDiscarding(null)}
                />
              ) : (
                <label
                  key={c.path}
                  className="hover:bg-accent/50 flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    className="accent-primary size-4 shrink-0"
                    checked={isSelected(c.path)}
                    onChange={() => toggle(c.path)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.path}>
                    {c.path}
                  </span>
                  {statusBadge(c, units.has(c.path))}
                  {c.liveSessions > 0 && <Badge variant="warning">{c.liveSessions} active</Badge>}
                </label>
              ),
            )}
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
        {resolve.error && <p className="text-destructive mt-3 text-sm">{resolve.error.message}</p>}
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

/** a pool row in conflict: not selectable, resolvable in place */
function ConflictRow({
  file,
  badge,
  branch,
  confirming,
  pending,
  onKeep,
  onDiscard,
  onConfirm,
  onCancel,
}: {
  file: ChangedFileWire;
  badge: React.ReactNode;
  branch: string;
  confirming: boolean;
  pending: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const action = "h-7 px-2.5 text-xs";
  return (
    <div className="border-b px-3 py-2 text-sm last:border-b-0">
      <div className="flex items-center gap-2.5">
        <input
          type="checkbox"
          className="size-4 shrink-0"
          checked={false}
          disabled
          aria-label={`${file.path} cannot be released until the conflict is resolved`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        {badge}
        <Badge variant="destructive">conflict</Badge>
        {file.liveSessions > 0 && <Badge variant="warning">{file.liveSessions} active</Badge>}
      </div>
      <div className="text-muted-foreground mt-1.5 pl-6.5 text-xs">
        {confirming ? (
          <>
            <p>Discard this workspace's edits to the file and use the version on {branch}?</p>
            <div className="mt-1.5 flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className={action}
                onClick={onConfirm}
                disabled={pending}
              >
                {pending ? "Discarding…" : "Discard edits"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={action}
                onClick={onCancel}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              Changed on {branch} while this workspace had unreleased edits — releasing it now would revert that change.
            </p>
            <div className="mt-1.5 flex gap-2">
              <Button type="button" variant="outline" size="sm" className={action} onClick={onKeep} disabled={pending}>
                Keep this version
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={action}
                onClick={onDiscard}
                disabled={pending || file.liveSessions > 0}
                title={file.liveSessions > 0 ? "Open in a live session — close it first" : undefined}
              >
                Use {branch}'s version
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
