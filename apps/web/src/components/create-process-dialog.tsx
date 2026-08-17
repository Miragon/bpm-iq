/**
 * "New process" — the BPMN wrapper around the shared CreateModelForm: it owns
 * the hook (rules of hooks: each kind calls its own) and the created payload
 * type; everything else lives in create-model-dialog.tsx.
 */
import { type ProcessInfo } from "@/lib/api";
import { useCreateProcess } from "@/lib/queries";

import { CreateModelForm } from "./create-model-dialog";

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
  const create = useCreateProcess(repo);
  return (
    <CreateModelForm<ProcessInfo>
      copy={{
        title: "New process",
        blurb: "Starts as a blank BPMN diagram — model it live, then release it as a pull request.",
        inputId: "process-name",
        placeholder: "e.g. Order to Cash",
        extension: ".bpmn",
        submitLabel: "Create process",
      }}
      folder={folder}
      create={create}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
