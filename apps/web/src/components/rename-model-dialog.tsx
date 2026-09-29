/**
 * "Rename…" (#208) — one dialog for both entry points (the editor's title and
 * ⋯ menu, the overview row's ⋯ menu). A rename is not a label edit: the name
 * IS the model's id, the file name every link resolves by. So instead of an
 * inline field that commits on blur, the dialog says what will happen BEFORE
 * it happens — the new file, the models whose links get rewritten, that open
 * editors move along, the test cases and todos that follow — and commits
 * only on an explicit Rename (Enter). Server gates (a taken id, a target
 * still closing) surface inline. The todos move in the background (the
 * tracker takes one change at a time): the dialog says so up front, with the
 * time it will take once that is noticeable, and a toast follows it.
 */
import type { RenameModelResult } from "@bpmiq/contracts/live-host";
import { processIdFromName } from "@bpmiq/notations";
import { FlaskConical, Link2, ListTodo, Users } from "lucide-react";
import { useState } from "react";

import { Consequence, DialogShell, fieldClass } from "@/components/dialog-shell";
import { expectMove, isReferenceable, type ModelTarget, nounOf, pathUnderId } from "@/lib/model-target";
import { useReferences, useRenameModel, useTodos } from "@/lib/queries";
import { todoCount, todoJobEstimate } from "@/lib/todo-jobs";

const fileName = (path: string): string => path.split("/").pop() ?? path;

export function RenameModelDialog({
  repo,
  model,
  onClose,
  onRenamed,
}: {
  repo: string;
  model: ModelTarget;
  onClose: () => void;
  /** after the server renamed it — the editor opens the new path from here */
  onRenamed?: (result: RenameModelResult) => void;
}) {
  const [name, setName] = useState(model.id);
  const rename = useRenameModel(repo);
  const noun = nounOf(model.notation);
  const referenceable = isReferenceable(model.notation);
  const references = useReferences(repo, [model.path], referenceable);
  const callers = [...new Set((references.data?.[0]?.referencedBy ?? []).map((r) => r.path))];
  // todos are filed under the process id — a job moves them to the new one
  const todos = useTodos(repo, model.id, model.notation === "bpmn");
  const openTodos = todos.data?.length ?? 0;
  const estimate = todoJobEstimate(openTodos, "move");

  const id = processIdFromName(name.trim());
  const unchanged = id === model.id;
  const target = pathUnderId(model, id);

  const submit = () => {
    expectMove(target);
    rename.mutate(
      { path: model.path, name: name.trim(), expectedTodos: openTodos },
      { onSuccess: (result) => onRenamed?.(result) },
    );
  };

  return (
    <DialogShell
      title={`Rename ${noun}`}
      blurb="The name is the model's id — the file name other models link to."
      pending={rename.isPending}
      error={rename.error}
      submitLabel="Rename"
      pendingLabel="Renaming…"
      submitDisabled={id.length === 0 || unchanged}
      onSubmit={submit}
      onClose={onClose}
    >
      <label className="mt-3 block text-xs font-medium" htmlFor="rename-model-name">
        Name
      </label>
      <input
        id="rename-model-name"
        className={fieldClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        autoFocus
        required
        spellCheck={false}
      />
      <p className="text-muted-foreground mt-1.5 text-xs">
        {id.length === 0 ? (
          "The file name is derived from the name — use at least one letter or digit."
        ) : unchanged ? (
          <>
            This is its current name — <code className="bg-muted rounded px-1">{fileName(model.path)}</code>
          </>
        ) : (
          <>
            <code className="bg-muted rounded px-1">{fileName(model.path)}</code> becomes{" "}
            <code className="bg-muted rounded px-1">{fileName(target)}</code>
          </>
        )}
      </p>

      <ul className="mt-3 space-y-1.5 border-t pt-3" aria-label="What the rename changes">
        {referenceable && (
          <Consequence icon={Link2}>
            {references.isLoading ? (
              "Checking which models link to it…"
            ) : callers.length === 0 ? (
              "No other model links to it."
            ) : (
              <>
                Updates the link in {callers.length} model{callers.length === 1 ? "" : "s"}:{" "}
                <span className="text-foreground font-mono">{callers.map(fileName).join(", ")}</span>
              </>
            )}
          </Consequence>
        )}
        {model.liveSessions > 0 && (
          <Consequence icon={Users}>
            Open in a live session — everyone editing it continues under the new name.
          </Consequence>
        )}
        {model.notation === "dmn" && <Consequence icon={FlaskConical}>Its test cases are renamed along.</Consequence>}
        {openTodos > 0 && (
          <Consequence icon={ListTodo}>
            Moves its {todoCount(openTodos).replace("todo", "open todo")} along — in the background
            {estimate ? `, ${estimate}` : ""}. The tracker takes one change at a time; you can keep working.
          </Consequence>
        )}
      </ul>
      <p className="text-muted-foreground mt-3 text-xs">
        Titles inside the model stay as they are. The rename ships with your next release.
      </p>
    </DialogShell>
  );
}
