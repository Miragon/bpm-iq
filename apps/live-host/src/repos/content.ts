/**
 * The content-repo contract (bpmiq.yml): a connected repo is a BPM content
 * repo iff a `bpmiq.yml` at its root names the folder its BPMN processes live
 * in. Nothing else about the repo layout is assumed — a process IS a .bpmn
 * file under that folder, its id is the file name without extension.
 *
 *   # bpmiq.yml
 *   processes: processes
 *
 * Everything that used to probe for the starter layout (processes/<id>/
 * process.yaml, the process-documentation/ monorepo nesting) goes through
 * this module now; a repo without a bpmiq.yml is simply not a content repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";

import { parse as parseYaml } from "yaml";

export const CONTENT_CONFIG_FILE = "bpmiq.yml";

export interface ContentConfig {
  /** repo-root-relative folder holding the BPMN process models */
  processes: string;
}

/**
 * Read + validate <root>/bpmiq.yml. `undefined` means "not a BPM content
 * repo" — an unreadable/unparseable/ill-typed config must degrade to that,
 * never crash a listing (the file is plausibly mid-edit in a live session).
 */
export function loadContentConfig(root: string): ContentConfig | undefined {
  const file = join(root, CONTENT_CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const processes = (parsed as { processes?: unknown } | null)?.processes;
  if (typeof processes !== "string" || processes.trim().length === 0) return undefined;
  // normalize so discovery and the room-containment gate agree on one spelling
  // ("a//b", "p/.", "./p" collapse); "." / "" mean "processes live at the root"
  const normalized = posix.normalize(processes.trim()).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return { processes: "." };
  // the folder must stay inside the repo — no absolute paths, no traversal
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  return { processes: normalized };
}

export interface DiscoveredProcess {
  /** file name without .bpmn — unique per repo (release/todo routes key on it) */
  id: string;
  /** repo-root-relative path of the .bpmn file */
  path: string;
}

/**
 * Every .bpmn under the configured folder (recursive, sorted by path).
 * The id is the FILE NAME without extension so it stays a single URL segment;
 * a second file with the same name elsewhere in the tree is skipped + logged
 * rather than shadowing the first.
 */
export async function discoverProcesses(root: string, cfg: ContentConfig): Promise<DiscoveredProcess[]> {
  const dir = join(root, cfg.processes);
  // missing folder or a config that names a FILE (ENOTDIR) is "no processes",
  // never a crash — the config is plausibly mid-edit in a live session
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const paths = entries
    .filter((e) => e.isFile() && e.name.endsWith(".bpmn"))
    .map((e) => join(cfg.processes, relative(dir, join(e.parentPath, e.name))))
    .filter((p) => !p.split("/").some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
  const out: DiscoveredProcess[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const id = (path.split("/").pop() ?? path).replace(/\.bpmn$/, "");
    const first = seen.get(id);
    if (first) {
      console.log(`content: duplicate process id '${id}' (${path}) — keeping ${first}`);
      continue;
    }
    seen.set(id, path);
    out.push({ id, path });
  }
  return out;
}
