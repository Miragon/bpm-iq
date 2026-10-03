/**
 * Write use-cases of the repository view, extracted like overview.ts:
 *
 *   listFolders    — every folder under the repo's designiq.yml processes root
 *                    (recursive, includes EMPTY ones — a just-created folder
 *                    must survive a reload before its first process exists)
 *   createFolder   — mkdir under the processes root
 *   createProcess  — write a fresh, validator-clean BPMN file (domain/bpmn-template)
 *   createDecision — write a fresh DMN file (domain/dmn-template)
 *   moveModels     — move model files into another folder (#182)
 *   renameModel    — give a model a new id (= file stem), open or not (#208)
 *   duplicateModel — copy a model's live content under a new id (#209)
 *   deleteModels   — delete model files, all or nothing (#210)
 *
 * All of them write into the repo's WORKSPACE tree only — exactly like the
 * live write-through (collab.ts). Nothing is committed here: the file shows up
 * as dirty in the overview and travels upstream via release-as-PR.
 *
 * Error convention (mirrors release.ts): user-actionable gates throw typed
 * AppErrors — the http catch-all maps them to 400/409/422 with the message
 * exposed to the authenticated caller.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";

import { CONTENT_KEY, movedNotice, roomName } from "@designiq/contracts/live";
import type {
  DecisionInfo,
  DeleteModelsBody,
  DeleteModelsResult,
  DuplicateModelBody,
  DuplicateModelResult,
  FolderListWire,
  ModelInfo,
  MoveModelsBody,
  MoveModelsResult,
  ProcessInfo,
  RenameModelBody,
  RenameModelResult,
  TodoJobWire,
} from "@designiq/contracts/live-host";
import { testsPathFor } from "@designiq/decisions/tests";
import { AppError } from "@designiq/http-kit";
import { readSnapshot } from "@designiq/live-client/structured";
import { byExtension, byId, modelStem, processIdFromName } from "@designiq/notations";
import { retargetRefs } from "@designiq/notations/retarget";
import { newBpmnXml, newDmnXml, templateFor } from "@designiq/notations/templates";
import * as Y from "yjs";

import { docCodecForPath } from "../domain/rooms.ts";
import {
  buildRepoIndex,
  CONTENT_CONFIG_FILE,
  type ContentConfig,
  discoverDecisions,
  type DiscoveredModel,
  discoverModels,
  discoverProcesses,
  loadContentConfig,
  notAContentRepoReason,
} from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";
import { assertRealInsideWorkspace } from "./workspace-paths.ts";

/** one path segment of a folder: no leading dot (discovery hides dotfiles),
 * no separators/traversal (the leading alnum rules out "." and "..") */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireConfig(repo: ConnectedRepo, workspace: string): ContentConfig {
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "scaffold/not-a-content-repo",
      `${notAContentRepoReason(repo.fullName)}; a root ${CONTENT_CONFIG_FILE} naming its models folder makes it one`,
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
 * The repo's folder tree plus whether it is a content repo at all. `folders`:
 * every folder under the processes root, processes-root-relative, sorted — same
 * skip rules as process discovery (dot segments, node_modules) so the listing
 * never shows a folder whose content would be invisible. `isContentRepo` is
 * false exactly when there is no usable root contract file (the repo view
 * hides its create/release actions then). Missing/unreadable processes folder still
 * counts as a content repo with an empty tree — the folder list must never 500
 * an overview, and a create would just mkdir it.
 */
export async function listFolders(workspace: string): Promise<FolderListWire> {
  const cfg = loadContentConfig(workspace);
  if (!cfg) return { isContentRepo: false, folders: [] };
  const root = processesRoot(workspace, cfg);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return { isContentRepo: true, folders: [] };
  }
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
  return { isContentRepo: true, folders };
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
  assertRealInsideWorkspace(target, workspace, `folder '${path}'`, "scaffold/outside-processes-root");
  if (existsSync(target)) {
    throw new AppError("scaffold/folder-exists", `'${segments.join("/")}' already exists`, {
      status: 409,
      expose: true,
    });
  }
  await writeGuarded(`folder '${segments.join("/")}'`, () => mkdir(target, { recursive: true }));
  return segments.join("/");
}

