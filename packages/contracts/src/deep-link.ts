/**
 * Web-app deep links — the doorway INTO bpmiq's own editor routes (the mirror
 * of assist.ts, which leads OUT into an AI chat). The URL shapes live in ONE
 * place because three surfaces build them: the Live Host's `open_modeler` /
 * `open_decision_modeler` results, the GitHub issue bodies
 * (adapters/github/issues.ts) and the MCP modeler widgets' "Open in bpmiq"
 * button — hand-rolled copies would drift.
 *
 * The repo segment splits at the FIRST slash: GitHub is always owner/name;
 * GitLab subgroups (multi-segment repos) need the router to capture the repo
 * as a splat first — mirror of the comment in apps/web/src/router.tsx.
 */

/** the file stem that IS a model's id (the content contract — a process is its
 *  .bpmn file, a decision its .dmn file, @bpmiq/notations/content) */
export const modelStem = (path: string): string => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");

const repoBase = (publicUrl: string, repoFullName: string): string => {
  const slash = repoFullName.indexOf("/");
  const owner = slash === -1 ? repoFullName : repoFullName.slice(0, slash);
  const repo = slash === -1 ? "" : repoFullName.slice(slash + 1);
  return `${publicUrl.replace(/\/+$/, "")}/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};

/** the process editor: `/r/<owner>/<repo>/p/<processId>`, optionally revealing
 *  one element (`?element=` — validated by the route, unknown ids ignored) */
export function processDeepLink(
  publicUrl: string,
  repoFullName: string,
  processId: string,
  elementId?: string,
): string {
  const url = `${repoBase(publicUrl, repoFullName)}/p/${encodeURIComponent(processId)}`;
  return elementId ? `${url}?element=${encodeURIComponent(elementId)}` : url;
}

/** the file editor (any model file, e.g. a decision's .dmn):
 *  `/r/<owner>/<repo>/f/<repo-relative path>` — encoded per segment so the
 *  slashes keep separating the splat route's segments */
export function fileDeepLink(publicUrl: string, repoFullName: string, path: string): string {
  const splat = path.split("/").map(encodeURIComponent).join("/");
  return `${repoBase(publicUrl, repoFullName)}/f/${splat}`;
}
