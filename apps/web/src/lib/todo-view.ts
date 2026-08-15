/**
 * Shared todo view-model derivations of the SPA panel (components/
 * todo-panel.tsx) and the MCP-App widget (mcp-app/todos.ts) — the two
 * frontends render differently (JSX vs imperative DOM) but must answer these
 * questions identically. Framework-free, like lib/todo-canvas.ts.
 */
import type { TodoWire } from "@bpmiq/contracts/live-host";

/** the todos anchored to ONE element (the canvas-badge filter) */
export const todosForElement = (todos: TodoWire[], elementId: string): TodoWire[] =>
  todos.filter((t) => t.anchor?.elements.some((el) => el.id === elementId));

/** display label of a filtered element: the creation-time name snapshot from
 *  any todo that carries one, else the raw id — readable after a rename */
export const elementLabel = (todos: TodoWire[], elementId: string): string =>
  todos.flatMap((t) => t.anchor?.elements ?? []).find((el) => el.id === elementId && el.name)?.name ?? elementId;

/** the empty-list line — the filtered/unfiltered wording is shared vocabulary */
export const emptyTodoMessage = (filtered: boolean): string =>
  filtered ? "No open todos on this element." : "No open todos for this process.";

export const openInTrackerTitle = (id: string): string => `Open #${id} in the tracker`;
export const closeInTrackerTitle = (id: string): string => `Close #${id} in the tracker`;
