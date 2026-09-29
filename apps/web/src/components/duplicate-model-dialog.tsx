/**
 * "Duplicate…" (#209) — a copy in the same folder under a new, editable name.
 * The suggestion is `<id>-copy` (then -copy-2, …), free among the ids the
 * client knows; the server's uniqueness gate stays authoritative (409 inline).
 * The copy is the source's current LIVE state — unreleased edits included.
 */
import type { DuplicateModelResult } from "@bpmiq/contracts/live-host";
import { processIdFromName } from "@bpmiq/notations";
import { Copy, FlaskConical, History } from "lucide-react";
import { useState } from "react";

import { Consequence, DialogShell, fieldClass } from "@/components/dialog-shell";
import { type ModelTarget, nounOf, pathUnderId } from "@/lib/model-target";
import { useDuplicateModel } from "@/lib/queries";

/** `<id>-copy`, `<id>-copy-2`, … — the first one not taken */
export function copyName(id: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${id}-copy` : `${id}-copy-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function DuplicateModelDialog({
  repo,
  model,
  takenIds,
  onClose,
  onDuplicated,
}: {
  repo: string;
  model: ModelTarget;
  /** ids of the same notation the client knows — the suggestion avoids them */
  takenIds: ReadonlySet<string>;
  onClose: () => void;
  onDuplicated: (result: DuplicateModelResult) => void;
}) {
  const [name, setName] = useState(() => copyName(model.id, takenIds));
  const duplicate = useDuplicateModel(repo);
  const noun = nounOf(model.notation);
  const id = processIdFromName(name.trim());
  const taken = takenIds.has(id);
  const target = pathUnderId(model, id);

  return (
    <DialogShell
      title={
        <>
          Duplicate <span className="font-mono">{model.id}</span>
        </>
      }
      blurb={`Creates a new ${noun} next to it — the original stays exactly as it is.`}
      pending={duplicate.isPending}
      error={duplicate.error}
      submitLabel="Duplicate"
      pendingLabel="Duplicating…"
      submitDisabled={id.length === 0 || taken}
      onSubmit={() => duplicate.mutate({ path: model.path, name: name.trim() }, { onSuccess: onDuplicated })}
      onClose={onClose}
    >
      <label className="mt-3 block text-xs font-medium" htmlFor="duplicate-model-name">
        Name of the copy
      </label>
      <input
        id="duplicate-model-name"
        className={fieldClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        autoFocus
        required
        spellCheck={false}
      />
      <p className={taken ? "text-destructive mt-1.5 text-xs" : "text-muted-foreground mt-1.5 text-xs"}>
        {id.length === 0 ? (
          "The file name is derived from the name — use at least one letter or digit."
        ) : taken ? (
          `A ${noun} named '${id}' already exists — ids are unique across all folders.`
        ) : (
          <>
            Creates <code className="bg-muted rounded px-1">{target}</code>
          </>
        )}
      </p>
      <ul className="mt-3 space-y-1.5 border-t pt-3" aria-label="What the copy contains">
        <Consequence icon={Copy}>Copies its current live state, unreleased changes included.</Consequence>
        {model.notation === "dmn" && (
          <Consequence icon={FlaskConical}>
            Its test cases are copied too — they pass until the copy starts to decide differently.
          </Consequence>
        )}
        <Consequence icon={History}>Todos and history stay with the original.</Consequence>
      </ul>
    </DialogShell>
  );
}
