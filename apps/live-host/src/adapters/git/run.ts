/**
 * The git subprocess seam — the ONE place that is allowed to shell out
 * (enforced by .dependency-cruiser.mjs, child-process-only-in-designated-adapters).
 *
 * Credentials travel in `opts.env` (GIT_CONFIG_* → http.extraHeader), never in
 * argv — so a token never appears in a process listing or an error's command
 * line. `scrub()` is the matching defence in depth for error MESSAGES.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function runGit(
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, opts ?? {});
}

/** defence in depth: strip any Basic-auth header value that slipped into a message */
export function scrub(message: string): string {
  return message.replace(/AUTHORIZATION: Basic [A-Za-z0-9+/=]+/gi, "AUTHORIZATION: Basic «redacted»");
}
