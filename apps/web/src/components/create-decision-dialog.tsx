/**
 * "New decision" — the DMN wrapper around the shared CreateModelForm: it owns
 * the hook (rules of hooks: each kind calls its own) and the created payload
 * type; everything else lives in create-model-dialog.tsx.
 */
import { type DecisionInfo } from "@/lib/api";
import { useCreateDecision } from "@/lib/queries";

import { CreateModelForm } from "./create-model-dialog";

export function CreateDecisionDialog({
  repo,
  folder,
  onClose,
  onCreated,
}: {
  repo: string;
  /** processes-root-relative folder the table currently shows ("" = root) */
  folder: string;
  onClose: () => void;
  onCreated: (created: DecisionInfo) => void;
}) {
  const create = useCreateDecision(repo);
  return (
    <CreateModelForm<DecisionInfo>
      copy={{
        title: "New decision",
        blurb: "Starts as a blank DMN decision table — model it live, link it from a business rule task when ready.",
        inputId: "decision-name",
        placeholder: "e.g. Credit Check",
        extension: ".dmn",
        submitLabel: "Create decision",
      }}
      folder={folder}
      create={create}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
