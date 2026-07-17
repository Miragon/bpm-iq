/**
 * git-log parsing for the file-history read-model — pure, unit-testable.
 *
 * FILE_LOG_FORMAT delimits with ASCII unit/record separators (0x1f/0x1e):
 * commit subjects and bodies are free text, so the delimiters must be
 * characters no sane message contains. A message that DOES contain them can
 * only garble its own record — records whose first field is not a commit sha
 * are dropped instead of corrupting the whole listing.
 */
import type { FileCommitWire } from "@bpmiq/contracts/live-host";

/** `git log --format=` producing one 0x1e-terminated record per commit */
export const FILE_LOG_FORMAT = "%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e";

/** full or abbreviated sha-1/sha-256 object name */
export const isCommitSha = (s: string): boolean => /^[0-9a-f]{7,64}$/.test(s);

export function parseFileLog(raw: string): FileCommitWire[] {
  const out: FileCommitWire[] = [];
  for (const record of raw.split("\x1e")) {
    const fields = record.split("\x1f");
    if (fields.length < 5) continue; // trailing newline / malformed record
    const sha = (fields[0] ?? "").trim();
    if (!isCommitSha(sha)) continue;
    out.push({
      sha,
      author: fields[1] ?? "",
      authoredAt: fields[2] ?? "",
      subject: fields[3] ?? "",
      // a 0x1f inside the body splits it — rejoin, drop git's trailing newlines
      body: fields.slice(4).join("\x1f").replace(/\n+$/, ""),
    });
  }
  return out;
}
