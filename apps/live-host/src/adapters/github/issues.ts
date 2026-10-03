/**
 * GitHub implementation of the IssueTracker port — todos are repo ISSUES in
 * the customer's own repository, never rows in a platform database. Each todo
 * carries the `todo` label plus `process:<id>` for the anchored process; the
 * platform anchor block (the codec lives in @designiq/contracts/todo-anchor (mcp needs it too)) lives invisibly
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
import { processDeepLink } from "@designiq/contracts/deep-link";
import {
  encodeAnchor,
  parseAnchor,
  replaceAnchor,
  stripAnchor,
  type TodoAnchor,
} from "@designiq/contracts/todo-anchor";
import { GitHubHttpError, paginate, tokenRest } from "@designiq/github-app";
import {
  type GitHubIssueRow,
  isPullRequestRow,
  processLabel,
  TODO_LABEL,
  todoLabelQuery,
} from "@designiq/github-app/todos";
import { AppError } from "@designiq/http-kit";

import {
  type IssueTracker,
  type Todo,
  type TodoInput,
  type TodoTarget,
  TrackerRateLimited,
} from "../../ports/issue-tracker.ts";
import { githubApi } from "./app-auth.ts";

/** attribution line appended to every created issue (items are bot-authored) */
export const attributionLine = (author: string): string => `_Created from the bpmiq live model by @${author}_`;

/**
 * Reads the attribution in BOTH product spellings — the legacy one and
 * "designIQ", which hosts write once the product is renamed: hosts are upgraded
 * one by one, so an older host must already name the author of an issue a
 * newer one filed. The legacy alternative stays for good — those bodies are
 * stored in customer trackers and are never rewritten. Only the new name
 * matches case-insensitively (`(?i:…)` scopes the flag to it): a line re-cased
 * by hand must not lose its author, while the legacy spelling and the rest of
 * the sentence keep matching exactly as they always did.
 */
const ATTRIBUTION_RE = /_Created from the (?:bpmiq|(?i:designiq)) live model by @([A-Za-z0-9-]+)_/; // legacy-name-ok: stored in customer trackers

/** attribution comment posted before closing (the close itself is bot-authored) */
export const closeAttributionLine = (closedBy: string): string => `_Closed from the bpmiq live model by @${closedBy}_`;

/** parse the platform author back out of an issue body (null: created by hand) */
export function parseAuthor(body: string): string | null {
  return ATTRIBUTION_RE.exec(body)?.[1] ?? null;
}

/** one 📍 deep-link line as todoBody writes it (below) — greedy on purpose:
 *  the link text carries the RAW element name (which may contain `]`) and
 *  encodeURIComponent leaves parentheses in the URL unescaped */
const DEEP_LINK_RE = /^📍 \[.*\]\(.*\)$/gm;

/** the AUTHOR's text: the stored body minus everything todoBody added around it
 *  (anchor block, element deep links, attribution). A hand-filed issue carries
 *  none of that and comes back whole. */
