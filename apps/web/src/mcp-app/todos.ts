/**
 * Todos in the modeler widget: the same model-anchored work items the web SPA
 * shows (components/todo-panel.tsx), driven over the app bridge instead of
 * REST — list_todos / create_todo / close_todo on the Live Host's /mcp.
 *
 * Canvas integration is the SHARED controller (lib/todo-canvas.ts): count
 * badges per anchored element, badge click → the panel filtered to it,
 * selection → the anchor a new todo gets. It re-renders on every `import.done`,
 * so live (Yjs) re-imports keep their badges.
 *
 * Capability-driven, never assumed: the todo tools are absent without a
 * configured tracker, and the write ones in read-only mode. The first call
 * decides — a missing tool hides the feature (isMissingTool), any other failure
 * is a real tracker error and is shown verbatim (permission messages are
 * actionable). The modeler itself is never blocked by any of it.
 *
 * The panel DOM lives in mcp-app.html; only the list and the anchor chips are
 * rebuilt here — the compose form keeps its own input state across renders.
 */
import type { TodoElementWire, TodoWire } from "@bpmiq/contracts/live-host";
import type { App } from "@modelcontextprotocol/ext-apps";

import { attachTodoCanvas, type TodoCanvas } from "@/lib/todo-canvas";

import { closeTodo, createTodo, isMissingTool, listTodos } from "./bridge";
import type { ModelerHandle } from "./modeler";
import { implementPrompt, type PromptTarget } from "./todo-prompt";

export interface TodosHandle {
  /** point the panel at the document now open and refresh from the tracker */
  load(ref: PromptTarget): void;
  destroy(): void;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function mountTodos(app: App, modeler: ModelerHandle, opts: { readonly: boolean }): TodosHandle {
  const toggle = el<HTMLButtonElement>("todo-toggle");
  const panel = el<HTMLElement>("todos");
  const countEl = el<HTMLSpanElement>("todo-count");
  const listEl = el<HTMLDivElement>("todo-list");
  const errorEl = el<HTMLDivElement>("todo-error");
  const filterBar = el<HTMLDivElement>("todo-filter");
  const filterName = el<HTMLSpanElement>("todo-filter-name");
  const form = el<HTMLFormElement>("todo-form");
  const anchorEl = el<HTMLDivElement>("todo-anchor");
  const titleInput = el<HTMLInputElement>("todo-title");
  const bodyInput = el<HTMLTextAreaElement>("todo-body");
  const submitBtn = el<HTMLButtonElement>("todo-submit");
  const newBtn = el<HTMLButtonElement>("todo-new");

  let ref: PromptTarget | undefined;
  let todos: TodoWire[] = [];
  let selection: TodoElementWire[] = [];
  let filter: string | null = null; // element id a badge click narrowed to
  let error = "";
  let loading = false;
  let creating = false;
  const closing = new Set<string>(); // todo ids with a close in flight
  let absent = false; // no tracker on this host — the feature stays hidden
  let discovered = false; // a list call came back — only THEN is the button real
  //   (showing it first would flash a control that may not exist)
  let canWrite = !opts.readonly; // flipped off if create/close turn out absent
  let epoch = 0; // bumps on load() — stale async results bail out

  const canvas: TodoCanvas = attachTodoCanvas(modeler.raw as never, {
    onBadgeClick: (elementId) => {
      filter = elementId;
      openPanel();
      render();
    },
    onSelectionChanged: (elements) => {
      selection = elements;
      renderAnchor();
    },
  });

  // ── rendering ─────────────────────────────────────────────────────────────

  const visible = (): TodoWire[] =>
    filter ? todos.filter((t) => t.anchor?.elements.some((e) => e.id === filter)) : todos;

  function renderAnchor(): void {
    anchorEl.textContent = "";
    if (selection.length === 0) {
      anchorEl.append("No element selected — this todo applies to the whole process.");
      return;
    }
    anchorEl.append("Anchored to: ");
    for (const element of selection) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = element.name ?? element.id;
      chip.title = element.id;
      anchorEl.append(chip);
    }
  }

