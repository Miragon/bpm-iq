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

import { CONTENT_CONFIG_FILE } from "./content.ts";

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

/** the shared not-a-content-repo error line (byte-identical in two CLIs before) */
export const notContentRepoError = (root: string): string =>
  `[ERROR] ${root}: no ${CONTENT_CONFIG_FILE} at the root — not a BPM content repo (or wrong --root)`;
