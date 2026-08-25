/**
 * The web editor plugin registry (epic #118 step 6): which visual editor,
 * side panels, assist handoff and history diff a notation gets. The shell
 * (live-editor.tsx) looks its plugin up by descriptor id and mounts through
 * this contract — a notation WITHOUT a plugin opens in collaborative Monaco.
 *
 * Boundary rule, mirrored from ADR 0006: a plugin MANIFEST (this module +
 * the per-notation manifests it imports) is light, eager data — the editor
 * ENGINES (bpmn-js, dmn-js, the differ) live behind the manifests' dynamic
 * imports, so the eager bundle never carries an engine and the repo overview
 * loads none of them.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import type * as Y from "yjs";

import type { TodoElementWire } from "@/lib/api";
import type { TodoCanvas } from "@/lib/todo-canvas";

import { bpmnPlugin } from "./bpmn";
import { dmnPlugin } from "./dmn";

/** what the shell hands a mounting editor engine */
export interface EditorContext {
  /** the ONE shared live document (text shape) */
  ytext: Y.Text;
  doc: Y.Doc;
  docPath: string;
  /** a sync round-trip failed mid-session — surfaced, session keeps running */
  onSyncError(message: string): void;
  /** the FIRST import failed — the shell falls back to the text view */
  onImportFailed(message: string): void;
  /** element badge clicked (todo anchors) */
  onBadgeClick(elementId: string): void;
  /** canvas selection changed — feeds todo creation and the assist handoff */
  onSelectionChanged(elements: TodoElementWire[]): void;
}

export interface MountedEditor {
  /** element surface (reveal / badges / one-shot deep-link reveal) — the
   *  todo-canvas contract; absent = the notation has no element identity */
  elements?: TodoCanvas;
  destroy(): void;
}

/** a side panel the notation contributes (the DecisionChecksPanel pattern,
 *  made declarative) — fed the debounced live text while open */
export interface NotationPanelProps {
  repo: string;
  docPath: string;
  /** the live document text, debounced (~300ms) while the panel is open */
  content: string;
  onClose(): void;
}
export interface PanelSpec {
  /** unique within the shell's panel namespace — "history" and "todos" are
   *  RESERVED by the shell (enforced below at registration time) */
  id: string;
  /** toolbar button label */
  label: string;
  buttonTitle: string;
  icon: ComponentType<{ className?: string }>;
  /** lazy panel body — only whoever opens the panel pays for its deps */
  component: LazyExoticComponent<ComponentType<NotationPanelProps>>;
}

/** the visual history diff (Compare) — absent = Monaco text diff only */
export interface DiagramDiffProps {
  /** file content at the commit (left, read-only) */
  historical: string;
  /** live document snapshot (right, read-only) */
  current: string;
  /** one side failed to import — the dialog falls back to the text diff */
  onUnavailable(): void;
}
export interface DiffSpec {
  component: LazyExoticComponent<ComponentType<DiagramDiffProps>>;
  legend: ReadonlyArray<{ label: string; color: string }>;
}

export interface WebNotationPlugin {
  /** must match a NotationDescriptor.id (@bpmiq/notations) */
  id: string;
  /** css class of the canvas host (engine styling) */
  canvasClassName: string;
  /** mount the visual editor — the engine chunk loads HERE, not before;
   *  absent = collaborative Monaco (a plugin may contribute only panels/diff) */
  mountEditor?(container: HTMLElement, ctx: EditorContext): Promise<MountedEditor>;
  panels?: PanelSpec[];
  /** notation id of the Analyse-with-AI handoff — absent = no assist menu */
  assistNotation?: string;
  diff?: DiffSpec;
}

const WEB_PLUGINS: Record<string, WebNotationPlugin> = {
  bpmn: bpmnPlugin,
  dmn: dmnPlugin,
};

// the shell renders its own panels on these ids — a plugin colliding with them
// would open two panels behind one toolbar button. Fail LOUDLY at module load
// (a registration mistake must never ship as a subtle double-panel).
const RESERVED_PANEL_IDS = new Set(["history", "todos"]);
for (const plugin of Object.values(WEB_PLUGINS)) {
  for (const panel of plugin.panels ?? []) {
    if (RESERVED_PANEL_IDS.has(panel.id)) {
      throw new Error(`notation plugin '${plugin.id}' uses the reserved panel id '${panel.id}'`);
    }
  }
}

/** the plugin of a notation id — undefined = collaborative Monaco fallback */
export function webPlugin(notationId: string | undefined): WebNotationPlugin | undefined {
  return notationId ? WEB_PLUGINS[notationId] : undefined;
}
