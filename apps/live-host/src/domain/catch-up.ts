/**
 * The workspace catch-up decision (#185) — pure, unit-testable. The git side
 * lives in repos/workspaces.ts (reconcile); this module only decides, per
 * file the default branch changed since the workspace HEAD, what happens to it.
 *
 * The workspace never commits: live edits sit in the working tree, and a
 * release marks what it shipped in the INDEX (the released blob) and on the
 * file's release list (every blob a still-open release shipped). So per file
 * there are four versions — HEAD (what the workspace last caught up to),
 * upstream (origin/<default>), the index (the BASE local edits build on: HEAD,
 * or the released blob) and the working tree — plus that list, and git's own
 * fast-forward already keeps every file it may keep. This module only answers
 * the cases git would refuse, by setting the index entry git needs to see:
 *
 *   converged  the working tree already IS upstream (the merged release) —
 *              index := upstream, nothing is written
 *   keep       upstream reached a state the local version builds on: the index
 *              holds it (released, merged, edited on) or one of the file's
 *              open releases (an earlier release merged while a later one is
 *              still open) — index := upstream, the fast-forward keeps the
 *              working tree as it is
 *   take       no local edit and no release mark (working tree == index ==
 *              HEAD) — the fast-forward writes upstream's content
 *   conflict   local edits on an older base AND upstream changed the file
 *              (outside the platform, or the release PR was altered before
 *              the merge) — the local version stays, index := upstream so git
 *              lets the fast-forward pass, and the file is flagged: releasing
 *              it now would silently revert upstream's change
 */

/** one file the default branch changed between the workspace HEAD and origin —
 *  object ids per side, null = the file does not exist there */
export interface UpstreamChange {
  /** repo-root-relative path */
  path: string;
  head: string | null;
  upstream: string | null;
  upstreamMode: string | null;
  /** stage-0 index entry */
  index: string | null;
  /** the working-tree content hashed like `git add` would (any non-null
   *  string that is no blob id stands for "something git cannot hash") */
  tree: string | null;
  /** what this workspace's still-open releases shipped, oldest first
   *  (null = a shipped deletion) */
  released: Array<string | null>;
}

export type CatchUpAction = "converged" | "take" | "keep" | "conflict";

/** one index entry: file mode + object id */
export interface IndexEntry {
  mode: string;
  blob: string;
}

export function catchUpAction(c: UpstreamChange): CatchUpAction {
  if (c.tree === c.upstream) return "converged";
  // before take: a file whose latest release shipped HEAD's state (a new file
  // released, then its deletion released) must not come back when the
  // earlier release merges
  if (c.index === c.upstream || c.released.includes(c.upstream)) return "keep";
  if (c.tree === c.index && c.index === c.head) return "take";
  return "conflict";
}

/** the index entry to write before the fast-forward: an entry, null =
 *  remove it, undefined = leave the index as it is */
export function indexTarget(c: UpstreamChange, action: CatchUpAction): IndexEntry | null | undefined {
  if (action === "take" || c.index === c.upstream) return undefined;
  return c.upstream && c.upstreamMode ? { mode: c.upstreamMode, blob: c.upstream } : null;
}

/** a local file at a path upstream deletes, which the index no longer tracks
 *  once prepared: git refuses to fast-forward "over" it, so the catch-up parks
 *  it inside .git meanwhile. Keyed on that state, not on the action — a retry
 *  after a failed fast-forward finds the entry already gone and reads "keep". */
export function parks(c: UpstreamChange, action: CatchUpAction): boolean {
  return action !== "take" && c.upstream === null && c.tree !== null;
}

/** what stays of the file's release list after the catch-up: the releases
 *  shipped after the one upstream reached (older ones can no longer be the
 *  base) — anything else upstream did to the file ends the list */
export function releasedAfter(c: UpstreamChange): Array<string | null> {
  const reached = c.released.lastIndexOf(c.upstream);
  return reached < 0 ? [] : c.released.slice(reached + 1);
}

/** raw `git diff-tree -r -z --no-abbrev` records → path + both sides
 *  (`:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`) */
export function parseRawDiff(raw: string): Array<Pick<UpstreamChange, "path" | "head" | "upstream" | "upstreamMode">> {
  // an all-zero id/mode is diff-tree's "the file does not exist on this side"
  const absent = (id: string | undefined) => (!id || /^0+$/.test(id) ? null : id);
  const tokens = raw.split("\0");
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i] ?? "";
    const path = tokens[i + 1] ?? "";
    if (!meta.startsWith(":") || !path) continue;
    const [, upstreamMode, head, upstream] = meta.slice(1).split(" ");
    out.push({ path, head: absent(head), upstream: absent(upstream), upstreamMode: absent(upstreamMode) });
  }
  return out;
}

/** `git ls-files -s -z` → path → stage-0 object id (`<mode> <id> <stage>\t<path>\0`) */
export function parseIndex(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of raw.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, id, stage] = record.slice(0, tab).split(" ");
    if (stage === "0" && id) out.set(record.slice(tab + 1), id);
  }
  return out;
}
