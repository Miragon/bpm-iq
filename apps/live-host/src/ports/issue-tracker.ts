/**
 * IssueTracker — the third provider seam: model-anchored work items ("todos")
 * live as first-class items in the customer's OWN tracker, never in a
 * platform database.
 *
 * GitHub implements it with repo Issues + labels (adapters/github/issues.ts).
 * GitLab maps 1:1 onto project issues. Jira maps a repo to a project via
 * adapter config and issue ids look like "PROJ-123" — which is why `Todo.id`
 * is an opaque string and why nothing in this contract assumes numbers,
 * labels, or markdown. Anchor semantics (which process, which BPMN elements)
 * are platform domain — domain/todo-anchor.ts owns the codec; adapters only
 * decide WHERE the encoded block lives (GitHub: issue body).
 */
import type { TodoAnchor } from "../domain/todo-anchor.ts";

export interface TodoInput {
  title: string;
  /** free text from the author — tracker-agnostic; adapters add their own markup */
  body: string;
  anchor: TodoAnchor;
  /** platform login of the human author (items are bot-authored, attribution is textual) */
  author: string;
}

export interface Todo {
  /** tracker-native id as a string (GitHub/GitLab: issue number; Jira: "PROJ-123") */
  id: string;
  /** canonical human URL of the item in the tracker */
  url: string;
  title: string;
  state: "open" | "done";
  /** null = item carries no parseable anchor (e.g. created by hand) — still a
   *  process-level todo when the tracker-side filter matched */
  anchor: TodoAnchor | null;
  /** attributed platform login when known */
  author: string | null;
  assignees: string[];
  /** ISO timestamp */
  createdAt: string;
}

export interface IssueTracker {
  /** id used in logs ("github-issues") */
  readonly id: string;
  /** create a todo in the tracker backing this repo; returns the created item */
  createTodo(repoFullName: string, input: TodoInput): Promise<Todo>;
  /** OPEN todos for one repo, optionally narrowed to a process */
  listTodos(repoFullName: string, processId?: string): Promise<Todo[]>;
}
