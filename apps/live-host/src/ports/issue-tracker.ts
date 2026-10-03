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
 * are platform domain — the codec lives in @designiq/contracts/todo-anchor (mcp needs it too); adapters only
 * decide WHERE the encoded block lives (GitHub: issue body).
 */
import type { TodoAnchor } from "@designiq/contracts/todo-anchor";

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
  /** the AUTHOR's description, adapter markup stripped ("" when there is none) —
   *  what a human reads, and what an agent needs to act on the item */
  body: string;
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

/** where a todo is re-anchored to — a renamed process (#208) */
export interface TodoTarget {
  /** the process id (the .bpmn file stem) */
  process: string;
  /** its repo-relative model file */
  file: string;
}

/**
 * The tracker asked us to slow down (GitHub: a secondary rate limit, 403/429
 * with retry-after). Not a failure of the item — the caller waits
 * `retryAfterMs` and tries the same item again.
 */
export class TrackerRateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "the tracker asked to slow down") {
    super(message);
    this.name = "TrackerRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface IssueTracker {
  /** id used in logs ("github-issues") */
  readonly id: string;
  /** create a todo in the tracker backing this repo; returns the created item */
  createTodo(repoFullName: string, input: TodoInput): Promise<Todo>;
  /** OPEN todos for one repo, optionally narrowed to a process */
  listTodos(repoFullName: string, processId?: string): Promise<Todo[]>;
  /** close one todo; closedBy = platform login (attribution is textual, items stay bot-authored) */
  closeTodo(repoFullName: string, id: string, closedBy: string): Promise<void>;
  /** re-anchor ONE todo from process `from` to `to` (a rename, #208): the
   *  tracker-side process filter and the anchor both name `to` afterwards.
   *  Idempotent — an item already on `to` comes back "unchanged". Throws
   *  TrackerRateLimited when the tracker asks to slow down; the pacing of a
   *  batch is the caller's (application/todo-jobs.ts). */
  retargetTodo(repoFullName: string, id: string, from: string, to: TodoTarget): Promise<"moved" | "unchanged">;
}
