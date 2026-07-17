/**
 * "New process" dialog — creates a fresh BPMN diagram (blank start→end
 * template) in the folder currently shown in the table. The file stem (= the
 * process id, unique repo-wide) is derived live from the title via the same
 * slug rule the backend applies, so the preview always matches what will be
 * created. Server errors (409 duplicate id, 422 not a content repo) surface
 * inline. Mounted on open, so state resets by unmounting.
 */
import { processIdFromName } from "@bpmiq/notations";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect, useState } from "react";

import { type ProcessInfo } from "@/lib/api";
import { useCreateProcess } from "@/lib/queries";

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function CreateProcessDialog({
  repo,
  folder,
  onClose,
  onCreated,
}: {
  repo: string;
  /** processes-root-relative folder the table currently shows ("" = root) */
  folder: string;
  onClose: () => void;
  onCreated: (created: ProcessInfo) => void;
}) {
  const [name, setName] = useState("");
  const create = useCreateProcess(repo);

  // no close while the create runs — an unmounted dialog would drop the
  // mutation's onSuccess (navigation + cache seeding), same as SyncRepoDialog
  const close = () => {
    if (!create.isPending) onClose();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !create.isPending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, create.isPending]);

  const trimmed = name.trim();
  const id = processIdFromName(trimmed);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (id.length === 0 || create.isPending) return;
    create.mutate({ name: trimmed, ...(folder ? { folder } : {}) }, { onSuccess: onCreated });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <form
        className="bg-background w-full max-w-md rounded-lg border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-sm font-semibold">New process</h2>
        <p className="text-muted-foreground mt-1.5 text-xs">
          Starts as a blank BPMN diagram — model it live, then release it as a pull request.
        </p>
        <label className="mt-3 block text-xs font-medium" htmlFor="process-name">
          Name
        </label>
        <input
          id="process-name"
          className={fieldClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Order to Cash"
          autoFocus
          required
        />
        <p className="text-muted-foreground mt-1.5 text-xs">
          {id.length > 0 ? (
            <>
              Creates{" "}
              <code className="bg-muted rounded px-1">
                {folder ? `${folder}/` : ""}
                {id}.bpmn
              </code>
            </>
          ) : (
            "The file name is derived from the name — use at least one letter or digit."
          )}
        </p>
        {create.error && <p className="text-destructive mt-3 text-sm">{create.error.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || id.length === 0}>
            {create.isPending ? "Creating…" : "Create process"}
          </Button>
        </div>
      </form>
    </div>
  );
}
