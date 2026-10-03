/**
 * The content-repo CLI bootstrap — the `--root <dir>` contract every platform
 * CLI speaks (validator, decisions check, MCP stdio server). It existed as
 * three line-for-line copies; `pnpm validate` chains two of them in one gate,
 * so a drift in `--root` semantics would half-break the gate.
 *
 * Node-only (process.exit/console), like ./content — never exported through
 * the browser-safe index.
 */
import { resolve } from "node:path";

import { CONTENT_CONFIG_NAMES, resolveContentConfigFile } from "./content.ts";

/**
 * Parse `--root <dir>` out of argv (MUTATES argv, exactly like every caller
 * did — the remaining args are positional filters). Missing directory
 * argument → exit 2, the historical contract of all three CLIs.
 */
export function cliRoot(argv: string[], opts: { defaultRoot?: string } = {}): string {
  const rootFlag = argv.indexOf("--root");
  const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
  if (rootFlag >= 0 && !rootArg) {
    console.error("--root requires a directory argument");
    process.exit(2);
  }
  const root = rootArg ? resolve(rootArg) : resolve(opts.defaultRoot ?? ".");
  if (rootFlag >= 0) argv.splice(rootFlag, 2);
  return root;
}

/**
 * The shared not-a-content-repo error line (byte-identical in two CLIs before).
 * A contract file that exists but names no folder is reported BY ITS NAME,
 * whichever of the two it is: "no <file>" would send the reader looking for a
 * missing file while the one they just wrote is what is broken (a broken
 * designiq.yml is never skipped in favour of the legacy one). Only a root with
 * neither file gets the "no … at the root" line, naming both.
 */
export const notContentRepoError = (root: string): string => {
  const found = resolveContentConfigFile(root);
  return found === undefined
    ? `[ERROR] ${root}: no ${CONTENT_CONFIG_NAMES} at the root — not a content repo (or wrong --root)`
    : `[ERROR] ${root}: ${found} at the root names no models folder — not a content repo (or wrong --root)`;
};
