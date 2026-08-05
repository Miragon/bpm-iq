/**
 * The widget's MCP side: the ext-apps App handshake and typed wrappers around
 * the Live-Host tools it calls through the host bridge. App-initiated
 * tools/call rides the host's authenticated connection to POST /mcp — the same
 * per-call authorization as agent calls, no credential in the iframe.
 *
 * Tool results arrive as JSON in the first text content block (the `ok()`
 * helper in apps/live-host/src/http/mcp.ts) — parsed here, typed via the
 * shared wire contracts so server drift breaks the build, not the widget.
 *
 * Not every tool exists on every host: the todo tools are absent without a
 * configured tracker (and the write ones in read-only mode), exactly like
 * mint_ws_ticket. There is no tools/list over the app bridge, so absence is
 * detected on the first call — `isMissingTool` separates "capability absent"
 * (hide the UI) from a real tracker error (show it; those messages are
 * actionable).
 */
import type { ContentWire, PutContentResultWire, TodoElementWire, TodoWire } from "@bpmiq/contracts/live-host";
import { App } from "@modelcontextprotocol/ext-apps";

export interface BootConfig {
  readonly: boolean;
}

export interface ProcessRef {
  repo: string;
  id?: string;
  path?: string;
}

export interface ValidateResult {
  ok: boolean;
  findings: Array<{ severity: string; rule?: string; message: string }>;
}

/** save_bpmn_xml's tool-level shape (mcp.ts wraps the use-case result — the
 *  conflict is a retryable RESULT, not an error) */
export interface SaveConflict {
  ok: false;
  conflict: true;
  path: string;
  /** re-derive the edit against this and retry with the fresh baseVersion */
  currentXml: string;
  baseVersion: string;
  message: string;
}

export type SaveResult = ({ ok: true } & PutContentResultWire) | SaveConflict;
// PutContentResultWire.errors carries ERROR findings on lint:"warn" saves

/** the host-injected marker (mcp.ts replaces it); a raw marker means the file
 *  is served outside the Live Host (dev preview) — default to editable */
export function bootConfig(): BootConfig {
  const raw = (window as { BPMIQ_BOOT?: unknown }).BPMIQ_BOOT;
  if (typeof raw === "string" && !raw.startsWith("__")) {
    try {
      return JSON.parse(raw) as BootConfig;
    } catch {
      /* fall through to the default */
    }
  }
  return { readonly: false };
}

export function makeApp(): App {
  return new App({ name: "bpmiq-modeler", version: "1.0.0" });
}

/** one tool call → parsed JSON payload; tool `isError` becomes a throw with
 *  the server's agent-readable message (the widget shows it verbatim) */
async function call<T>(app: App, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content?.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  return JSON.parse(text) as T;
}

export const getBpmnXml = (app: App, ref: ProcessRef): Promise<ContentWire> => call(app, "get_bpmn_xml", { ...ref });

export const validateBpmn = (app: App, xml: string, ref: ProcessRef): Promise<ValidateResult> =>
  call(app, "validate_bpmn", { xml, repo: ref.repo, path: ref.path });

/** lint:"warn" — the widget autosaves like the live rooms do: findings inform,
 *  never block; the strict default stays for agent saves */
export const saveBpmnXml = (app: App, ref: ProcessRef, xml: string, baseVersion: string): Promise<SaveResult> =>
  call(app, "save_bpmn_xml", { repo: ref.repo, path: ref.path, xml, baseVersion, lint: "warn" });

export interface WsTicket {
  ticket: string;
  url: string;
  room: string;
  expiresInSeconds: number;
}

/** single-use ticket for the live Yjs connection — write-gated at mint time */
export const mintWsTicket = (app: App, ref: ProcessRef): Promise<WsTicket> =>
  call(app, "mint_ws_ticket", { repo: ref.repo, path: ref.path });

// ── todos (model-anchored work items in the repo's own tracker) ──────────────

/** the SDK answers an unregistered tool with "Tool <name> not found" — that is
 *  a MISSING CAPABILITY (no tracker configured, or the read-only surface), not
 *  a failure to report. Both markers must match: a tool's own "… not found"
 *  message (an unknown process, say) is a real error and must not silently
 *  disable a feature. */
export const isMissingTool = (err: unknown, tool: string): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(tool) && /not found/i.test(message);
};

/** OPEN todos of ONE process (the widget always scopes to the open document) */
export const listTodos = (app: App, ref: ProcessRef): Promise<{ todos: TodoWire[] }> =>
  call(app, "list_todos", { repo: ref.repo, path: ref.path });

export interface CreateTodoInput {
  title: string;
  body?: string;
  /** canvas selection at submit time — empty ⇒ a process-level todo */
  elements: TodoElementWire[];
}

export const createTodo = (app: App, ref: ProcessRef, input: CreateTodoInput): Promise<{ todo: TodoWire }> =>
  call(app, "create_todo", { repo: ref.repo, path: ref.path, ...input });

export const closeTodo = (app: App, repo: string, todoId: string): Promise<{ ok: true }> =>
  call(app, "close_todo", { repo, todoId });

/** newest widget instance wins: every boot broadcasts; older instances for the
 *  same doc disable themselves (all app iframes of a connector share an origin).
 *  Returns the release — a re-claiming widget MUST release its previous claim
 *  first, or its own broadcast supersedes itself. */
export function claimDocument(key: string, onSuperseded: () => void): () => void {
  const channel = new BroadcastChannel(`bpmiq-modeler:${key}`);
  const stamp = Date.now() + Math.random();
  channel.postMessage(stamp);
  channel.onmessage = (e: MessageEvent<number>) => {
    if (e.data !== stamp) onSuperseded();
  };
  return () => channel.close();
}
