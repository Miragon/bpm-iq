/**
 * The GitHub-side todo vocabulary: labels and the issues-list row shape. This
 * is TRACKER vocabulary, not platform wire types — ports/issue-tracker.ts
 * deliberately assumes no numbers, labels or markdown (Jira has neither), so
 * this lives with the GitHub plumbing, not in @bpmiq/contracts. The body
 * MARKUP (anchor block, attribution line) stays adapter-owned per that port.
 *
 * Zero imports — the read-only MCP server can adopt this without pulling the
 * App/JWT half of the package into its published bundle.
 */

/** the label every platform-managed todo carries */
export const TODO_LABEL = "todo";

/** the per-process label that makes the tracker-side filter cheap */
export const processLabel = (processId: string): string => `process:${processId}`;

/** the `labels=` filter for listing: every todo, or one process's */
export const todoLabelQuery = (processId?: string): string =>
  processId ? `${TODO_LABEL},${processLabel(processId)}` : TODO_LABEL;

/** one row of GitHub's issues list.
 *  NB the list INCLUDES pull requests — every consumer must filter them out
 *  (they carry a `pull_request` key; see isPullRequestRow). */
export interface GitHubIssueRow {
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

export const isPullRequestRow = (row: Pick<GitHubIssueRow, "pull_request">): boolean => row.pull_request !== undefined;
