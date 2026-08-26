/**
 * "New <notation model>" — the registry-generic wrapper around the shared
 * CreateModelForm (#139): copy comes from the NotationDescriptor, the create
 * mutation injects the notation id. BPMN/DMN keep their typed dialogs (richer
 * wire rows + routes); every OTHER template-capable notation goes through
 * here — adding notation N+1 with a template needs zero new dialog code.
 */
import type { NotationDescriptor } from "@bpmiq/notations";

import { type ModelInfo } from "@/lib/api";
import { useCreateNotationModel } from "@/lib/queries";

import { CreateModelForm } from "./create-model-dialog";

export function CreateNotationModelDialog({
  repo,
  notation,
  folder,
  onClose,
  onCreated,
}: {
  repo: string;
  notation: NotationDescriptor;
  /** models-root-relative folder the table currently shows ("" = root) */
  folder: string;
  onClose: () => void;
  onCreated: (created: ModelInfo) => void;
}) {
  const create = useCreateNotationModel(repo);
  return (
    <CreateModelForm<ModelInfo>
      copy={{
        title: `New ${notation.noun.singular}`,
        blurb: `Starts as a blank ${notation.label} document — model it live, release it as a PR when ready.`,
        inputId: "model-name",
        placeholder: "e.g. Platform Landscape",
        extension: notation.extensions[0] ?? "",
        submitLabel: `Create ${notation.noun.singular}`,
      }}
      folder={folder}
      create={{
        isPending: create.isPending,
        error: create.error,
        mutate: (body, opts) => create.mutate({ ...body, notation: notation.id }, opts),
      }}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