/** what a create needs to know about its model kind — the two creates were
 *  ~50-line token-swap twins (extension, template, wire code, noun) */
interface CreateKindSpec {
  extension: string;
  noun: string;
  discover: (root: string, cfg: ContentConfig) => Promise<Array<{ id: string; path: string }>>;
  template: (id: string, name: string) => string;
  /** wire-pinned 409 code (scaffold/process-exists | scaffold/decision-exists) */
  existsCode: string;
}

/** the shared create core: slug, per-kind repo-wide stem uniqueness (process
 *  and decision ids stay SEPARATE namespaces — deliberate, test-pinned),
 *  traversal/symlink guards, EEXIST → 409, template write. Returns the
 *  repo-relative path; the wire row stays per wrapper. */
async function createModel(
  repo: ConnectedRepo,
  workspace: string,
  body: { name: string; folder?: string },
  spec: CreateKindSpec,
): Promise<{ id: string; repoPath: string; folder: string }> {
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
  const duplicate = (await spec.discover(workspace, cfg)).find((m) => m.id === id);
  if (duplicate) {
    throw new AppError(
      spec.existsCode,
      `${spec.noun} '${id}' already exists (${duplicate.path}) — ids are unique across all folders`,
      { status: 409, expose: true },
    );
  }
  const root = processesRoot(workspace, cfg);
  const file = resolve(root, ...segments, `${id}${spec.extension}`);
  assertInsideRoot(file, root, `${spec.noun} '${id}'`);
  assertRealInsideWorkspace(file, workspace, `${spec.noun} '${id}'`, "scaffold/outside-processes-root");
  if (existsSync(file)) {
    // not discovered (e.g. under a dot-folder clash) but present on disk
    throw new AppError(spec.existsCode, `'${relative(workspace, file)}' already exists`, {
      status: 409,
      expose: true,
    });
  }
  await writeGuarded(`${spec.noun} '${id}'`, async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, spec.template(id, body.name.trim()), { flag: "wx" });
  });
  return { id, repoPath: relative(workspace, file).split(sep).join("/"), folder: segments.join("/") };
}

/**
 * Create a new process: <processes root>/<folder>/<slug(name)>.bpmn seeded
 * with the blank-diagram template. The id (= file stem) must be unique
 * REPO-WIDE among .bpmn files — a duplicate stem in another folder would
 * silently shadow one of the two files in discovery (repos/content.ts), so it
 * is refused up front. Returns the created process as the overview wire row
 * (dirty by definition: the file does not exist on origin yet).
 */
export async function createProcess(
  repo: ConnectedRepo,
  workspace: string,
  body: { name: string; folder?: string },
): Promise<ProcessInfo> {
  const { id, repoPath, folder } = await createModel(repo, workspace, body, {
    extension: ".bpmn",
    noun: "process",
    discover: discoverProcesses,
    template: newBpmnXml,
    existsCode: "scaffold/process-exists",
  });
  return {
    repo: repo.fullName,
    id,
    name: id,
    bpmn: repoPath,
    models: [{ notation: byExtension(repoPath)?.id ?? "text", path: repoPath }],
    folder,
    dirty: true, // brand-new — by definition not on origin yet
    liveSessions: 0,
  };
}

/**
 * Create a model of ANY template-capable notation — the registry-generic
 * sibling of createProcess/createDecision (#139): descriptor + template are
 * one lookup each, the create core (uniqueness per notation, traversal/
 * symlink guards, EEXIST → 409) is shared. A notation without a template is
 * a 422 — its files arrive via git only. The typed twins above keep their
 * wire-pinned richer rows; the web client's typed flows keep calling them.
 */
