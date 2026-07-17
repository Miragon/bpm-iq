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

/** git env carrying the token as an auth header — not in argv, not in config
 *  files. Also kills interactive credential prompts: an anonymous fetch of a
 *  private HTTPS repo must fail with a readable error, not hang on a username
 *  read ("could not read Username … No such device or address"). */
export function gitEnv(token: string | undefined): NodeJS.ProcessEnv {
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${basic}`,
  };
}

/** defence in depth: strip any Basic-auth header value that slipped into a message */
export function scrub(message: string): string {
  return message.replace(/AUTHORIZATION: Basic [A-Za-z0-9+/=]+/gi, "AUTHORIZATION: Basic «redacted»");
}