export function parseBody(body: string): string {
  return stripAnchor(body)
    .replace(DEEP_LINK_RE, "")
    .replace(ATTRIBUTION_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** where a todo's deep links point: the web app served at the live host's public URL */
export interface DeepLinkTarget {
  /** the live host's public origin (PUBLIC_URL in server.ts), no trailing slash needed */
  publicUrl: string;
  repoFullName: string;
}

/** one 📍 line per anchored element, linking into the web app's process-editor
 * route — the URL shape is the shared @designiq/contracts/deep-link builder (the
 * widget button and the open_modeler result build the very same links) */
function deepLinkLines(anchor: TodoAnchor, target: DeepLinkTarget): string {
  return anchor.elements
    .map((el) => {
      const url = processDeepLink(target.publicUrl, target.repoFullName, anchor.process, el.id);
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

/**
 * The body of a todo re-anchored from process `from` to `to` (#208): the
 * anchor block names the new process and file, the element deep links point
 * at the new process route — every other byte (the author's text, human
 * edits made on GitHub, the attribution) stays as it is. A body whose anchor
 * names another process (or none — filed by hand) comes back unchanged.
 */
export function retargetBody(body: string, from: string, to: TodoTarget, deepLink?: DeepLinkTarget): string {
  const anchor = parseAnchor(body);
  if (!anchor || anchor.process !== from) return body;
  let out = replaceAnchor(body, { ...anchor, process: to.process, file: to.file });
  if (deepLink) {
    for (const el of anchor.elements) {
      const link = (process: string) => processDeepLink(deepLink.publicUrl, deepLink.repoFullName, process, el.id);
      out = out.split(`(${link(from)})`).join(`(${link(to.process)})`);
    }
  }
  return out;
}

/** GitHub's "slow down": a 403/429 carrying retry-after, an exhausted primary
 *  quota, or the secondary-rate-limit message — the wait it asks for, else
 *  undefined (a real refusal). */
export function rateLimitWait(
  res: Pick<Response, "status" | "headers">,
  text: string,
  now = Date.now(),
): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    return Number.isFinite(reset) && reset > now ? reset - now : 60_000;
  }
  // secondary limits without headers: GitHub asks for at least a minute
  return /rate limit/i.test(text) ? 60_000 : undefined;
}

export interface GitHubIssueRowsDeps {
  /** REST base, e.g. https://api.github.com */
  apiUrl: string;
  /** installation token for ONE repo — server.ts composes registry → TokenService */
  tokenFor(repoFullName: string): Promise<string>;
  /** the live host's public URL — when set, issue bodies carry 📍 deep links
   * into the web app's process editor for every anchored element */
  publicUrl?: string;
}

/** the slice of GitHub's issue wire shape this adapter maps */
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

export function createGitHubIssueTracker(deps: GitHubIssueRowsDeps): IssueTracker {
  const api = deps.apiUrl.replace(/\/$/, "");
  const ghApi = githubApi(api);

  const rest = (token: string, path: string, init: RequestInit = {}): Promise<Response> =>
    tokenRest(token, ghApi, path, init);

  /** read the error body and throw — mapping the missing-permission 403 to an
   *  AppError and a rate limit to TrackerRateLimited (the caller waits) */
  async function raise(res: Response, repoFullName: string, what: string): Promise<never> {
    const text = await res.text();
    if (res.status === 403 && text.includes("Resource not accessible")) throw issuesPermissionError(repoFullName);
    const wait = rateLimitWait(res, text);
    if (wait !== undefined) throw new TrackerRateLimited(wait, `${what} → rate limited (${res.status})`);
    throw new Error(`${what} → ${res.status} ${text}`);
  }

  /** labels this process already made sure of — a re-anchoring batch would
   *  otherwise spend one extra write per item on the same 422 */
  const ensured = new Set<string>();

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

  function toTodo(issue: GitHubIssueRow): Todo {
    const body = issue.body ?? "";
    return {
      id: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      body: parseBody(body),
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
      return toTodo((await res.json()) as GitHubIssueRow);
    },

    async listTodos(repoFullName, processId) {
      const token = await deps.tokenFor(repoFullName);
      const path = `/repos/${repoFullName}/issues?state=open&labels=${encodeURIComponent(todoLabelQuery(processId))}&per_page=100`;
      let issues: GitHubIssueRow[];
      try {
        issues = (await paginate(ghApi, path, { token })) as GitHubIssueRow[];
      } catch (e) {
        // paginate throws GitHubHttpError with the response status/body attached
        if (e instanceof GitHubHttpError && e.status === 403 && e.body.includes("Resource not accessible")) {
          throw issuesPermissionError(repoFullName);
        }
        throw e;
      }
      return issues.filter((issue) => !isPullRequestRow(issue)).map(toTodo);
    },

    async retargetTodo(repoFullName, id, from, to) {
      const token = await deps.tokenFor(repoFullName);
      const res = await rest(token, `/repos/${repoFullName}/issues/${id}`);
      if (!res.ok) await raise(res, repoFullName, `todo #${id} read`);
      const issue = (await res.json()) as GitHubIssueRow & { labels?: Array<string | { name?: string }> };
      const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
      const nextLabels = [...new Set([...labels.filter((l) => l !== processLabel(from)), processLabel(to.process)])];
      const body = issue.body ?? "";
      const nextBody = retargetBody(
        body,
        from,
        to,
        deps.publicUrl ? { publicUrl: deps.publicUrl, repoFullName } : undefined,
      );
      const labelsChanged = nextLabels.length !== labels.length || nextLabels.some((l) => !labels.includes(l));
      if (!labelsChanged && nextBody === body) return "unchanged";
      const key = `${repoFullName}\n${processLabel(to.process)}`;
      if (!ensured.has(key)) {
        await ensureLabel(token, repoFullName, {
          name: processLabel(to.process),
          color: "ededed",
          description: `bpmiq process ${to.process}`,
        });
        ensured.add(key);
      }
      // ONE write: GitHub replaces the label set as a whole — computed from
      // the labels read a moment ago, so a label added by hand in between is
      // the only thing that could get lost
      const patch = await rest(token, `/repos/${repoFullName}/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ labels: nextLabels, ...(nextBody !== body ? { body: nextBody } : {}) }),
      });
      if (!patch.ok) await raise(patch, repoFullName, `todo #${id} re-anchor`);
      await patch.text();
      return "moved";
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
