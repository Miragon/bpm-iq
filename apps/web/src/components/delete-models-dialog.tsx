/**
 * "Delete…" (#210) — one confirmation for one model or a whole selection. It
 * names every file that goes (a decision's test cases included) and says
 * what the deletion breaks before it happens: links from models that stay
 * behind dangle, unreleased changes are lost. A model open in a live session
 * blocks the delete (the server refuses it too — all or nothing), so the
 * dialog says which one instead of failing on submit. A deleted process's
 * open todos would point at nothing: the dialog counts them and offers to
 * close them along (in the background — the tracker takes one change at a
 * time); unticked, they stay open in the tracker.
 */
import type { DeleteModelsResult } from "@designiq/contracts/live-host";
import { CircleAlert, Link2Off, ListTodo, PencilLine } from "lucide-react";
import { useState } from "react";

import { Consequence, DialogShell } from "@/components/dialog-shell";
import { isReferenceable, type ModelTarget, nounOf } from "@/lib/model-target";
import { useDeleteModels, useReferences, useTodos } from "@/lib/queries";
import { todoCount, todoJobEstimate } from "@/lib/todo-jobs";

const fileName = (path: string): string => path.split("/").pop() ?? path;
const names = (models: ModelTarget[]): string => models.map((m) => m.id).join(", ");

export function DeleteModelsDialog({
  repo,
  models,
  onClose,
  onDeleted,
}: {
  repo: string;
  models: ModelTarget[];
  onClose: () => void;
  onDeleted: (result: DeleteModelsResult) => void;
}) {
  const remove = useDeleteModels(repo);
  const paths = models.map((m) => m.path);
  const referenced = models.filter((m) => isReferenceable(m.notation)).map((m) => m.path);
  const references = useReferences(repo, referenced, referenced.length > 0);
  // links from models that are deleted along are no loss
  const doomed = new Set(paths);
  const dangling = [
    ...new Set(
      (references.data ?? []).flatMap((r) => r.referencedBy.filter((by) => !doomed.has(by.path)).map((by) => by.path)),
    ),
  ];
  // a deleted PROCESS's open todos lose their process — count them (anchored
  // ones; the tracker is asked only when a process is in the selection)
  const processes = new Set(models.filter((m) => m.notation === "bpmn").map((m) => m.id));
  const todos = useTodos(repo, undefined, processes.size > 0);
  const orphaned = (todos.data ?? []).filter((t) => t.anchor && processes.has(t.anchor.process)).length;
  const [closeTodos, setCloseTodos] = useState(false);
  const estimate = todoJobEstimate(orphaned, "close");
  const open = models.filter((m) => m.liveSessions > 0);
  const dirty = models.filter((m) => m.dirty);
  const single = models.length === 1 ? models[0] : undefined;

  return (
    <DialogShell
      title={
        single ? (
          <>
            Delete {nounOf(single.notation)} <span className="font-mono">{single.id}</span>?
          </>
        ) : (
          `Delete ${models.length} models?`
        )
      }
      blurb="The deletion ships with your next release. A model that was never released is gone for good."
      pending={remove.isPending}
      error={remove.error}
      submitLabel={single ? "Delete" : `Delete ${models.length} models`}
      pendingLabel="Deleting…"
      submitDisabled={open.length > 0 || models.length === 0}
      destructive
      wide={!single}
      onSubmit={() =>
        remove.mutate({ paths, ...(closeTodos && orphaned > 0 ? { closeTodos } : {}) }, { onSuccess: onDeleted })
      }
      onClose={onClose}
    >
      <ul className="bg-muted/40 mt-3 max-h-48 min-h-0 overflow-y-auto rounded-md border px-3 py-2 text-xs">
        {models.map((m) => (
          <li key={m.path} className="flex items-baseline gap-2 py-0.5">
            <span className="min-w-0 truncate font-mono" title={m.path}>
              {m.path}
            </span>
            {m.notation === "dmn" && <span className="text-muted-foreground shrink-0">+ its test cases</span>}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-1.5" aria-label="What the deletion breaks">
        {open.length > 0 && (
          <Consequence icon={CircleAlert} tone="danger">
            {open.length === 1 ? `'${open[0]?.id}' is` : `${names(open)} are`} open in a live editing session — close{" "}
            {open.length === 1 ? "it" : "them"} before deleting.
          </Consequence>
        )}
        {references.isLoading ? (
          <Consequence icon={Link2Off}>Checking which models link to {single ? "it" : "them"}…</Consequence>
        ) : (
          dangling.length > 0 && (
            <Consequence icon={Link2Off} tone="warning">
              {dangling.length === 1 ? "The link in " : `The links in ${dangling.length} models — `}
              <span className="font-mono">{dangling.map(fileName).join(", ")}</span>
              {dangling.length === 1 ? " will point nowhere" : " — will point nowhere"}; the validator warns about it.
            </Consequence>
          )
        )}
        {dirty.length > 0 && (
          <Consequence icon={PencilLine} tone="warning">
            Unreleased changes to {single ? "it" : names(dirty)} are lost.
          </Consequence>
        )}
        {orphaned > 0 && (
          <Consequence icon={ListTodo} tone="warning">
            {todoCount(orphaned).replace("todo", "open todo")} would point at a process that no longer exists.
            <label className="mt-1.5 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="accent-primary mt-px size-3.5 shrink-0"
                checked={closeTodos}
                onChange={(e) => setCloseTodos(e.target.checked)}
              />
              <span>
                Close {orphaned === 1 ? "it" : "them"} in the tracker too
                <span className="text-muted-foreground">
                  {" "}
                  — in the background{estimate ? `, ${estimate}` : ""}; unticked, they stay open
                </span>
              </span>
            </label>
          </Consequence>
        )}
      </ul>
    </DialogShell>
  );
}
