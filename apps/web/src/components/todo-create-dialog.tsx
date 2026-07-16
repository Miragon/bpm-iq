/**
 * "Add todo" dialog — anchors the new todo to the elements selected on the
 * canvas at open time, or creates a process-level todo when nothing is
 * selected. Server errors (501 "no tracker configured", permission) surface
 * inline — their messages are actionable. Mounted on open, so state resets by
 * unmounting.
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useEffect, useState } from "react";

import type { TodoElementWire } from "@/lib/api";
import { useCreateTodo } from "@/lib/queries";

const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function TodoCreateDialog({
  repo,
  processId,
  docPath,
  elements,
  onClose,
}: {
  repo: string;
  processId: string;
  /** repo-relative path of the open model document (the todo's anchor file) */
  docPath: string;
  /** canvas selection at open time — empty ⇒ process-level todo */
  elements: TodoElementWire[];
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useCreateTodo(repo);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || create.isPending) return;
    create.mutate(
      {
        title: trimmed,
        ...(body.trim() ? { body: body.trim() } : {}),
        anchor: {
          process: processId,
          file: docPath,
          ...(elements.length > 0 ? { elements } : {}),
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        className="bg-background w-full max-w-md rounded-lg border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-sm font-semibold">Create todo</h2>
        {elements.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-xs">Anchored to:</span>
            {elements.map((el) => (
              <Badge key={el.id} variant="outline" className="max-w-48" title={el.id}>
                <span className="truncate">{el.name ?? el.id}</span>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground mt-1.5 text-xs">
            No element selected — the todo applies to the process "{processId}".
          </p>
        )}
        <label className="mt-3 block text-xs font-medium" htmlFor="todo-title">
          Title
        </label>
        <input
          id="todo-title"
          className={fieldClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          autoFocus
          required
        />
        <label className="mt-3 block text-xs font-medium" htmlFor="todo-body">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          id="todo-body"
          className={fieldClass}
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {create.error && <p className="text-destructive mt-3 text-sm">{create.error.message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || title.trim().length === 0}>
            {create.isPending ? "Creating…" : "Create todo"}
          </Button>
        </div>
      </form>
    </div>
  );
}
