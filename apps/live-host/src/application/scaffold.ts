/**
 * Create-side use-cases of the repository view, extracted like overview.ts:
 *
 *   listFolders   — every folder under the repo's bpmiq.yml processes root
 *                   (recursive, includes EMPTY ones — a just-created folder
 *                   must survive a reload before its first process exists)
 *   createFolder  — mkdir under the processes root
 *   createProcess — write a fresh, validator-clean BPMN file (domain/bpmn-template)
 *
 * Both creates write into the repo's WORKSPACE tree only — exactly like the
 * live write-through (collab.ts). Nothing is committed here: the file shows up
 * as dirty in the overview and travels upstream via release-as-PR.
 *
 * Error convention (mirrors release.ts): user-actionable gates throw typed
 * AppErrors — the http catch-all maps them to 400/409/422 with the message
 * exposed to the authenticated caller.
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ProcessInfo } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";
import { byExtension, processIdFromName } from "@bpmiq/notations";

import { newBpmnXml } from "../domain/bpmn-template.ts";
import { CONTENT_CONFIG_FILE, type ContentConfig, discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

/** one path segment of a folder: no leading dot (discovery hides dotfiles),
 * no separators/traversal (the leading alnum rules out "." and "..") */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireConfig(repo: ConnectedRepo, workspace: string): ContentConfig {
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "scaffold/not-a-content-repo",
      `${repo.fullName} is not a BPM content repo — add a root ${CONTENT_CONFIG_FILE} naming its processes folder first`,
      { status: 422, expose: true },
    );
  }
  return cfg;
}

/** parse + validate a processes-root-relative folder path into its segments */
function folderSegments(input: string): string[] {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return [];
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "node_modules" || segment.length > 64) {
      throw new AppError(
        "scaffold/invalid-folder",
        `invalid folder name '${segment}' — use letters, digits, '-', '_' or '.' (not leading), max 64 chars`,
        { status: 400, expose: true },
      );
    }
  }
  return segments;
}

/** absolute path of the processes root; every created path must stay inside */
function processesRoot(workspace: string, cfg: ContentConfig): string {
  return resolve(workspace, cfg.processes);
}

/** defense-in-depth: a resolved target must stay under the processes root
 * (folderSegments already rules traversal out lexically) */
function assertInsideRoot(target: string, root: string, what: string): void {
  if (target !== root && !target.startsWith(root + sep)) {
    throw new AppError("scaffold/outside-processes-root", `${what} escapes the processes folder`, {
      status: 400,
      expose: true,
    });
  }
}

/**
 * The lexical check above is blind to SYMLINKS — a checkout may contain a
 * symlinked folder pointing outside the workspace (repos can commit symlinks),
 * and a create would then write through it. Canonicalize the nearest EXISTING
 * ancestor (that is where the write physically lands) and require it to stay
 * inside the canonical workspace — the same guard collab.ts applies to rooms.
 */
function assertRealInsideWorkspace(target: string, workspace: string, what: string): void {
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realWorkspace = realpathSync(workspace);
  if (real !== realWorkspace && !real.startsWith(realWorkspace + sep)) {
    throw new AppError("scaffold/outside-processes-root", `${what} escapes the workspace (symlink)`, {
      status: 400,
      expose: true,
    });
  }
}

/** run a filesystem write, mapping the benign races/conflicts to a 409:
 * EEXIST = a concurrent create won; ENOTDIR = a path segment is a FILE */
async function writeGuarded<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new AppError("scaffold/conflict", `${what} conflicts with an existing file`, {
        status: 409,
        expose: true,
        cause: e,
      });
    }
    throw e;
  }
}

/**
 * Every folder under the processes root, processes-root-relative, sorted.
 * Same skip rules as process discovery (dot segments, node_modules) so the
 * listing never shows a folder whose content would be invisible. Missing or
 * unconfigured root → [] — the folder list must never 500 an overview.
 */
export async function listFolders(workspace: string): Promise<string[]> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return [];
  const root = processesRoot(workspace, cfg);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
}

/** create a folder under the processes root; returns the normalized path */
export async function createFolder(repo: ConnectedRepo, workspace: string, path: string): Promise<string> {
  const cfg = requireConfig(repo, workspace);
  const segments = folderSegments(path);
  if (segments.length === 0) {
    throw new AppError("scaffold/invalid-folder", "folder path must not be empty", { status: 400, expose: true });
  }
  const root = processesRoot(workspace, cfg);
  const target = resolve(root, ...segments);
  assertInsideRoot(target, root, `folder '${path}'`);
  assertRealInsideWorkspace(target, workspace, `folder '${path}'`);
  if (existsSync(target)) {
    throw new AppError("scaffold/folder-exists", `'${segments.join("/")}' already exists`, {
      status: 409,
      expose: true,
    });
  }
  await writeGuarded(`folder '${segments.join("/")}'`, () => mkdir(target, { recursive: true }));
  return segments.join("/");
}

/**
 * Create a new process: <processes root>/<folder>/<slug(name)>.bpmn seeded
 * with the blank-diagram template. The id (= file stem) must be unique
 * REPO-WIDE — a duplicate stem in another folder would silently shadow one of
 * the two files in discovery (repos/content.ts), so it is refused up front.
 * Returns the created process as the overview wire row (dirty by definition:
 * the file does not exist on origin yet).
 */
export async function createProcess(
  repo: ConnectedRepo,
  workspace: string,
  body: { name: string; folder?: string },
): Promise<ProcessInfo> {
  const cfg = requireConfig(repo, workspace);
  const segments = folderSegments(body.folder ?? "");
  const id = processIdFromName(body.name);
  if (id === "") {
    throw new AppError(
      "scaffold/invalid-name",
      `'${body.name}' does not yield a usable file name — use at least one letter or digit`,
      { status: 400, expose: true },
    );
  }
  const duplicate = (await discoverProcesses(workspace, cfg)).find((p) => p.id === id);
  if (duplicate) {
    throw new AppError(
      "scaffold/process-exists",
      `process '${id}' already exists (${duplicate.path}) — ids are unique across all folders`,
      { status: 409, expose: true },
    );
  }
  const root = processesRoot(workspace, cfg);
  const file = resolve(root, ...segments, `${id}.bpmn`);
  assertInsideRoot(file, root, `process '${id}'`);
  assertRealInsideWorkspace(file, workspace, `process '${id}'`);
  if (existsSync(file)) {
    // not discovered (e.g. under a dot-folder clash) but present on disk
    throw new AppError("scaffold/process-exists", `'${relative(workspace, file)}' already exists`, {
      status: 409,
      expose: true,
    });
  }
  await writeGuarded(`process '${id}'`, async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, newBpmnXml(id, body.name.trim()), { flag: "wx" });
  });

  const repoPath = relative(workspace, file).split(sep).join("/");
  return {
    repo: repo.fullName,
    id,
    name: id,
    bpmn: repoPath,
    models: [{ notation: byExtension(repoPath)?.id ?? "text", path: repoPath }],
    folder: segments.join("/"),
    dirty: true, // brand-new — by definition not on origin yet
    liveSessions: 0,
  };
}
