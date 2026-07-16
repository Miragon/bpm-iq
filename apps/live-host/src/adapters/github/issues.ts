/**
 * GitHub implementation of the IssueTracker port — todos are repo ISSUES in
 * the customer's own repository, never rows in a platform database. Each todo
 * carries the `todo` label plus `process:<id>` for the anchored process; the
 * platform anchor block (the codec lives in @bpmiq/contracts/todo-anchor (mcp needs it too)) lives invisibly
 * at the top of the issue body, followed by the author's text and a textual
 * attribution line (issues are bot-authored via the installation token, the
 * human stays attributed — same model as releases, ADR 0001).
 *
 * Deps are INJECTED (composed in server.ts): `tokenFor` resolves a repo to its
 * installation token through the registry + TokenService, so this module never
 * reads env and works identically in standalone (local app key) and cell mode
 * (remote mint). Nothing GitHub-specific leaks through the port — GitLab/Jira
 * implement the same contract against their own issue APIs.
 */
import { encodeAnchor, parseAnchor, type TodoAnchor } from "@bpmiq/contracts/todo-anchor";
import { paginate } from "@bpmiq/github-app";
import { AppError } from "@bpmiq/http-kit";

import type { IssueTracker, Todo, TodoInput } from "../../ports/issue-tracker.ts";
import { githubApi } from "./app-auth.ts";

/** the label every platform-managed todo carries */
export const TODO_LABEL = "todo";

/** the per-process label that makes the tracker-side filter cheap */
export const processLabel = (processId: string): string => `process:${processId}`;

/** attribution line appended to every created issue (items are bot-authored) */
export const attributionLine = (author: string): string => `_Created from the bpmiq live model by @${author}_`;

const ATTRIBUTION_RE = /_Created from the bpmiq live model by @([A-Za-z0-9-]+)_/;

/** attribution comment posted before closing (the close itself is bot-authored) */
export const closeAttributionLine = (closedBy: string): string => `_Closed from the bpmiq live model by @${closedBy}_`;

/** parse the platform author back out of an issue body (null: created by hand) */
export function parseAuthor(body: string): string | null {
  return ATTRIBUTION_RE.exec(body)?.[1] ?? null;
}

/** where a todo's deep links point: the web app served at the live host's public URL */
export interface DeepLinkTarget {
  /** the live host's public origin (PUBLIC_URL in server.ts), no trailing slash needed */
  publicUrl: string;
  repoFullName: string;
}

/** one 📍 line per anchored element, linking into the web app's process-editor
 * route (`/r/$owner/$repo/p/$processId`, TanStack router — apps/web/src/router.tsx).
 * The repo segment is split at the FIRST slash: GitHub is always owner/name;
 * GitLab subgroups (multi-segment repos) need the router to capture the repo as
 * a splat first — mirror of the comment in apps/web/src/router.tsx. */
function deepLinkLines(anchor: TodoAnchor, target: DeepLinkTarget): string {
  const slash = target.repoFullName.indexOf("/");
  const owner = slash === -1 ? target.repoFullName : target.repoFullName.slice(0, slash);
  const repo = slash === -1 ? "" : target.repoFullName.slice(slash + 1);
  const base = target.publicUrl.replace(/\/$/, "");
  return anchor.elements
    .map((el) => {
      const url =
        `${base}/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/p/${encodeURIComponent(anchor.process)}?element=${encodeURIComponent(el.id)}`;
      return `📍 [${el.name ?? el.id}](${url})`;
    })
    .join("\n");
}