export async function createNotationModel(
  repo: ConnectedRepo,
  workspace: string,
  body: { notation: string; name: string; folder?: string },
): Promise<ModelInfo> {
  const descriptor = byId(body.notation);
  if (!descriptor) {
    throw new AppError("scaffold/unknown-notation", `unknown notation '${body.notation}'`, {
      status: 422,
      expose: true,
    });
  }
  if (templateFor(descriptor.id, "probe", "probe") === undefined) {
    throw new AppError(
      "scaffold/no-template",
      `a ${descriptor.noun.singular} cannot be created from the platform — ${descriptor.label} files arrive via git`,
      { status: 422, expose: true },
    );
  }
  const { id, repoPath, folder } = await createModel(repo, workspace, body, {
    extension: descriptor.extensions[0] ?? "",
    noun: descriptor.noun.singular,
    discover: async (root, cfg) => (await discoverModels(root, cfg)).filter((m) => m.notation === descriptor.id),
    template: (modelId, name) => templateFor(descriptor.id, modelId, name) ?? "",
    existsCode: "scaffold/model-exists",
  });
  return {
    repo: repo.fullName,
    id,
    name: id,
    path: repoPath,
    notation: descriptor.id,
    folder,
    dirty: true, // brand-new — by definition not on origin yet
    liveSessions: 0,
  };
}

/**
 * Create a new decision: the dmn sibling of createProcess with the same gates
 * (repo-wide unique .dmn stem, traversal/symlink guards, EEXIST → 409).
 */
export async function createDecision(
  repo: ConnectedRepo,
  workspace: string,
  body: { name: string; folder?: string },
): Promise<DecisionInfo> {
  const { id, repoPath, folder } = await createModel(repo, workspace, body, {
    extension: ".dmn",
    noun: "decision",
    discover: discoverDecisions,
    template: newDmnXml,
    existsCode: "scaffold/decision-exists",
  });
  return {
    repo: repo.fullName,
    id,
    name: id,
    path: repoPath,
    folder,
    dirty: true, // brand-new — by definition not on origin yet
    liveSessions: 0,
  };
}

/** hard cap on one move — far above any real reorganisation */
const MAX_MOVE_FILES = 100;

export interface MoveDeps {
  /** repo-qualified names of rooms with a loaded live document */
  liveDocs: () => string[];
  /** re-key one room's Yjs lineage to the moved file's room */
  renameLineage: (from: string, to: string) => void;
  /** remember the moves so the release pairs their halves (#208) — absent
   *  in tests that do not care; the file-name pairing still applies */
  recordRenames?: (pairs: Array<{ from: string; to: string }>) => Promise<void>;
}

/** repo-root-relative, forward slashes — the room/wire path shape */
const repoPath = (workspace: string, abs: string): string => relative(workspace, abs).split(sep).join("/");

/**
 * Move model files into another folder under the processes root (#182). A
 * model keeps its file stem (= its id): calledElement / calledDecision links
 * resolve by stem, so they keep resolving, and the per-notation stem
 * uniqueness cannot be broken by a move. A decision's `<stem>.tests.yaml`
 * travels with it.
 *
 * Every file is checked BEFORE the first rename (a known model, not open in a
 * live session, destination free), so a refused move changes nothing. Rooms
 * are keyed by path — an OPEN file is refused rather than pulled from under
 * its editors; a closed one takes its Yjs lineage along, so unreleased live
 * edits survive. A model already in the target folder is skipped.
 */