  function renderRow(todo: TodoWire): HTMLElement {
    const row = document.createElement("div");
    row.className = "todo";
    if (closing.has(todo.id)) row.classList.add("busy");

    const head = document.createElement("div");
    head.className = "todo-head";
    const title = document.createElement("span");
    title.className = "todo-title";
    title.textContent = todo.title;
    // the description stays out of the cramped list, but is one hover away
    // (and rides along in full when the todo is handed to the assistant)
    if (todo.body) title.title = todo.body;
    // a BUTTON, not an <a target="_blank">: the app sandbox blocks navigation,
    // so the host opens the link for us (openTracker)
    const link = document.createElement("button");
    link.type = "button";
    link.className = "todo-link";
    link.textContent = "↗";
    link.title = `Open #${todo.id} in the tracker`;
    link.onclick = () => void openTracker(todo.url);
    head.append(title, link);
    row.append(head);

    const elements = todo.anchor?.elements ?? [];
    if (elements.length > 0) {
      const chips = document.createElement("div");
      chips.className = "todo-chips";
      for (const element of elements) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = element.name ?? element.id;
        // an anchor whose element is gone from the diagram stays listed — only
        // the reveal is unavailable (the todo is still real work)
        chip.title = element.id;
        chip.onclick = () => {
          if (!canvas.reveal(element.id)) chip.title = `${element.id} — no longer in this diagram`;
        };
        chips.append(chip);
      }
      row.append(chips);
    }