/** anchor block + author text + element deep links + attribution, blank-line separated */
export function todoBody(input: TodoInput, deepLink?: DeepLinkTarget): string {
  return [
    encodeAnchor(input.anchor),
    input.body.trim(),
    deepLink ? deepLinkLines(input.anchor, deepLink) : "",
    attributionLine(input.author),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export interface GitHubIssuesDeps {
  /** REST base, e.g. https://api.github.com */
  apiUrl: string;
  /** installation token for ONE repo — server.ts composes registry → TokenService */
  tokenFor(repoFullName: string): Promise<string>;
  /** the live host's public URL — when set, issue bodies carry 📍 deep links
   * into the web app's process editor for every anchored element */
  publicUrl?: string;
}

/** the slice of GitHub's issue wire shape this adapter maps */
interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string | null;
  assignees?: Array<{ login: string }>;
  created_at: string;
  /** present on PULL REQUESTS — GitHub returns them in the issues list */
  pull_request?: unknown;
}

/** a 403 here means the app was registered without the Issues permission
 * (apps created before the manifest gained `issues: write`) — user-actionable */
function issuesPermissionError(repoFullName: string): AppError {
  return new AppError(
    "todos/issues-permission-missing",
    `GitHub refused issue access on ${repoFullName}: the GitHub App lacks the "Issues: Read and write" permission. ` +
      `Add it in the app's settings — EXISTING installations must then approve the added permission ` +
      `(GitHub prompts the org owner) before todos work.`,
    { status: 403, expose: true },
  );
}

export function createGitHubIssueTracker(deps: GitHubIssuesDeps): IssueTracker {
  const api = deps.apiUrl.replace(/\/$/, "");

  const rest = async (token: string, path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "bpm-live-host",
        ...(init.headers ?? {}),
      },
    });

  /** read the error body and throw — mapping the missing-permission 403 to an AppError */
  async function raise(res: Response, repoFullName: string, what: string): Promise<never> {
    const text = await res.text();
    if (res.status === 403 && text.includes("Resource not accessible")) throw issuesPermissionError(repoFullName);
    throw new Error(`${what} → ${res.status} ${text}`);
  }

  /** create a label, tolerating "already exists" (422) — labels are idempotent state */
  async function ensureLabel(
    token: string,
    repoFullName: string,
    label: { name: string; color: string; description: string },
  ): Promise<void> {
    const res = await rest(token, `/repos/${repoFullName}/labels`, { method: "POST", body: JSON.stringify(label) });
    if (res.ok || res.status === 422) {
      await res.text(); // drain the body either way (undici keep-alive hygiene)
      return;
    }
    await raise(res, repoFullName, `label '${label.name}' creation in ${repoFullName}`);
  }

  function toTodo(issue: GitHubIssue): Todo {
    const body = issue.body ?? "";
    return {
      id: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      state: issue.state === "closed" ? "done" : "open",
      anchor: parseAnchor(body),
      author: parseAuthor(body),
      assignees: (issue.assignees ?? []).map((a) => a.login),
      createdAt: issue.created_at,
    };
  }

  return {
    id: "github-issues",

    async createTodo(repoFullName, input) {
      const token = await deps.tokenFor(repoFullName);
      await ensureLabel(token, repoFullName, {
        name: TODO_LABEL,
        color: "fa8100",
        description: "bpmiq model-anchored todo",
      });
      await ensureLabel(token, repoFullName, {
        name: processLabel(input.anchor.process),
        color: "ededed",
        description: `bpmiq process ${input.anchor.process}`,
      });
      const res = await rest(token, `/repos/${repoFullName}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: todoBody(input, deps.publicUrl ? { publicUrl: deps.publicUrl, repoFullName } : undefined),
          labels: [TODO_LABEL, processLabel(input.anchor.process)],
        }),
      });
      if (!res.ok) await raise(res, repoFullName, `issue creation in ${repoFullName}`);
      return toTodo((await res.json()) as GitHubIssue);
    },

    async listTodos(repoFullName, processId) {
      const token = await deps.tokenFor(repoFullName);
      const labels = processId ? `${TODO_LABEL},${processLabel(processId)}` : TODO_LABEL;
      const path = `/repos/${repoFullName}/issues?state=open&labels=${encodeURIComponent(labels)}&per_page=100`;
      let issues: GitHubIssue[];
      try {
        issues = (await paginate(githubApi(api), path, { token })) as GitHubIssue[];
      } catch (e) {
        // paginate throws plain Errors carrying "<path> → <status> <body>"
        const message = (e as Error).message;
        if (message.includes("→ 403") && message.includes("Resource not accessible")) {
          throw issuesPermissionError(repoFullName);
        }
        throw e;
      }
      // GitHub's issues list INCLUDES pull requests (they carry a pull_request key)
      return issues.filter((issue) => issue.pull_request === undefined).map(toTodo);
    },

    async closeTodo(repoFullName, id, closedBy) {
      const token = await deps.tokenFor(repoFullName);
      // attribution first — a closed issue without the trail would look bot-arbitrary
      const comment = await rest(token, `/repos/${repoFullName}/issues/${id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: closeAttributionLine(closedBy) }),
      });
      if (!comment.ok) await raise(comment, repoFullName, `todo #${id} close attribution`);
      await comment.text();
      const res = await rest(token, `/repos/${repoFullName}/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      if (!res.ok) await raise(res, repoFullName, `todo #${id} close`);
      await res.text();
    },
  };
}