export async function moveModels(
  repo: ConnectedRepo,
  workspace: string,
  body: MoveModelsBody,
  deps: MoveDeps,
): Promise<MoveModelsResult> {
  const cfg = requireConfig(repo, workspace);
  const requested = [...new Set(body.paths.map((p) => p.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new AppError("move/no-paths", "select at least one model to move", { status: 400, expose: true });
  }
  if (requested.length > MAX_MOVE_FILES) {
    throw new AppError("move/too-many", `a move takes at most ${MAX_MOVE_FILES} models`, {
      status: 400,
      expose: true,
    });
  }
  const segments = folderSegments(body.folder);
  const root = processesRoot(workspace, cfg);
  const targetDir = resolve(root, ...segments);
  assertInsideRoot(targetDir, root, `folder '${body.folder}'`);
  assertRealInsideWorkspace(targetDir, workspace, `folder '${body.folder}'`, "scaffold/outside-processes-root");

  // discovery is the allow-list: only registered model files under the
  // processes root — no traversal, no foreign files
  const models = new Map((await discoverModels(workspace, cfg)).map((m) => [m.path, m]));
  const live = new Set(deps.liveDocs());
  const plan: Array<{ from: string; to: string }> = [];
  for (const path of requested) {
    const model = models.get(path);
    if (!model) {
      throw new AppError("move/unknown-model", `not a model in ${repo.fullName}: ${path}`, {
        status: 404,
        expose: true,
      });
    }
    const files = [path];
    if (model.notation === "dmn" && existsSync(resolve(workspace, testsPathFor(path)))) files.push(testsPathFor(path));
    for (const from of files) {
      const to = repoPath(workspace, join(targetDir, basename(from)));
      if (to === from) continue; // already there
      if (live.has(roomName(repo.fullName, from))) {
        throw new AppError("move/live-session", `'${from}' is open in a live editing session — close it first`, {
          status: 409,
          expose: true,
        });
      }
      if (existsSync(resolve(workspace, to)) || plan.some((p) => p.to === to)) {
        throw new AppError("move/target-exists", `'${to}' already exists`, { status: 409, expose: true });
      }
      plan.push({ from, to });
    }
  }

  if (plan.length > 0) {
    await writeGuarded(`folder '${segments.join("/")}'`, () => mkdir(targetDir, { recursive: true }));
  }
  for (const { from, to } of plan) {
    await rename(resolve(workspace, from), resolve(workspace, to));
    deps.renameLineage(roomName(repo.fullName, from), roomName(repo.fullName, to));
  }
  await journal(deps.recordRenames, repo, plan);
  return { moved: plan };
}

/** record renames/moves for the release pairing — best effort: a lost entry
 *  only costs the pairing (the file-name rule still pairs a move), never the
 *  operation that already happened on disk */
async function journal(
  record: MoveDeps["recordRenames"],
  repo: ConnectedRepo,
  pairs: Array<{ from: string; to: string }>,
): Promise<void> {
  try {
    await record?.(pairs);
  } catch (e) {
    console.log(`rename journal of ${repo.fullName} not updated: ${(e as Error).message}`);
  }
}

/** a model file plus the files that travel with it — a decision's tests sidecar */
function companions(workspace: string, model: DiscoveredModel): string[] {
  const files = [model.path];
  if (model.notation === "dmn" && existsSync(resolve(workspace, testsPathFor(model.path)))) {
    files.push(testsPathFor(model.path));
  }
  return files;
}

/** the discovered model at `path` — discovery is the allow-list (no
 *  traversal, no foreign files), so an unknown path is a 404 */
function knownModel(
  repo: ConnectedRepo,
  models: DiscoveredModel[],
  path: string | undefined,
  code: string,
): DiscoveredModel {
  const model = typeof path === "string" ? models.find((m) => m.path === path.trim()) : undefined;
  if (!model) {
    throw new AppError(code, `not a model in ${repo.fullName}: ${path}`, { status: 404, expose: true });
  }
  return model;
}

/** the new id of a rename/duplicate: the create slug rule, unique per notation */
function newModelId(models: DiscoveredModel[], model: DiscoveredModel, name: string, existsCode: string): string {
  const id = processIdFromName(name);
  if (id === "") {
    throw new AppError(
      "scaffold/invalid-name",
      `'${name}' does not yield a usable file name — use at least one letter or digit`,
      { status: 400, expose: true },
    );
  }
  const clash = models.find((m) => m.notation === model.notation && m.id === id);
  if (clash) {
    const noun = byId(model.notation)?.noun.singular ?? "model";
    throw new AppError(
      existsCode,
      `${noun} '${id}' already exists (${clash.path}) — ids are unique across all folders`,
      {
        status: 409,
        expose: true,
      },
    );
  }
  return id;
}

/** the path a file of `model` gets under the new id — same folder, same
 *  extension (a notation may register several), the tests sidecar keyed along */
function pathUnderId(model: DiscoveredModel, file: string, id: string): string {
  const suffix = basename(file).slice(model.id.length); // ".bpmn", ".tests.yaml"
  return posix.join(posix.dirname(file), `${id}${suffix}`);
}

/** the target of a rename/duplicate must be free — on disk AND as a room */
function assertFree(repo: ConnectedRepo, workspace: string, path: string, live: Set<string>, code: string): void {
  const abs = resolve(workspace, path);
  assertRealInsideWorkspace(abs, workspace, `'${path}'`, "scaffold/outside-processes-root");
  if (existsSync(abs)) {
    throw new AppError(code, `'${path}' already exists`, { status: 409, expose: true });
  }
  // a document still loaded under that name (a file just renamed AWAY from
  // it, unloading) would be served to the next editor instead of this one
  if (live.has(roomName(repo.fullName, path))) {
    throw new AppError(code, `'${path}' is still closing in a live session — try again in a moment`, {
      status: 409,
      expose: true,
    });
  }
}

/** the document text a Yjs state holds — the structured lane encodes its
 *  snapshot, a text room is its CONTENT_KEY (collab.ts onStoreDocument) */
function contentOf(state: Uint8Array, path: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const codec = docCodecForPath(path);
  const content = codec ? codec.encode(readSnapshot(doc)) : doc.getText(CONTENT_KEY).toString();
  doc.destroy();
  return content;
}

export interface RenameDeps {
  /** repo-qualified names of rooms with a loaded live document */
  liveDocs: () => string[];
  rooms: {
    /** close a LOADED room for good: broadcast `notice` to its peers, disconnect
     *  them, stop it from persisting, and hand back its final Yjs state —
     *  undefined when the room is not loaded */
    retire: (room: string, notice: string) => Uint8Array | undefined;
    /** loads of `rooms` wait until the returned release() runs */
    hold: (rooms: string[]) => () => void;
  };
  lineage: {
    save: (room: string, state: Uint8Array) => void;
    drop: (room: string) => void;
    rename: (from: string, to: string) => void;
  };
  /** rewrite a model's LIVE document (open or not) — the co-editor path, so an
   *  open caller sees the change and nothing is overwritten on disk behind it */
  editContent: (path: string, edit: (content: string) => string) => Promise<void>;
  recordRenames?: MoveDeps["recordRenames"];
  /** a renamed PROCESS's open todos follow its new id — in the background
   *  (application/todo-jobs.ts); absent when the host has no tracker */
  todos?: { move(from: string, to: { process: string; file: string }): TodoJobWire };
}

/**
 * Give a model a new id (#208). The id IS the file stem, so the file is
 * renamed — same folder, same extension; a decision's `<stem>.tests.yaml`
 * follows. The new stem follows the create rules (slug, unique per notation).
 * Only the id changes: the title inside the model and its XML/element ids
 * are content (file-scoped; references resolve by stem, never by XML id).
 *
 * The file may be OPEN: rooms are keyed by path, so its room is retired — the
 * peers are told where the document went and disconnected, its final state
 * (unreleased edits included) becomes the new file and the new room's
 * lineage. Loads of the new room wait until that is in place. A closed file
 * takes its lineage along (like a move).
 *
 * References follow: every model pointing at the old id (calledElement,
 * decisionRef …) is rewritten in its live document. A caller that cannot be
 * rewritten is reported, not fatal — the rename already happened, and the
 * validator warns about the dangling link.
 */
export async function renameModel(
  repo: ConnectedRepo,
  workspace: string,
  body: RenameModelBody,
  by: string,
  deps: RenameDeps,
): Promise<RenameModelResult> {
  const cfg = requireConfig(repo, workspace);
  const models = await discoverModels(workspace, cfg);
  const model = knownModel(repo, models, body.path, "rename/unknown-model");
  if (processIdFromName(body.name) === model.id) {
    throw new AppError("rename/unchanged", `'${model.id}' already has this name`, { status: 400, expose: true });
  }
  const id = newModelId(models, model, body.name, "rename/model-exists");
  const live = new Set(deps.liveDocs());
  const plan = companions(workspace, model).map((from) => ({ from, to: pathUnderId(model, from, id) }));
  for (const { to } of plan) assertFree(repo, workspace, to, live, "rename/target-exists");

  // who points at the model — read BEFORE the files move (the index reads the tree)
  const index = await buildRepoIndex(workspace, cfg);
  const callers = [...new Set(index.incoming(model.path).map((r) => r.from.path))];

  const room = (path: string): string => roomName(repo.fullName, path);
  const release = deps.rooms.hold(plan.map((f) => room(f.to)));
  const renamed: Array<{ from: string; to: string }> = [];
  try {
    for (const { from, to } of plan) {
      // retire BEFORE the rename: from here on the old room never writes
      // through again, and its peers already head for the new path
      const state = deps.rooms.retire(room(from), movedNotice(repo.fullName, to, by));
      try {
        await rename(resolve(workspace, from), resolve(workspace, to));
      } catch (e) {
        // the retired room no longer persists — keep its unsaved edits under
        // the OLD name, where the file still is (the next open restores them)
        if (state) deps.lineage.save(room(from), state);
        throw e;
      }
      if (state) {
        // the live state may be ahead of the last write-through (debounce)
        await writeFile(resolve(workspace, to), contentOf(state, to));
        deps.lineage.save(room(to), state);
        deps.lineage.drop(room(from));
      } else {
        deps.lineage.rename(room(from), room(to));
      }
      renamed.push({ from, to });
    }
  } finally {
    release();
  }
  await journal(deps.recordRenames, repo, renamed);
  const newPath = renamed[0]?.to ?? pathUnderId(model, model.path, id);

  // todos are filed under the process id — they follow it (a job: the tracker
  // takes one write at a time, the rename does not wait for that)
  let todoJob: TodoJobWire | undefined;
  if (model.notation === "bpmn" && deps.todos) {
    try {
      todoJob = deps.todos.move(model.id, { process: id, file: newPath });
    } catch (e) {
      console.log(`rename ${model.path} → ${id}: todos not moved: ${(e as Error).message}`);
    }
  }

  const updatedReferences: string[] = [];
  const failedReferences: string[] = [];
  const spec = { notation: model.notation, from: model.id, to: id };
  for (const caller of callers) {
    // a model calling itself was renamed above — rewrite it at its new path
    const path = renamed.find((r) => r.from === caller)?.to ?? caller;
    const notation = byExtension(path)?.id ?? "";
    try {
      await deps.editContent(path, (content) => retargetRefs(notation, content, spec));
      updatedReferences.push(path);
    } catch (e) {
      console.log(`rename ${model.path} → ${id}: reference in ${path} not updated: ${(e as Error).message}`);
      failedReferences.push(path);
    }
  }
  return { id, path: newPath, renamed, updatedReferences, failedReferences, ...(todoJob ? { todoJob } : {}) };
}

export interface DuplicateDeps {
  /** the LIVE content of a document — unreleased edits included */
  readContent: (path: string) => Promise<string>;
}

/**
 * Copy a model into the same folder under a new id (#209) — the source's
 * current LIVE content (unreleased edits included), byte for byte: element
 * and model ids are file-scoped and references resolve by file stem, so the
 * copy is validator-clean as is. A decision's tests sidecar is copied too —
 * the copy decides exactly like the source, so its cases hold, and the first
 * diverging edit shows up as a failing case. Todos, history and presence
 * belong to the source and stay there.
 */
export async function duplicateModel(
  repo: ConnectedRepo,
  workspace: string,
  body: DuplicateModelBody,
  deps: DuplicateDeps,
): Promise<DuplicateModelResult> {
  const cfg = requireConfig(repo, workspace);
  const models = await discoverModels(workspace, cfg);
  const model = knownModel(repo, models, body.path, "duplicate/unknown-model");
  const id = newModelId(models, model, body.name, "duplicate/model-exists");
  const plan = companions(workspace, model).map((from) => ({ from, to: pathUnderId(model, from, id) }));
  for (const { to } of plan) assertFree(repo, workspace, to, new Set(), "duplicate/target-exists");

  // read everything first — a failed read must not leave half a copy behind
  const contents = await Promise.all(plan.map(({ from }) => deps.readContent(from)));
  const created: string[] = [];
  for (const [i, { to }] of plan.entries()) {
    await writeGuarded(`'${to}'`, () => writeFile(resolve(workspace, to), contents[i] ?? "", { flag: "wx" }));
    created.push(to);
  }
  const rootPrefix = cfg.processes === "." ? "" : `${cfg.processes}/`;
  const path = created[0] ?? pathUnderId(model, model.path, id);
  const rel = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
  return {
    model: {
      repo: repo.fullName,
      id,
      name: id,
      path,
      notation: model.notation,
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      dirty: true, // brand-new — by definition not on origin yet
      liveSessions: 0,
    },
    created,
  };
}

/** hard cap on one delete — the same bound as a move */
const MAX_DELETE_FILES = MAX_MOVE_FILES;

export interface DeleteDeps {
  /** repo-qualified names of rooms with a loaded live document */
  liveDocs: () => string[];
  /** forget a deleted file's Yjs lineage */
  dropLineage: (room: string) => void;
  /** close a deleted process's open todos in the background (`closeTodos`) —
   *  absent when the host has no tracker */
  todos?: { close(from: string): TodoJobWire };
}

/**
 * Delete model files (#210); a decision's tests sidecar goes along. Every
 * file is checked BEFORE the first delete (a known model, not open in a live
 * session), so a refused delete changes nothing and names the file that
 * blocked it. An open model is refused rather than pulled from under its
 * editors (move's rule). Nothing is committed: a released model's deletion
 * ships with the next release; a never-released one is simply gone.
 */
export async function deleteModels(
  repo: ConnectedRepo,
  workspace: string,
  body: DeleteModelsBody,
  deps: DeleteDeps,
): Promise<DeleteModelsResult> {
  const cfg = requireConfig(repo, workspace);
  const requested = [...new Set(body.paths.map((p) => p.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new AppError("delete/no-paths", "select at least one model to delete", { status: 400, expose: true });
  }
  if (requested.length > MAX_DELETE_FILES) {
    throw new AppError("delete/too-many", `a delete takes at most ${MAX_DELETE_FILES} models`, {
      status: 400,
      expose: true,
    });
  }
  const models = await discoverModels(workspace, cfg);
  const live = new Set(deps.liveDocs());
  const files: string[] = [];
  for (const path of requested) {
    for (const file of companions(workspace, knownModel(repo, models, path, "delete/unknown-model"))) {
      if (live.has(roomName(repo.fullName, file))) {
        throw new AppError("delete/live-session", `'${file}' is open in a live editing session — close it first`, {
          status: 409,
          expose: true,
        });
      }
      files.push(file);
    }
  }
  for (const file of files) {
    await rm(resolve(workspace, file), { force: true });
    deps.dropLineage(roomName(repo.fullName, file));
  }
  // asked for: the deleted processes' todos are closed (they would point at
  // nothing otherwise) — in the background, one tracker write at a time
  const todoJobs: TodoJobWire[] = [];
  if (body.closeTodos && deps.todos) {
    for (const path of requested) {
      if (byExtension(path)?.id !== "bpmn") continue;
      try {
        todoJobs.push(deps.todos.close(modelStem(path)));
      } catch (e) {
        console.log(`delete ${path}: todos not closed: ${(e as Error).message}`);
      }
    }
  }
  return { deleted: files, ...(todoJobs.length > 0 ? { todoJobs } : {}) };
}
