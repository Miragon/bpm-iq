/**
 * Minimal-diff text writing — sync rule 2 from docs/platform-concept.md:
 * clients write minimal diffs into the shared Y.Text, never replace-all.
 * A full replace turns every concurrent remote edit into a conflict and
 * destroys remote cursor/selection positions; a minimal diff merges cleanly.
 */
import type * as Y from "yjs";

/** trim common prefix/suffix between two strings → the changed middle */
export function diffRegion(prev: string, next: string): { start: number; endPrev: number; endNext: number } {
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/**
 * Write `next` into `ytext` as a minimal diff (one transaction deleting and
 * inserting only the changed middle). No-op when the content already matches.
 */
export function updateText(ytext: Y.Text, next: string, origin?: unknown): void {
  const doc = ytext.doc;
  if (!doc) throw new Error("updateText requires a Y.Text attached to a Y.Doc");
  const prev = ytext.toString();
  if (prev === next) return;
  const { start, endPrev, endNext } = diffRegion(prev, next);
  doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  }, origin);
}
