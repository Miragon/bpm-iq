/**
 * Semantic BPMN editing on LIVE documents (ADR 0008): an agent sends operations or a layout request instead of the
 * whole XML; @bpmiq/bpmn-edit computes the new XML, geometry included, and the ordinary content save (validation +
 * CAS + minimal-diff write) stores it. Because the change is semantic, a document that moved on between the read and
 * the write is no reason to give up: the change is re-applied to the current text, up to MAX_ATTEMPTS times.
 *
 * Adapter implementations are injected (the content read/write of content.ts), never imported — the use-case only
 * knows the package and the ports it is handed.
 */
import {
  applyOperations,
  layout,
  type LayoutRequest,
  type Operation,
  type Outline,
  outline,
  type OutlineOptions,
  type PlaneMetrics,
  type PlatformId,
} from "@bpmiq/bpmn-edit";
import type { ContentWire, PutContentResultWire } from "@bpmiq/contracts/live-host";

import type { PutOutcome } from "./content.ts";

export interface BpmnEditIo {
  read(path: string): Promise<Pick<ContentWire, "path" | "content" | "baseVersion">>;
  write(path: string, body: { content: string; baseVersion: string; lint?: "block" | "warn" }): Promise<PutOutcome>;
}

/** re-applications on a concurrent change before the tool reports a conflict */
export const MAX_ATTEMPTS = 3;

export interface BpmnChange {
  readonly xml: string;
  readonly changedIds: readonly string[];
  readonly removedIds: readonly string[];
  readonly movedIds: readonly string[];
  readonly before: readonly PlaneMetrics[];
  readonly after: readonly PlaneMetrics[];
  readonly diagnostics: readonly string[];
  readonly platform?: PlatformId;
}

export type BpmnEditResult =
  | {
      ok: true;
      /** false on a dry run and when the change left the text as it was */
      written: boolean;
      attempts: number;
      save?: PutContentResultWire;
      change: Omit<BpmnChange, "xml">;
    }
  | { ok: false; conflict: true; attempts: number; message: string };

/** One read → compute → CAS write cycle, repeated on a conflict. */
async function changeLive(
  io: BpmnEditIo,
  path: string,
  compute: (xml: string) => Promise<BpmnChange>,
  options: { dryRun?: boolean; lint?: "block" | "warn" },
): Promise<BpmnEditResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await io.read(path);
    const { xml, ...change } = await compute(current.content);
    if (options.dryRun || xml === current.content) {
      return { ok: true, written: false, attempts: attempt, change };
    }
    const out = await io.write(current.path, { content: xml, baseVersion: current.baseVersion, lint: options.lint });
    if (out.ok) {
      return { ok: true, written: true, attempts: attempt, save: out.result, change };
    }
  }
  return {
    ok: false,
    conflict: true,
    attempts: MAX_ATTEMPTS,
    message: `the document kept changing during ${MAX_ATTEMPTS} attempts; retry the same operations`,
  };
}

export function editProcess(
  io: BpmnEditIo,
  path: string,
  operations: readonly Operation[],
  options: { dryRun?: boolean; lint?: "block" | "warn" } = {},
): Promise<BpmnEditResult> {
  return changeLive(io, path, (xml) => applyOperations(xml, operations, path), options);
}

export function layoutProcess(
  io: BpmnEditIo,
  path: string,
  request: LayoutRequest,
  options: { dryRun?: boolean; lint?: "block" | "warn" } = {},
): Promise<BpmnEditResult> {
  return changeLive(
    io,
    path,
    async (xml) => {
      const outcome = await layout(xml, request, path);
      return {
        xml: outcome.xml,
        changedIds: [],
        removedIds: [],
        movedIds: outcome.movedIds,
        before: outcome.before,
        after: outcome.after,
        diagnostics: outcome.result.diagnostics.map((diagnostic) => diagnostic.message),
      };
    },
    options,
  );
}

export async function outlineProcess(
  io: BpmnEditIo,
  path: string,
  options: OutlineOptions,
): Promise<{ path: string; baseVersion: string; outline: Outline }> {
  const current = await io.read(path);
  return {
    path: current.path,
    baseVersion: current.baseVersion,
    outline: await outline(current.content, options, path),
  };
}
