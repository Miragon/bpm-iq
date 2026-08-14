/**
 * Symlink guard for filesystem writes into a workspace: lexical path checks
 * are blind to symlinks — a previously created folder could be replaced by a
 * link pointing outside, and a write would then land through it. Canonicalize
 * the nearest EXISTING ancestor (that is where the write physically lands)
 * and require it to stay inside the canonical workspace. Was a verbatim
 * private copy in scaffold.ts and decision-tests.ts; the wire-visible error
 * code stays per caller. (collab.ts keeps its own weaker inline form on the
 * ws path — plain Error, existing-target-only — deliberately untouched here.)
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";

import { AppError } from "@bpmiq/http-kit";

export function assertRealInsideWorkspace(
  target: string,
  workspace: string,
  what: string,
  code: "scaffold/outside-processes-root" | "decision-tests/outside-workspace",
): void {
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realWorkspace = realpathSync(workspace);
  if (real !== realWorkspace && !real.startsWith(realWorkspace + sep)) {
    throw new AppError(code, `${what} escapes the workspace (symlink)`, {
      status: 400,
      expose: true,
    });
  }
}
