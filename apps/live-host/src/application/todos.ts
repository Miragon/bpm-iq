/**
 * Todo use-cases shared by REST and MCP. Assembly, validation and the audit
 * line lived once per transport, with the trust gaps pointing in opposite
 * directions: REST stored the client's anchor (process AND file) verbatim and
 * never checked the process exists, while MCP resolved ids server-side but
 * anchored client paths unchecked and accepted empty element ids.
 *
 * One resolution now, for both: the anchor's process id (given, or the file
 * stem) MUST resolve through discovery — an unknown process is a typed 404,
 * never a stored anchor pointing at nothing. A client file is kept only when
 * it names that process (the platform contract: a path names its own process);
 * anything else normalizes to the discovered path. Elements drop empty ids.
 */
import type { TodoWire } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import type { Session } from "../adapters/sqlite/sessions.ts";
import type { IssueTracker } from "../ports/issue-tracker.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { type FindModelDeps, findProcessPath } from "./find-model.ts";

/** the process a model path belongs to — id IS the file stem (the content contract) */
const processIdOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.bpmn$/i, "");

export interface FileTodoInput {
  title: unknown;
  body?: unknown;
  /** process id (the .bpmn file stem) — this or `file` is required */
  process?: string;
  /** repo-relative model path (the id alternative; sub-process todos) */
  file?: string;
  elements?: Array<{ id?: unknown; name?: unknown }>;
  processVersion?: unknown;
}

/** validate, resolve the anchor, file the todo, write the audit line */
export async function fileTodo(
  opts: FindModelDeps,
  issues: IssueTracker,
  session: Session,
  repo: ConnectedRepo,
  input: FileTodoInput,
  via: "rest" | "mcp",
): Promise<TodoWire> {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new AppError("todos/title-required", "title must be a non-empty string", { status: 400, expose: true });
  }
  const process = input.process?.trim() || (input.file ? processIdOf(input.file) : undefined);
  if (!process) {
    throw new AppError("todos/anchor-required", "anchor.process must be a non-empty string", {
      status: 400,
      expose: true,
    });
  }
  // the existence gate BOTH transports lacked in one direction or the other
  const resolvedPath = await findProcessPath(opts, repo, process);
  const file = input.file && processIdOf(input.file) === process ? input.file : resolvedPath;

  const todo = await issues.createTodo(repo.fullName, {
    title: input.title.trim(),
    body: typeof input.body === "string" ? input.body : "",
    anchor: {
      process,
      file,
      elements: (input.elements ?? [])
        .filter((el) => typeof el?.id === "string" && el.id.length > 0)
        .map((el) => ({ id: el.id as string, name: typeof el.name === "string" ? el.name : null })),
      processVersion: typeof input.processVersion === "string" ? input.processVersion : null,
    },
    // attribution: the platform login of the SESSION is authoritative,
    // never a client-supplied author field
    author: session.user.login,
  });
  console.log(
    `todo created in ${repo.fullName} by @${session.user.login}${via === "mcp" ? " via mcp" : ""}: #${todo.id} "${todo.title}"`,
  );
  return todo;
}

/** close in the tracker (bot-authored, the session user attributed) + audit line */
export async function closeTodoFor(
  issues: IssueTracker,
  session: Session,
  repo: ConnectedRepo,
  todoId: string,
  via: "rest" | "mcp",
): Promise<void> {
  await issues.closeTodo(repo.fullName, todoId, session.user.login);
  console.log(
    `todo closed in ${repo.fullName} by @${session.user.login}${via === "mcp" ? " via mcp" : ""}: #${todoId}`,
  );
}