    const meta = document.createElement("div");
    meta.className = "todo-meta";
    const id = document.createElement("span");
    id.textContent = `#${todo.id}${todo.author ? ` · @${todo.author}` : ""}`;
    meta.append(id);
    if (canWrite) {
      // hand the work to the assistant instead of doing it by hand — the
      // prompt carries the whole order (read → edit → validate → save → close)
      const implement = document.createElement("button");
      implement.type = "button";
      implement.className = "todo-implement";
      implement.textContent = "✦ Implement";
      implement.title = "Ask the assistant to do this: read the model, make the edit, validate, save, close the todo";
      implement.onclick = () => void handOver(todo);
      const done = document.createElement("button");
      done.type = "button";
      done.className = "todo-done";
      done.textContent = closing.has(todo.id) ? "Closing…" : "✓ Done";
      done.title = `Close #${todo.id} in the tracker`;
      done.disabled = closing.has(todo.id);
      done.onclick = () => void complete(todo.id);
      meta.append(implement, done);
    }
    row.append(meta);
    return row;
  }

  function render(): void {
    toggle.hidden = absent || !discovered;
    toggle.textContent = `Todos${todos.length > 0 ? ` (${todos.length})` : ""}`;
    countEl.textContent = filter ? `${visible().length} of ${todos.length}` : String(todos.length);
    newBtn.hidden = !canWrite;
    errorEl.hidden = error.length === 0;
    errorEl.textContent = error;
    filterBar.hidden = filter === null;
    if (filter) {
      // the creation-time name snapshot keeps the chip readable after a rename
      const named = todos.flatMap((t) => t.anchor?.elements ?? []).find((e) => e.id === filter && e.name);
      filterName.textContent = named?.name ?? filter;
      filterName.title = filter;
    }
    listEl.textContent = "";
    const rows = visible();
    if (loading && todos.length === 0) {
      listEl.append(empty("Loading…"));
    } else if (rows.length === 0) {
      listEl.append(empty(filter ? "No open todos on this element." : "No open todos for this process."));
    } else {
      for (const todo of rows) listEl.append(renderRow(todo));
    }
    canvas.setTodos(todos);
  }

  function empty(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "todo-empty";
    p.textContent = text;
    return p;
  }

  // ── panel state ───────────────────────────────────────────────────────────

  function openPanel(): void {
    panel.hidden = false;
  }

  function closePanel(): void {
    panel.hidden = true;
    form.hidden = true;
  }

  // ── host actions (link, prompt) ───────────────────────────────────────────

  /** the app sandbox blocks navigation, so the HOST opens tracker links
   *  (`ui/open-link`). A denial or a missing bridge (the dev preview outside a
   *  host) falls back to window.open; if that is blocked too, say so instead of
   *  swallowing the click. */
  async function openTracker(url: string): Promise<void> {
    try {
      const { isError } = await app.openLink({ url });
      if (!isError) return;
    } catch {
      /* no host bridge — try the browser directly */
    }
    if (window.open(url, "_blank", "noopener")) return;
    error = `Could not open ${url} — your client blocked it.`;
    render();
  }

  /** hand the todo to the assistant: inject the work order as a user message
   *  (`ui/message`) and step out of the way — the answer lands in the CHAT, so
   *  a fullscreen widget would otherwise hide the very thing it just asked for */
  async function handOver(todo: TodoWire): Promise<void> {
    if (!ref) return;
    const prompt = implementPrompt(todo, ref);
    try {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
      if (result.isError) {
        error = `Your client refused the prompt — open #${todo.id} in the tracker and ask there.`;
        render();
        return;
      }
      void app.requestDisplayMode({ mode: "inline" });
      closePanel();
      render();
    } catch (err) {
      error = `Could not hand #${todo.id} to the assistant: ${(err as Error).message}`;
      render();
    }
  }

  // ── tracker calls ─────────────────────────────────────────────────────────

  /** refresh from the tracker; the FIRST failure decides whether the feature
   *  exists at all on this host (absent → hidden, forever quiet) */
  async function refresh(): Promise<void> {
    // `loading` is per DOCUMENT: load() clears it, so a re-open never inherits
    // the previous document's in-flight call (that one bails on the epoch)
    if (!ref || absent || loading) return;
    const mine = epoch;
    loading = true;
    render();
    try {
      const result = await listTodos(app, ref);
      if (mine !== epoch) return; // another document owns the panel now
      todos = result.todos;
      discovered = true;
      error = "";
    } catch (err) {
      if (mine !== epoch) return;
      if (isMissingTool(err, "list_todos")) {
        absent = true;
        todos = [];
        closePanel();
      } else {
        // the tracker exists but refused (permission, upstream outage) — the
        // message is actionable, so surface the feature WITH its error
        discovered = true;
        error = `Could not load todos: ${(err as Error).message}`;
      }
    } finally {
      if (mine === epoch) {
        loading = false;
        render();
      }
    }
  }

  async function complete(todoId: string): Promise<void> {
    if (!ref || closing.has(todoId)) return;
    const mine = epoch;
    closing.add(todoId);
    render();
    try {
      await closeTodo(app, ref.repo, todoId);
      if (mine !== epoch) return;
      // drop the row right away — badges and counts follow from the same list
      todos = todos.filter((t) => t.id !== todoId);
      error = "";
      void app.updateModelContext({
        content: [{ type: "text", text: `User closed todo #${todoId} in ${ref.repo} from the modeler widget.` }],
      });
    } catch (err) {
      if (mine !== epoch) return;
      if (isMissingTool(err, "close_todo")) {
        canWrite = false;
        error = "This host opened the model read-only — closing todos is disabled.";
      } else {
        error = `Could not close #${todoId}: ${(err as Error).message}`;
      }
    } finally {
      closing.delete(todoId);
      if (mine === epoch) render();
    }
  }

  async function submit(): Promise<void> {
    const title = titleInput.value.trim();
    if (!ref || creating || title.length === 0) return;
    const mine = epoch;
    creating = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      // the anchor is the selection at SUBMIT time — the chips above the form
      // track it live, so what the user last saw is what gets anchored
      const { todo } = await createTodo(app, ref, { title, body: bodyInput.value.trim(), elements: selection });
      if (mine !== epoch) return;
      todos = [todo, ...todos];
      error = "";
      titleInput.value = "";
      bodyInput.value = "";
      form.hidden = true;
      void app.updateModelContext({
        content: [{ type: "text", text: `User filed todo #${todo.id} "${todo.title}" from the modeler widget.` }],
      });
    } catch (err) {
      if (mine !== epoch) return;
      if (isMissingTool(err, "create_todo")) {
        canWrite = false;
        error = "This host opened the model read-only — filing todos is disabled.";
        form.hidden = true;
      } else {
        error = `Could not create the todo: ${(err as Error).message}`;
      }
    } finally {
      creating = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Create todo";
      if (mine === epoch) render();
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  toggle.onclick = () => {
    if (panel.hidden) {
      filter = null;
      openPanel();
      void refresh(); // the tracker moves outside this widget — re-read on open
    } else {
      closePanel();
    }
    render();
  };
  el<HTMLButtonElement>("todo-hide").onclick = () => {
    closePanel();
    render();
  };
  el<HTMLButtonElement>("todo-refresh").onclick = () => void refresh();
  el<HTMLButtonElement>("todo-filter-clear").onclick = () => {
    filter = null;
    render();
  };
  newBtn.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      renderAnchor();
      titleInput.focus();
    }
  };
  el<HTMLButtonElement>("todo-cancel").onclick = () => {
    form.hidden = true;
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void submit();
  };

  return {
    load(next) {
      epoch++;
      ref = next;
      todos = [];
      selection = [];
      filter = null;
      error = "";
      loading = false;
      closing.clear();
      form.hidden = true;
      renderAnchor();
      render();
      void refresh(); // badges must be there before the panel is ever opened
    },
    destroy() {
      epoch++;
      canvas.destroy();
      closePanel();
      toggle.hidden = true;
    },
  };
}
