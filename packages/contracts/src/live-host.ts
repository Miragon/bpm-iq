/**
 * Live-host ↔ web wire contract — the JSON the live-host HTTP API sends and
 * @designiq/web consumes. The BACKEND is the source of truth: http/api.ts,
 * application/overview.ts and release.ts assemble these shapes under
 * `satisfies` / return-type annotations; the web client re-exports them from
 * lib/api.ts. Changing a field here changes the LIVE wire format — don't.
 */
import type { GitUserWire } from "./common.ts";
import type { TodoAnchor, TodoElement } from "./todo-anchor.ts";

/** one model file of a process — each opens as its own live document */
export interface ModelRef {
  /** notation registry id (@designiq/notations); "text" fallback */
  notation: string;
  /** repo-relative path, e.g. "processes/<file>.bpmn" */
  path: string;
}

/**
 * GET /api/repos/:fullName/processes — one row per .bpmn file under the
 * repo's designiq.yml processes folder (a process IS its BPMN file; id = file
 * name without extension).
 */
export interface ProcessInfo {
  repo: string;
  id: string;
  name: string;
  /** the process's BPMN file (repo-relative path) */
  bpmn: string;
  /** the process's model files with their notation */
  models: ModelRef[];
  /** folder of the BPMN file relative to the processes root ("" = root) */
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/** POST /api/repos/:fullName/processes — response is the created ProcessInfo.
 * The process id (= file stem) is derived from `name`; it must be unique
 * repo-wide, so a duplicate is a 409 regardless of `folder`. */
export interface CreateProcessBody {
  /** human title — becomes the pool name; the file stem is its kebab-case slug */
  name: string;
  /** target folder relative to the processes root ("" / absent = root) */
  folder?: string;
}

/**
 * GET /api/repos/:fullName/decisions — one row per .dmn file under the
 * repo's designiq.yml processes folder (a decision IS its DMN file; id = file
 * name without extension, unique repo-wide like process ids).
 */
export interface DecisionInfo {
  repo: string;
  id: string;
  name: string;
  /** the decision's DMN file (repo-relative path) */
  path: string;
  /** folder of the DMN file relative to the processes root ("" = root) */
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/** POST /api/repos/:fullName/decisions — response is the created DecisionInfo.
 * The decision id (= file stem) is derived from `name`; it must be unique
 * among .dmn files repo-wide, so a duplicate is a 409 regardless of `folder`. */
export interface CreateDecisionBody {
  /** human title — becomes the decision name; the file stem is its kebab-case slug */
  name: string;
  /** target folder relative to the processes root ("" / absent = root) */
  folder?: string;
}

/** POST /api/repos/:fullName/models — create a model of ANY template-capable
 * notation; response is the created ModelInfo. 422 for an unknown notation or
 * one without a template (its files arrive via git only); the id (= file
 * stem, slug of `name`) must be unique per notation repo-wide → 409. The
 * typed /processes and /decisions creates stay (wire-pinned richer rows). */
export interface CreateModelBody {
  /** notation registry id (@designiq/notations), e.g. "wardley" */
  notation: string;
  /** human title — lands in the template; the file stem is its kebab-case slug */
  name: string;
  /** target folder relative to the models root ("" / absent = root) */
  folder?: string;
}

/**
 * GET /api/repos/:fullName/models — one row per model file of ANY registered
 * notation under the repo's designiq.yml models folder (id = file stem, unique
 * per notation). The registry-wide superset of the processes/decisions lists,
 * which stay the typed views.
 */
export interface ModelInfo {
  repo: string;
  id: string;
  name: string;
  /** the model file (repo-relative path) */
  path: string;
  /** notation registry id (@designiq/notations) */
  notation: string;
  /** folder of the file relative to the models root ("" = root) */
  folder: string;
  dirty: boolean;
  liveSessions: number;
}

/**
 * GET /api/repos/:fullName/folders — the repo's folder tree plus whether the
 * repo is a content repo at all. `isContentRepo` is false when the repo has
 * NO usable root contract file (designiq.yml, or the legacy name); the repo
 * view hides its create/release actions then (a create would 422, a release
 * has nothing to ship — "not a matching repo").
 */
export interface FolderListWire {
  /** the repo declares itself a content repo (a usable root designiq.yml is present) */
  isContentRepo: boolean;
  /** every folder under the processes root (recursive, sorted, includes empty
   * ones), processes-root-relative — [] when there is no config or no folder */
  folders: string[];
}

/** POST /api/repos/:fullName/folders — response is the created FolderWire */
export interface CreateFolderBody {
  /** processes-root-relative folder path to create (may be nested) */
  path: string;
}

export interface FolderWire {
  /** the created folder, processes-root-relative and normalized */
  path: string;
}

/**
 * POST /api/repos/:fullName/move — move model files into another folder under
 * the processes root. A model keeps its file stem (= its id), so calledElement
 * / calledDecision links keep resolving; a decision's `<stem>.tests.yaml`
 * moves with it. Nothing is committed: the move shows up in GET /changes as a
 * delete + add pair, and a release ships the pair together (a git rename).
 * 409 while a moved file is open in a live session.
 */
export interface MoveModelsBody {
  /** repo-relative paths of the model files to move (non-empty) */
  paths: string[];
  /** target folder, processes-root-relative ("" = the root); created if missing */
  folder: string;
}

export interface MoveModelsResult {
  /** every file that moved, companions (tests sidecars) included; a model
   *  already in the target folder is skipped, not listed */
  moved: Array<{ from: string; to: string }>;
}

/**
 * POST /api/repos/:fullName/rename — give a model a new id (#208). The id IS
 * the file stem, so this renames the file (same folder, same extension); a
 * decision's `<stem>.tests.yaml` is renamed along. The new stem follows the
 * create rules (slug of `name`, unique per notation repo-wide → 409). Models
 * that reference the old id (callActivity calledElement, businessRuleTask
 * decisionRef …) are rewritten to the new one in their live documents. An
 * OPEN model is migrated: its editors get a notice (MovedNotice in ./live.ts)
 * and continue on the new path, unreleased edits included. Nothing is
 * committed — the rename ships as a git rename with the next release.
 */
export interface RenameModelBody {
  /** repo-relative path of the model file */
  path: string;
  /** the new name — its kebab-case slug becomes the file stem */
  name: string;
}

export interface RenameModelResult {
  /** the model's new id (file stem) */
  id: string;
  /** a renamed PROCESS takes its open todos along — in the background, one
   *  tracker write at a time (GET …/todo-jobs follows it); absent when the
   *  model is no process or the host has no tracker */
  todoJob?: TodoJobWire;
  /** its new repo-relative path */
  path: string;
  /** every file that was renamed, the tests sidecar included */
  renamed: Array<{ from: string; to: string }>;
  /** models whose references now name the new id */
  updatedReferences: string[];
  /** referencing models that could not be rewritten — their links dangle
   *  (the validator warns); empty when every caller followed */
  failedReferences: string[];
}

/**
 * POST /api/repos/:fullName/duplicate — copy a model into the same folder
 * under a new id (#209). The copy is the source's CURRENT LIVE content
 * (unreleased edits included), byte for byte: element and model ids are
 * file-scoped, references resolve by file stem. A decision's tests sidecar is
 * copied along — same logic, same cases. Response: the new model's row.
 */
export interface DuplicateModelBody {
  /** repo-relative path of the model to copy */
  path: string;
  /** the copy's name — its kebab-case slug becomes the file stem */
  name: string;
}

export interface DuplicateModelResult {
  model: ModelInfo;
  /** every file written, the copied tests sidecar included */
  created: string[];
}

/**
 * POST /api/repos/:fullName/delete — delete model files (#210); a decision's
 * tests sidecar goes along. All or nothing: every file is checked first (a
 * known model, not open in a live session → 409), so a refused delete changes
 * nothing. The deletion ships with the next release; a model that was never
 * released is simply gone.
 */
export interface DeleteModelsBody {
  /** repo-relative paths of the model files (non-empty) */
  paths: string[];
  /** also close the open todos of every deleted PROCESS (in the background,
   *  one tracker write at a time) — default: they stay open */
  closeTodos?: boolean;
}

export interface DeleteModelsResult {
  /** every file that was deleted, companions (tests sidecars) included */
  deleted: string[];
  /** the todo-closing jobs `closeTodos` started (one per deleted process) */
  todoJobs?: TodoJobWire[];
}

/**
 * GET /api/repos/:fullName/todo-jobs — background work on a repo's todos
 * (#208, #210): a renamed process's todos MOVE to its new id, a deleted
 * process's todos CLOSE. The tracker takes one write at a time (GitHub asks
 * for serial writes, a second apart), so a job runs in the background and
 * reports progress. A job survives a host restart; a FAILED job keeps its
 * todos where they are until POST …/todo-jobs/retry runs it again.
 */
export interface TodoJobWire {
  /** stable per repo: "<kind>:<from>" */
  id: string;
  kind: "move" | "close";
  /** the process id the todos are filed under */
  from: string;
  /** move: the process id they go to */
  to?: string;
  /** open todos the job found; -1 until it looked */
  total: number;
  /** todos handled so far */
  done: number;
  /** todos the tracker refused this run */
  failed: number;
  state: "queued" | "running" | "done" | "failed";
}

/** POST /api/repos/:fullName/todo-jobs/retry — run a failed job again */
export interface RetryTodoJobBody {
  id: string;
}

/** one model referencing another (a callActivity, a businessRuleTask …) */
export interface ReferenceWire {
  /** repo-relative path of the referencing model */
  path: string;
  /** the element carrying the reference, when it hangs on one */
  element?: string;
  /** the relation: "calls", "decides", … (@designiq/notations/refs) */
  rel: string;
}

/**
 * GET /api/repos/:fullName/references?path=<model>[&path=<model>…] — which
 * models point at each requested model (the incoming half of the repo index,
 * workspace state). What a rename rewrites and a delete leaves dangling.
 */
export interface ModelReferencesWire {
  path: string;
  referencedBy: ReferenceWire[];
}

/** GET /api/repos — registry ∩ the session user's per-repo permission */
export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  avatarUrl: string | null;
  suspended: boolean;
  permission: "write" | "none";
  /** null when the workspace is not cloned yet (the overview never clones) */
  processCount: number | null;
  /** .dmn twin of processCount (additive: absent from pre-3.4 servers) */
  decisionCount: number | null;
  /** models (processes AND decisions) differing from origin/<default> */
  dirtyCount: number | null;
  liveSessions: number;
}

/** GET /api/me — and the response of POST /auth/exchange */
export interface Me {
  user: GitUserWire;
  wsToken: string;
}

/** POST /auth/exchange — an editor (the VS Code extension) turns the one-time
 *  code its sign-in URI handler received into its session (response: Me; 401
 *  for an unknown, used or expired code). See EDITOR_EXTENSION_ID in ./live.ts. */
export interface EditorLoginExchangeBody {
  code: string;
}

/** GET /api/config */
export interface AppConfig {
  /** the login(s) to offer as "/auth/<id>" buttons — the IdP login (`oidc`) when
   *  configured, empty on a LIVE_AUTH=none host (ADR 0007) */
  providers: { id: string; label: string }[];
  /** the host's authentication mode (ADR 0007): "none" = every request is the
   *  local principal, nothing to sign in to or out of; "oidc" = a login is required */
  auth: "none" | "oidc";
  installUrl: string | null;
  /** the MCP endpoint under the server's public URL — what an AI client connects to */
  mcpUrl: string;
}

/** POST /api/repos/:fullName/release/:id and /release (file selection) */
export interface ReleaseResult {
  /** the opened pull request's URL */
  pr: string;
  branch: string;
  by: string;
  repo: string;
  /** true when pushed/opened with the app installation token (self-approvable PR) */
  botAuthored: boolean;
  /** the repo-relative files the release shipped */
  files: string[];
}

/**
 * GET /api/repos/:fullName/changes — every file in which the shared workspace
 * differs from origin/<defaultBranch>, the pool a release selects from. The
 * workspace is shared per repo, so this may include colleagues' in-progress
 * edits — liveSessions marks files somebody currently has open.
 */
export interface ChangedFileWire {
  /** repo-root-relative path (the same identifier live rooms use) */
  path: string;
  status: "modified" | "added" | "deleted";
  liveSessions: number;
  /** changed on the default branch while the workspace held unreleased edits
   *  of it (#185) — the release refuses it until resolved (POST …/conflicts) */
  conflict: boolean;
  /** an ADDED file that a rename or move in the platform gave this path (#208)
   *  — the deleted file it came from; absent for everything else */
  renamedFrom?: string;
}

/** the slice of a changed file the move/rename pairing reads */
type Movable = Pick<ChangedFileWire, "path" | "status"> & { renamedFrom?: string };

/** the move key of a changed file: its file name, with a decision's tests
 *  sidecar keyed to its decision (`x.tests.yaml` → `x.dmn`) */
const moveKey = (path: string): string => (path.split("/").pop() ?? path).replace(/\.tests\.yaml$/i, ".dmn");

/** a decision's tests sidecar → the decision file next to it */
const sidecarOwner = (path: string): string | undefined =>
  /\.tests\.yaml$/i.test(path) ? path.replace(/\.tests\.yaml$/i, ".dmn") : undefined;

/**
 * The MOVE units of a GET /changes pool (#182, #208). A moved or renamed model
 * shows up as a deleted + added pair; shipping one half alone would leave the
 * model twice on the default branch, or not at all. A move pairs by file name
 * (the model keeps its stem), a rename by the added file's `renamedFrom`, and
 * a decision's tests sidecar joins its decision's unit. Maps every path of a
 * unit to the whole unit; paths outside a move are absent. The release ships
 * units whole — git then records a rename — and the release dialog selects
 * them whole.
 */
export function moveUnits(changes: ReadonlyArray<Movable>): Map<string, string[]> {
  const moving = changes.filter((c) => c.status !== "modified");
  const status = new Map(moving.map((c) => [c.path, c.status]));
  // union-find over the paths: every link below merges two groups
  const parent = new Map(moving.map((c) => [c.path, c.path]));
  const find = (p: string): string => {
    let root = p;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(p, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  const bothHalves = (paths: string[]): boolean =>
    paths.some((p) => status.get(p) === "added") && paths.some((p) => status.get(p) === "deleted");

  // a move: the same file name on both sides
  const byKey = new Map<string, string[]>();
  for (const c of moving) byKey.set(moveKey(c.path), [...(byKey.get(moveKey(c.path)) ?? []), c.path]);
  for (const group of byKey.values()) {
    if (!bothHalves(group)) continue;
    for (const p of group) union(p, group[0]!);
  }
  // a rename: the added file names where it came from
  for (const c of moving) {
    if (c.status === "added" && c.renamedFrom && status.get(c.renamedFrom) === "deleted") union(c.path, c.renamedFrom);
  }
  // a renamed decision's sidecar travels in its decision's unit
  for (const c of moving) {
    const owner = sidecarOwner(c.path);
    if (owner && status.get(owner) === c.status) union(c.path, owner);
  }

  const groups = new Map<string, string[]>();
  for (const c of moving) groups.set(find(c.path), [...(groups.get(find(c.path)) ?? []), c.path]);
  const units = new Map<string, string[]>();
  for (const paths of groups.values()) {
    if (!bothHalves(paths)) continue;
    for (const path of paths) units.set(path, paths);
  }
  return units;
}

/**
 * Where every moved or renamed file came from (#182, #208): new path → old
 * path. A rename names it (`renamedFrom`); a move pairs a unit's added half
 * with the deleted half of the SAME file name (a decision and its tests
 * sidecar pair separately). Whatever compares a moved file with its
 * default-branch version — the release's decision impact — looks the previous
 * version up at the old path.
 */
export function moveSources(changes: ReadonlyArray<Movable>): Map<string, string> {
  const status = new Map(changes.map((c) => [c.path, c.status]));
  const renamedFrom = new Map(changes.flatMap((c) => (c.renamedFrom ? [[c.path, c.renamedFrom] as const] : [])));
  const fileName = (path: string): string => path.split("/").pop() ?? path;
  const sources = new Map<string, string>();
  for (const [path, unit] of moveUnits(changes)) {
    if (status.get(path) !== "added") continue;
    const named = renamedFrom.get(path);
    const from =
      named && unit.includes(named)
        ? named
        : unit.find((p) => status.get(p) === "deleted" && fileName(p) === fileName(path));
    if (from) sources.set(path, from);
  }
  return sources;
}

/** POST /api/repos/:fullName/release — release exactly the selected files.
 * Every entry must currently be changed vs origin (GET /changes), otherwise 409. */
export interface ReleaseFilesBody {
  /** repo-relative paths to ship (non-empty) */
  files: string[];
  /** optional human title — becomes the PR/commit subject and the branch slug */
  title?: string;
}

/**
 * POST /api/repos/:fullName/sync — hard-reset the repo's workspace onto
 * origin/<defaultBranch> ("load the latest state from main"). Unreleased live
 * edits (the dirty processes) are discarded, so the client confirms first.
 */
export interface SyncResult {
  /** the branch the workspace was reset onto (the repo's default branch) */
  branch: string;
  /** repo-relative paths whose content the reset changed or removed */
  changed: string[];
}

/**
 * POST /api/repos/:fullName/conflicts — resolve a catch-up conflict (#185):
 * `main` gives the file the default branch's version (only this file; its
 * unreleased edits are discarded), `workspace` keeps the local version and
 * clears the flag, so the next release deliberately replaces upstream's change.
 */
export interface ResolveConflictBody {
  /** repo-relative path of a file flagged `conflict` in GET /changes */
  path: string;
  keep: "main" | "workspace";
}

export interface ResolveConflictResult {
  path: string;
  keep: "main" | "workspace";
}

/** GET /api/repos/:fullName/history?path=<model path>[&limit=<n>] — commits on
 * the default branch touching the file, newest first */
export interface FileCommitWire {
  /** full commit sha */
  sha: string;
  subject: string;
  /** message body below the subject line; "" when none */
  body: string;
  author: string;
  /** ISO-8601 author date */
  authoredAt: string;
}

/** GET /api/repos/:fullName/history/content?path=<model path>&sha=<sha> */
export interface FileAtCommitWire {
  sha: string;
  /** content-relative model path (the room path) */
  path: string;
  /** the file's full content at that commit */
  content: string;
}

/** one BPMN element a todo is anchored to (id = anchor, name = creation-time
 *  snapshot) — the wire shape IS the codec's TodoElement (./todo-anchor.ts);
 *  changing that type changes the LIVE wire format */
export type TodoElementWire = TodoElement;

/** platform anchor of a todo — which process/file/elements it belongs to;
 *  the wire shape IS the codec's TodoAnchor (./todo-anchor.ts) */
export type TodoAnchorWire = TodoAnchor;

/** GET /api/repos/:fullName/todos[?process=<id>] — one row per OPEN tracker item */
export interface TodoWire {
  /** tracker-native id as a string (GitHub/GitLab: issue number; Jira: "PROJ-123") */
  id: string;
  url: string;
  title: string;
  /** the author's description with the platform markup stripped ("" when none) */
  body: string;
  state: "open" | "done";
  /** null = no parseable anchor (e.g. created by hand in the tracker) */
  anchor: TodoAnchorWire | null;
  author: string | null;
  assignees: string[];
  createdAt: string;
}

/** POST /api/repos/:fullName/todos — response is the created TodoWire */
export interface CreateTodoBody {
  title: string;
  body?: string;
  anchor: {
    process: string;
    file?: string;
    elements?: TodoElementWire[];
    processVersion?: string;
  };
}

/** GET /api/repos/:fullName/content?path=<model path> — the LIVE document content
 *  (the same Y.Text the collaborative rooms edit, read server-side). One route
 *  for EVERY editable document: a notation's file text in its own format (XML
 *  for bpmn/dmn, the OWM/.storm DSL, JSON) and the YAML sidecars next to it. */
export interface ContentWire {
  repo: string;
  /** content-relative model path (the room path) */
  path: string;
  /** the complete document text, whatever the notation's format is */
  content: string;
  /** @deprecated alias of `content` (#154) — kept for one release so clients
   *  written against the XML-named wire keep working; read `content` */
  xml: string;
  /** opaque optimistic-concurrency token — changes on ANY edit (incl. delete-only) */
  baseVersion: string;
}

/** PUT /api/repos/:fullName/content?path=… — request body. baseVersion is REQUIRED
 *  (from a prior GET); a stale one returns 409 ContentConflictWire instead of overwriting. */
export interface PutContentBody {
  /** the complete document text, whatever the notation's format is */
  content: string;
  baseVersion: string;
  /** "block" (default): ERROR findings refuse the save (422). "warn": findings
   * come back on the result instead — the modeler widget's autosave uses this,
   * mirroring the ws path, which has never gated live edits. */
  lint?: "block" | "warn";
}

/** the PUT body as accepted ON THE WIRE: `content`, or the pre-#154 `xml` alias
 *  (deprecated, one release). `content` wins when both are present. */
export type PutContentRequest = PutContentBody | (Omit<PutContentBody, "content"> & { /** @deprecated */ xml: string });

/** PUT success response */
export interface PutContentResultWire {
  path: string;
  /** the new token to continue editing against */
  baseVersion: string;
  /** validator WARN findings of the notation's platform check (non-blocking;
   *  [] when the path is no registered notation, e.g. a YAML sidecar) */
  warnings: string[];
  /** validator ERROR findings — only present on lint:"warn" saves, where they
   * inform instead of refusing */
  errors?: string[];
}

/** PUT 409 — the document changed since the client's read */
export interface ContentConflictWire {
  error: string;
  code: "content/conflict";
  path: string;
  /** re-derive the edit against this and retry with the fresh baseVersion */
  currentContent: string;
  /** @deprecated alias of `currentContent` (#154, one release) */
  currentXml: string;
  baseVersion: string;
}

/** one peer of a model's live room — what the MCP get_presence tool answers
 *  per person (and per AI client) with the model open right now */
export interface PresencePeerWire {
  name: string;
  /** "agent" = an AI client acting for someone (server-asserted, see
   *  @designiq/contracts/live PresenceUser.kind) */
  kind: "human" | "agent";
  /** the caller's OWN human presence — the person an agent acts for. Matched
   *  server-side on the ws connection's login, never on the payload. */
  you: boolean;
  /** selected element ids — a human's selection; for an agent, the elements
   *  its last save changed */
  selection: string[];
  /** pointer in model coordinates (the DI space); null = off-canvas / none */
  cursor: { x: number; y: number } | null;
}

/** get_presence — who is in a model's live room; empty when nobody has it open */
export interface RoomPresenceWire {
  repo: string;
  path: string;
  peers: PresencePeerWire[];
}

/** the boot payload the Live Host bakes into the modeler widgets' HTML
 *  (the __DESIGNIQ_BOOT__ marker, http/mcp.ts) — parsed back by the widgets'
 *  bridge.ts. The widget iframe is sandboxed on the HOST's origin, so this is
 *  its only source of instance facts. */
export interface WidgetBootWire {
  /** LIVE_MCP_READONLY — the widget mounts a viewer instead of the editor */
  readonly: boolean;
  /** the instance's public origin — the base for "Open in designIQ" deep links;
   *  absent when an older Live Host injects a pre-publicUrl payload */
  publicUrl?: string;
}
