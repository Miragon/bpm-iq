/**
 * Todo ↔ bpmn-js canvas integration — imperative, one controller per modeler,
 * same ownership rule as bindBpmn: created inside the live-editor attach effect,
 * torn down in its cleanup. Responsibilities:
 *
 *  - count badges (overlays service) on every element with ≥1 open anchored
 *    todo. importXML wipes all overlays, so every `import.done` — the initial
 *    load AND each debounced remote re-import — re-attaches them from the last
 *    todo list. Anchor ids that no longer exist in the diagram get no badge.
 *  - canvas selection → TodoElementWire[] (`selection.changed`) so React can
 *    anchor new todos to the current selection
 *  - reveal: select + scroll an anchored element into view (panel chip click)
 */
import type { TodoElementWire, TodoWire } from "@/lib/api";

/** minimal structural view of the bpmn-js services we touch (bindBpmn pattern) */
interface ElementLike {
  id: string;
  type?: string;
  businessObject?: { name?: string };
  labelTarget?: ElementLike;
}

interface SelectionChangedEvent {
  newSelection: ElementLike[];
}

interface OverlaysLike {
  add(
    element: string,
    type: string,
    overlay: { position: { top?: number; left?: number; right?: number; bottom?: number }; html: HTMLElement },
  ): string;
  remove(filter: { type: string }): void;
}

interface ModelerLike {
  get(service: "overlays"): OverlaysLike;
  get(service: "elementRegistry"): { get(id: string): ElementLike | undefined };
  get(service: "selection"): { select(elements: ElementLike[]): void };
  get(service: "canvas"): { scrollToElement(element: ElementLike, padding?: number): void };
  on(event: "import.done", callback: () => void): void;
  on(event: "selection.changed", callback: (event: SelectionChangedEvent) => void): void;
  off(event: "import.done", callback: () => void): void;
  off(event: "selection.changed", callback: (event: SelectionChangedEvent) => void): void;
}

export interface TodoCanvas {
  /** feed the current open-todo list; re-renders the badges immediately */
  setTodos(todos: TodoWire[]): void;
  /** select + scroll an element into view; false when the id is not in the diagram */
  reveal(elementId: string): boolean;
  destroy(): void;
}

/** overlay type marker — lets us remove exactly our badges before re-rendering */
const OVERLAY_TYPE = "bpm-todo-badge";

export function attachTodoCanvas(
  modeler: ModelerLike,
  hooks: {
    onBadgeClick: (elementId: string) => void;
    onSelectionChanged: (elements: TodoElementWire[]) => void;
  },
): TodoCanvas {
  let todos: TodoWire[] = [];

  const render = (): void => {
    const overlays = modeler.get("overlays");
    const registry = modeler.get("elementRegistry");
    overlays.remove({ type: OVERLAY_TYPE });
    const counts = new Map<string, number>();
    for (const todo of todos)
      for (const el of todo.anchor?.elements ?? []) counts.set(el.id, (counts.get(el.id) ?? 0) + 1);
    for (const [elementId, count] of counts) {
      if (!registry.get(elementId)) continue; // anchor id gone from the diagram — the panel still lists the todo
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "bpm-todo-badge";
      badge.textContent = String(count);
      badge.title = count === 1 ? "1 offenes Todo" : `${count} offene Todos`;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        hooks.onBadgeClick(elementId);
      });
      overlays.add(elementId, OVERLAY_TYPE, { position: { top: -8, right: 8 }, html: badge });
    }
  };

  const onImportDone = (): void => render();

  const onSelectionChanged = (event: SelectionChangedEvent): void => {
    const seen = new Set<string>();
    const elements: TodoElementWire[] = [];
    for (const raw of event.newSelection) {
      // an external label stands in for its host element
      const el = raw.type === "label" && raw.labelTarget ? raw.labelTarget : raw;
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      elements.push({ id: el.id, name: el.businessObject?.name || null });
    }
    hooks.onSelectionChanged(elements);
  };

  modeler.on("import.done", onImportDone);
  modeler.on("selection.changed", onSelectionChanged);

  return {
    setTodos(next) {
      todos = next;
      render();
    },
    reveal(elementId) {
      const el = modeler.get("elementRegistry").get(elementId);
      if (!el) return false;
      modeler.get("selection").select([el]);
      modeler.get("canvas").scrollToElement(el, 80);
      return true;
    },
    destroy() {
      modeler.off("import.done", onImportDone);
      modeler.off("selection.changed", onSelectionChanged);
      modeler.get("overlays").remove({ type: OVERLAY_TYPE });
    },
  };
}
