/**
 * The shared "create a model" dialog form — the process and decision dialogs
 * were 100-line twins differing in copy, the mutation hook and the created
 * payload type. The form owns the shell (backdrop, escape/close guards while
 * the create runs, live file-stem preview via the backend's slug rule, inline
 * server errors); each kind keeps a thin wrapper that calls ITS hook (a
 * kind-switching hook call inside one component would break the rules of
 * hooks) and types its onCreated payload.
 */
import { processIdFromName } from "@bpmiq/notations";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect, useState } from "react";

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export interface CreateModelCopy {
  /** "New process" */
  title: string;
  blurb: string;
  /** input id/htmlFor pair, e.g. "process-name" */
  inputId: string;
  placeholder: string;
  /** primary extension of the created file (stem-preview suffix) */
  extension: string;
  /** "Create process" */
  submitLabel: string;
}

/** the slice of a react-query mutation the form needs (structural on purpose) */
export interface CreateMutationLike<TCreated> {
  isPending: boolean;
  error: Error | null;
  mutate: (body: { name: string; folder?: string }, opts: { onSuccess: (created: TCreated) => void }) => void;
}

export function CreateModelForm<TCreated>({
  copy,
  folder,
  create,
  onClose,
  onCreated,
}: {
  copy: CreateModelCopy;
  /** processes-root-relative folder the table currently shows ("" = root) */
  folder: string;
  create: CreateMutationLike<TCreated>;
  onClose: () => void;
  onCreated: (created: TCreated) => void;
}) {
  const [name, setName] = useState("");

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
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        <p className="text-muted-foreground mt-1.5 text-xs">{copy.blurb}</p>
        <label className="mt-3 block text-xs font-medium" htmlFor={copy.inputId}>
          Name
        </label>
        <input
          id={copy.inputId}
          className={fieldClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={copy.placeholder}
          autoFocus
          required
        />
        <p className="text-muted-foreground mt-1.5 text-xs">
          {id.length > 0 ? (
            <>
              Creates{" "}
              <code className="bg-muted rounded px-1">
                {folder ? `${folder}/` : ""}
                {id}
                {copy.extension}
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
            {create.isPending ? "Creating…" : copy.submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
