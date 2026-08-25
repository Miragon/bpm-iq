/**
 * The reference half of a release PR: which models point at what this release
 * ships — the notation-agnostic sibling of decision-impact.ts (which stays
 * the rich, semantic DMN commentary). Derived from the repo-wide reference
 * index (@bpmiq/notations/content) over the WORKSPACE state, so a reviewer
 * sees the blast radius of a change — including references that a shipped
 * DELETE leaves dangling.
 *
 * Degrades quietly: no config, no refs, unreadable files → empty string. A
 * release must never fail because its commentary could not be produced.
 */
import { byExtension, modelStem } from "@bpmiq/notations";

import { buildRepoIndex, loadContentConfig } from "../repos/content.ts";

export async function referenceImpact(workspace: string, files: string[]): Promise<string> {
  try {
    const cfg = loadContentConfig(workspace);
    if (!cfg) return "";
    const index = await buildRepoIndex(workspace, cfg);
    const lines: string[] = [];
    for (const path of [...files].sort()) {
      const notation = byExtension(path)?.id;
      if (!notation) continue;
      const stem = modelStem(path);
      // resolved refs INTO this file, plus — for a path under the models root
      // that is NO artifact anymore, i.e. a shipped DELETE — unresolved refs
      // that NAME it (its referrers are left dangling). The artifact/root
      // gates keep an added file with a coincidental stem from being flagged.
      const isDeletedModel =
        (cfg.models === "." || path.startsWith(`${cfg.models}/`)) && !index.artifacts.some((a) => a.path === path);
      const incoming = index.refs.filter((r) =>
        r.resolved
          ? r.resolved.path === path
          : isDeletedModel && r.to.id === stem && (!r.to.notation || r.to.notation === notation),
      );
      if (incoming.length === 0) continue;
      const dangling = incoming.every((r) => !r.resolved);
      const by = incoming
        .map((r) => `\`${r.from.path}\`${r.from.element ? ` (${r.from.element} ${r.rel})` : ` (${r.rel})`}`)
        .join(", ");
      lines.push(`- \`${path}\` is referenced by ${by}${dangling ? " — **left dangling by this release**" : ""}`);
    }
    if (lines.length === 0) return "";
    return `\n\n### Referenced by\n\nModels that point at what this release ships — review them for impact:\n\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
