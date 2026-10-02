/**
 * Workspace manager (docs/multi-repo-architecture.md, C): one working
 * directory per connected repo.
 *
 *   host repo   — the checkout the Live Host runs in (zero-migration path:
 *                 live edits, dirty state and the demo keep working)
 *   other repos — cloned under <dataDir>/workspaces/<owner>/<name>; fetched
 *                 and caught up with origin/<branch> per file (#185): the
 *                 working tree is owned by write-through and never loses an
 *                 unreleased edit, a release marks what it shipped in the
 *                 index, release cuts worktrees from origin/<branch>
 *
 * The installation token is passed to git via env config (GIT_CONFIG_* →
 * http.extraHeader), NEVER baked into the persisted remote URL — so it never
 * lands at rest in .git/config and never appears in an error's command line.
 *
 * LIVE_GIT_URL_OVERRIDE (tests/offline): clone/fetch URL becomes
 * `<override>/<owner>/<name>.git` instead of the provider URL.
 */
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FileCommitWire } from "@bpmiq/contracts/live-host";

import { gitEnv, runGit, scrub } from "../adapters/git/run.ts";
import {
  catchUpAction,
  type IndexEntry,
  indexTarget,
  parks,
  parseIndex,
  parseRawDiff,
  releasedAfter,
  type UpstreamChange,
} from "../domain/catch-up.ts";
import { FILE_LOG_FORMAT, parseFileLog } from "../domain/file-history.ts";
import { hasContentConfig } from "./content.ts";
import type { ConnectedRepo, RepoRegistry } from "./registry.ts";

/** model blobs can exceed execFile's 1 MB default (large BPMN diagrams) */
const GIT_OUT_MAX = 16 * 1024 * 1024;

// The host-state names below (and the parking folder in catchUp) are FROZEN:
// they sit inside the .git of every clone a running installation already has.
// A renamed file reads as "no state" after an upgrade — and a lost conflict
// list lets the next release silently revert upstream work.

/** files changed on BOTH sides that the catch-up kept locally (#185) — a JSON
 *  path list inside the clone's .git, so it lives and dies with the checkout */
const CONFLICTS_FILE = "bpmiq-conflicts.json"; // legacy-name-ok: state inside existing clones

/** per file, the blobs its still-open releases shipped, oldest first (#185) —
 *  so an earlier release that merges while a later one is open is no
 *  conflict. Kept like the conflict list; the catch-up drains it. */
const RELEASED_FILE = "bpmiq-released.json"; // legacy-name-ok: state inside existing clones

/** the platform's renames and moves not yet released (#208), `from → to`
 *  with chains collapsed — git sees them as a delete + an add; this is what
 *  pairs the two halves again (ChangedFileWire.renamedFrom). Kept like the
 *  conflict list; stale pairs simply stop matching the changes. */
const RENAMES_FILE = "bpmiq-renames.json"; // legacy-name-ok: state inside existing clones

/** path → blobs, oldest first (null = a shipped deletion) */
type ReleasedLists = Map<string, Array<string | null>>;

/** paths per git invocation — keeps argv far below ARG_MAX */
const ARGV_CHUNK = 200;

const chunks = <T>(items: T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / ARGV_CHUNK) }, (_, i) =>
    items.slice(i * ARGV_CHUNK, (i + 1) * ARGV_CHUNK),
  );

export interface WorkspaceHooks {
  /** repo-root-relative paths of this repo's files open in a live session —
   *  the catch-up never rewrites one of them under an editor */
  livePaths?: (repo: ConnectedRepo) => string[];
  /** upstream content was written into these files — invalidate their Yjs lineages */
  onReconciled?: (repo: ConnectedRepo, changedPaths: string[]) => void;
}

export class WorkspaceManager {
  private readonly dataDir: string;
  private readonly hostRepo: string;
  private readonly hostRoot: string;
  private readonly registry: RepoRegistry;
  private readonly gitBase: string;
  private readonly ensured = new Map<string, number>();
  /** single-flight: concurrent ensure() for the same repo share one promise */
  private readonly inflight = new Map<string, Promise<string>>();
  /** per-repo chain of the git operations that write .git/index (catch-up,
   *  release marks, conflict resolution, reset) — they never interleave */
  private readonly tails = new Map<string, Promise<unknown>>();
  hooks: WorkspaceHooks = {};

  constructor(args: {
    dataDir: string;
    hostRepo: string;
    hostRoot: string;
    registry: RepoRegistry;
    githubBaseUrl: string;
  }) {
    this.dataDir = args.dataDir;
    this.hostRepo = args.hostRepo.toLowerCase();
    this.hostRoot = args.hostRoot;
    this.registry = args.registry;
    this.gitBase = args.githubBaseUrl.replace(/\/$/, "");
  }

  isHostRepo(fullName: string): boolean {
    // Serve the local host checkout in place — no clone — when it actually is a
    // BPM content repo (bpmiq.yml at its root). In a deployed image without the
    // config, the host repo is cloned like any other via an installation token.
    // hasContentConfig, not a file-name probe: a bind-mounted checkout whose
    // contract file carries the other accepted name is served in place as well.
    return fullName.toLowerCase() === this.hostRepo && hasContentConfig(this.hostRoot);
  }

  /** git checkout location for a connected repo (clone target; no provisioning) */
  private checkoutDir(repo: ConnectedRepo): string {
    if (this.isHostRepo(repo.fullName)) return this.hostRoot;
    return join(this.dataDir, "workspaces", ...repo.fullName.split("/"));
  }

  /**
   * Checkout root of a connected repo (no provisioning). Everything downstream
   * — rooms, process listing, releases — is repo-root-relative; where the BPM
   * content lives inside the repo is the content config's business (bpmiq.yml,
   * repos/content.ts), not a filesystem heuristic.
   */
  dir(repo: ConnectedRepo): string {
    return this.checkoutDir(repo);
  }

  /** clean remote URL (no credentials — the token travels via gitEnv) */
  private cleanUrl(repo: ConnectedRepo): string {
    const override = process.env.LIVE_GIT_URL_OVERRIDE;
    if (override) return `${override.replace(/\/$/, "")}/${repo.fullName}.git`;
    return `${this.gitBase}/${repo.fullName}.git`;
  }

  async ensure(repo: ConnectedRepo): Promise<string> {
    if (this.isHostRepo(repo.fullName)) return this.dir(repo);
    const existing = this.inflight.get(repo.fullName);
    if (existing) return existing;
    const p = this.provision(repo).finally(() => this.inflight.delete(repo.fullName));
    this.inflight.set(repo.fullName, p);
    return p;
  }

  /**
   * Clone (first time) or fetch (at most every 60s) and catch up with the
   * default branch (reconcile): otherwise upstream-merged changes never reach
   * live documents, upstream-created processes never appear, and the next
   * release silently reverts foreign work. Between fetches, ensure() still
   * waits for a catch-up a release started — nobody seeds a room from a tree
   * that is being rewritten.
   */
  private async provision(repo: ConnectedRepo): Promise<string> {
    const dir = this.checkoutDir(repo);
    const token = await this.registry.tokenFor(repo);
    const url = this.cleanUrl(repo);

    if (existsSync(join(dir, ".git"))) {
      if (Date.now() - (this.ensured.get(repo.fullName) ?? 0) > 60_000) {
        try {
          await runGit(["-C", dir, "fetch", "origin", repo.defaultBranch], { env: gitEnv(token) });
          this.ensured.set(repo.fullName, Date.now());
          await this.reconcile(repo);
        } catch (e) {
          console.log(`fetch ${repo.fullName} failed: ${scrub((e as Error).message).split("\n")[0]}`);
        }
      } else {
        await this.tails.get(repo.fullName)?.catch(() => undefined);
      }
      return dir;
    }

    await mkdir(dirname(dir), { recursive: true });
    console.log(`cloning ${repo.fullName} → ${dir}`);
    try {
      await runGit(["clone", "--branch", repo.defaultBranch, url, dir], { env: gitEnv(token) });
    } catch (e) {
      throw new Error(`clone ${repo.fullName} failed: ${scrub((e as Error).message)}`);
    }
    this.ensured.set(repo.fullName, Date.now());
    return dir;
  }

  /** run `op` after every earlier index-writing operation of this repo */
  private serial<T>(repo: ConnectedRepo, op: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(repo.fullName) ?? Promise.resolve()).catch(() => undefined).then(op);
    this.tails.set(repo.fullName, next);
    const settled = () => {
      if (this.tails.get(repo.fullName) === next) this.tails.delete(repo.fullName);
    };
    next.then(settled, settled);
    return next;
  }

  /**
   * Catch the workspace up with origin/<branch> (#185) — per file, never over
   * anyone's unreleased edits. git's fast-forward does the heavy lifting: it
   * keeps every locally edited file upstream did not touch and writes every
   * untouched file upstream changed. The files it would refuse get the index
   * entry that lets it pass (domain/catch-up.ts): a merged release is simply
   * clean afterwards (also an earlier one of a file released again meanwhile,
   * via the release list), and a file changed on BOTH sides keeps its local version
   * and lands on the conflict list, which the release guard refuses until
   * someone resolves it. Stands down (retried after the next fetch) only when
   * a file it would rewrite is open in a live session — write-through would
   * put the editor's stale state right back. Rewritten files get their Yjs
   * lineage invalidated (hooks.onReconciled) so the next open reseeds from the
   * new tree. The in-place host checkout is never touched: it is the
   * operator's own working tree.
   */
  async reconcile(repo: ConnectedRepo): Promise<void> {
    if (this.isHostRepo(repo.fullName)) return;
    const dir = this.dir(repo);
    await this.serial(repo, async () => {
      await this.catchUp(repo, dir);
      await this.pruneConflicts(repo, dir);
    });
  }

  private async catchUp(repo: ConnectedRepo, dir: string): Promise<void> {
    const { stdout: oldHead } = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    const { stdout: newHead } = await runGit(["-C", dir, "rev-parse", `origin/${repo.defaultBranch}`]);
    const [from, to] = [oldHead.trim(), newHead.trim()];
    if (from === to) return;
    const released = await this.readReleased(dir);
    const plan = (await this.upstreamChanges(dir, from, to, released)).map((c) => ({ c, action: catchUpAction(c) }));
    const taken = plan.filter((p) => p.action === "take").map((p) => p.c.path);
    // a local file at a path upstream deletes (edited or re-created here): git
    // refuses to fast-forward "over" it once untracked, so it is parked inside .git
    const parked = plan.filter((p) => parks(p.c, p.action)).map((p) => p.c.path);
    const live = new Set(this.hooks.livePaths?.(repo) ?? []);
    const busy = [...taken, ...parked].filter((p) => live.has(p));
    if (busy.length > 0) {
      console.log(
        `reconcile ${repo.fullName}: deferred — changed upstream but open in a live session: ${busy.join(", ")}`,
      );
      return;
    }
    const conflicts = plan.filter((p) => p.action === "conflict").map((p) => p.c.path);
    // flag FIRST: once the index holds upstream, nothing but this list
    // remembers that the local version builds on an older state
    if (conflicts.length > 0) await this.writeConflicts(dir, [...(await this.readConflicts(dir)), ...conflicts]);
    await this.setIndex(
      dir,
      plan.map((p) => ({ path: p.c.path, entry: indexTarget(p.c, p.action) })),
    );
    const parking = join(dir, ".git", "bpmiq-parked"); // legacy-name-ok: frozen like the state files above
    await mkdir(parking, { recursive: true });
    for (const [i, path] of parked.entries()) await rename(join(dir, path), join(parking, String(i)));
    try {
      await runGit(["-C", dir, "merge", "--ff-only", "-q", to]);
    } catch (e) {
      console.log(`reconcile ${repo.fullName}: fast-forward failed (${scrub((e as Error).message).split("\n")[0]})`);
      return;
    } finally {
      for (const [i, path] of parked.entries()) {
        await mkdir(dirname(join(dir, path)), { recursive: true }); // git may have pruned the emptied folder
        await rename(join(parking, String(i)), join(dir, path));
      }
    }
    // only once HEAD moved: a release upstream reached (and every older one)
    // is no longer open; anything else upstream did to the file ends its list
    const settled = plan.filter((p) => released.has(p.c.path));
    if (settled.length > 0) {
      for (const { c } of settled) released.set(c.path, releasedAfter(c));
      await this.writeReleased(dir, released);
    }
    console.log(
      `reconciled ${repo.fullName}: ${from.slice(0, 7)} → ${to.slice(0, 7)} ` +
        `(${taken.length} file(s) updated, ${conflicts.length} conflict(s))`,
    );
    if (taken.length > 0) this.hooks.onReconciled?.(repo, taken);
  }

  /** every file the default branch changed between two commits, with the
   *  workspace's index entry and working-tree content of each */
  private async upstreamChanges(
    dir: string,
    from: string,
    to: string,
    released: ReleasedLists,
  ): Promise<UpstreamChange[]> {
    const { stdout: raw } = await runGit(
      ["-C", dir, "diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", from, to],
      { maxBuffer: GIT_OUT_MAX },
    );
    const sides = parseRawDiff(raw);
    const { stdout: ls } = await runGit(["-C", dir, "ls-files", "-s", "-z"], { maxBuffer: GIT_OUT_MAX });
    const index = parseIndex(ls);
    const tree = await this.hashTree(
      dir,
      sides.map((c) => c.path),
    );
    return sides.map((c) => ({
      ...c,
      index: index.get(c.path) ?? null,
      tree: tree.get(c.path) ?? null,
      released: released.get(c.path) ?? [],
    }));
  }

  /** working-tree object ids, hashed the way `git add` would; absent files
   *  are missing from the map */
  private async hashTree(dir: string, paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const files: string[] = [];
    for (const path of paths) {
      const st = lstatSync(join(dir, path), { throwIfNoEntry: false });
      if (st?.isFile()) files.push(path);
      else if (st) out.set(path, "(not a regular file)"); // never equals an object id
    }
    for (const chunk of chunks(files)) {
      const { stdout } = await runGit(["-C", dir, "hash-object", "--", ...chunk]);
      stdout
        .split("\n")
        .filter(Boolean)
        .forEach((id, i) => {
          const path = chunk[i];
          if (path) out.set(path, id.trim());
        });
    }
    return out;
  }

  /** the entries of `paths` in a commit's tree (absent paths are missing) */
  private async treeEntries(dir: string, commit: string, paths: string[]): Promise<Map<string, IndexEntry>> {
    const out = new Map<string, IndexEntry>();
    for (const chunk of chunks(paths)) {
      const { stdout } = await runGit(["-C", dir, "ls-tree", "-r", "-z", commit, "--", ...chunk], {
        maxBuffer: GIT_OUT_MAX,
      });
      for (const record of stdout.split("\0")) {
        const tab = record.indexOf("\t");
        const [mode, , blob] = record.slice(0, tab).split(" ");
        if (tab > 0 && mode && blob) out.set(record.slice(tab + 1), { mode, blob });
      }
    }
    return out;
  }

  /** set index entries (null = remove, undefined = leave) — never the working tree */
  private async setIndex(dir: string, entries: Array<{ path: string; entry: IndexEntry | null | undefined }>) {
    const set = entries.flatMap(({ path, entry }) => (entry ? [`${entry.mode},${entry.blob},${path}`] : []));
    const remove = entries.flatMap(({ path, entry }) => (entry === null ? [path] : []));
    for (const chunk of chunks(set)) {
      await runGit(["-C", dir, "update-index", "--add", ...chunk.flatMap((info) => ["--cacheinfo", info])]);
    }
    for (const chunk of chunks(remove)) {
      await runGit(["-C", dir, "update-index", "--force-remove", "--", ...chunk]);
    }
  }

  /** a JSON state file inside the clone's .git — undefined when absent or unreadable */
  private async readState(dir: string, name: string, gitDir = join(dir, ".git")): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(gitDir, name), "utf8"));
    } catch {
      return undefined; // not written yet
    }
  }

  /** undefined removes the file */
  private async writeState(dir: string, name: string, value: unknown, gitDir = join(dir, ".git")): Promise<void> {
    const file = join(gitDir, name);
    if (value === undefined) return rm(file, { force: true });
    // write + rename: a torn conflict list would read as "no conflicts" — the
    // one state whose loss could let a release silently revert upstream work
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
  }

  private async readConflicts(dir: string): Promise<string[]> {
    const parsed = await this.readState(dir, CONFLICTS_FILE);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  }

  private async writeConflicts(dir: string, paths: string[]): Promise<void> {
    const unique = [...new Set(paths)].sort();
    await this.writeState(dir, CONFLICTS_FILE, unique.length > 0 ? unique : undefined);
  }

  private async readReleased(dir: string): Promise<ReleasedLists> {
    const parsed = await this.readState(dir, RELEASED_FILE);
    const out: ReleasedLists = new Map();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [path, list] of Object.entries(parsed)) {
      if (Array.isArray(list))
        out.set(
          path,
          list.filter((b): b is string | null => b === null || typeof b === "string"),
        );
    }
    return out;
  }

  /** empty lists are dropped */
  private async writeReleased(dir: string, released: ReleasedLists): Promise<void> {
    const open = [...released].filter(([, list]) => list.length > 0).sort(([a], [b]) => a.localeCompare(b));
    await this.writeState(dir, RELEASED_FILE, open.length > 0 ? Object.fromEntries(open) : undefined);
  }

  /** a conflict heals by itself once the working tree equals the default
   *  branch again (someone took main's version, or re-did its change) */
  private async pruneConflicts(repo: ConnectedRepo, dir: string): Promise<void> {
    const listed = await this.readConflicts(dir);
    if (listed.length === 0) return;
    const upstream = await this.treeEntries(dir, `origin/${repo.defaultBranch}`, listed);
    const tree = await this.hashTree(dir, listed);
    const open = listed.filter((p) => (tree.get(p) ?? null) !== (upstream.get(p)?.blob ?? null));
    if (open.length < listed.length) await this.writeConflicts(dir, open);
  }

  /**
   * Files the catch-up kept locally although the default branch changed them
   * too (#185) — releasing one would silently revert upstream's change, so
   * the release guard refuses them until resolved. Always [] for the in-place
   * host checkout (never caught up).
   */
  async conflicts(repo: ConnectedRepo): Promise<string[]> {
    if (this.isHostRepo(repo.fullName)) return [];
    return this.readConflicts(this.dir(repo));
  }

  /**
   * Resolve a conflict for the default branch: the file gets origin's version
   * (or goes, when origin deleted it) in index and working tree and leaves the
   * conflict list. Only this file — every other unreleased edit stays. Its
   * release list goes too: the file now builds on main, not on an older
   * release that may still merge. The caller drops the file's Yjs lineage.
   */
  async takeUpstream(repo: ConnectedRepo, path: string): Promise<void> {
    if (this.isHostRepo(repo.fullName)) {
      throw new Error(`refusing to rewrite the in-place host checkout ${repo.fullName}`);
    }
    const dir = this.dir(repo);
    await this.serial(repo, async () => {
      const ref = `origin/${repo.defaultBranch}`;
      if ((await this.treeEntries(dir, ref, [path])).has(path)) {
        await runGit(["-C", dir, "checkout", ref, "--", path]);
      } else {
        await runGit(["-C", dir, "rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
        await rm(join(dir, path), { force: true });
      }
      await this.writeConflicts(
        dir,
        (await this.readConflicts(dir)).filter((p) => p !== path),
      );
      const released = await this.readReleased(dir);
      if (released.delete(path)) await this.writeReleased(dir, released);
    });
  }

  /** resolve a conflict for the workspace: the flag goes, the local version
   *  stays — the next release deliberately replaces upstream's change */
  async keepWorkspace(repo: ConnectedRepo, path: string): Promise<void> {
    const dir = this.dir(repo);
    await this.serial(repo, async () => {
      await this.writeConflicts(
        dir,
        (await this.readConflicts(dir)).filter((p) => p !== path),
      );
    });
  }

  /**
   * Mark what a release shipped (#185): the released blobs become the index
   * entries — the base further live edits build on. Once the PR merges, the
   * catch-up finds index == upstream and keeps the working tree: the release
   * is no longer a change, edits made since stay one. A path missing from the
   * release commit (a shipped deletion) loses its entry. Each blob also joins
   * the file's release list, because releasing the file again moves the index
   * on while this PR may still merge first. Never the in-place host checkout
   * (that index is the operator's).
   */
  async markReleased(repo: ConnectedRepo, commit: string, paths: string[]): Promise<void> {
    if (this.isHostRepo(repo.fullName)) return;
    const dir = this.dir(repo);
    await this.serial(repo, async () => {
      const shipped = await this.treeEntries(dir, commit, paths);
      const entries = paths.map((path) => ({ path, entry: shipped.get(path) ?? null }));
      const released = await this.readReleased(dir);
      for (const { path, entry } of entries) {
        const list = released.get(path) ?? [];
        const blob = entry?.blob ?? null;
        if (list.at(-1) !== blob) released.set(path, [...list, blob]);
      }
      await this.writeReleased(dir, released);
      await this.setIndex(dir, entries);
    });
  }

  /**
   * Files under `pathspec` in which the working tree differs from
   * origin/<defaultBranch> — the overview's "dirty" signal. `git diff` only
   * sees TRACKED files, so untracked ones (a live-created process that never
   * released) are collected separately — the same idiom resetToDefault uses;
   * without it a brand-new .bpmn would show as clean. Runs in the checkout
   * root (paths come back repo-root-relative, matching room names).
   * Errors (no git, no origin — e.g. the in-place host checkout) yield []
   * silently: "not dirty" is the honest answer with nothing to diff against.
   */
  async changedPaths(repo: ConnectedRepo, pathspec: string): Promise<string[]> {
    try {
      const dir = this.dir(repo);
      // quotepath off: git would C-quote non-ASCII names ("\303\244…"), which
      // must never leak into wire paths / room-name comparisons
      const { stdout: diff } = await runGit(
        [
          "-C",
          dir,
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-only",
          `origin/${repo.defaultBranch}`,
          "--",
          pathspec,
          // the pathspec can be the WHOLE processes root since the one-call dirty
          // aggregation (#95) — the default 1 MiB execFile buffer silently turned
          // >1 MiB of untracked/diff output into "everything clean" (the catch
          // maps errors to []), which skipped the destructive-sync confirmation
        ],
        { maxBuffer: GIT_OUT_MAX },
      );
      const { stdout: untracked } = await runGit(
        ["-C", dir, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "--", pathspec],
        { maxBuffer: GIT_OUT_MAX },
      );
      const paths = new Set(
        `${diff}\n${untracked}`
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      return [...paths];
    } catch {
      /* no git/origin — leave clean */
      return [];
    }
  }

  /**
   * changedPaths with a status per file — the release dialog's file list,
   * confined to `pathspec` (the bpmiq.yml content scope: the release surface
   * must never expose checkout files outside it, e.g. the in-place host
   * checkout's server sources). `--no-renames` keeps a rename visible as
   * delete + add (the release stages per file, so that is exactly how it
   * would ship). Same untracked idiom and same silent-[] error contract as
   * changedPaths. An added file a platform rename/move produced names its
   * deleted origin (`renamedFrom`, #208) — the release ships the pair whole.
   */
  async changedFiles(
    repo: ConnectedRepo,
    pathspec: string,
  ): Promise<Array<{ path: string; status: "modified" | "added" | "deleted"; renamedFrom?: string }>> {
    try {
      const dir = this.dir(repo);
      const { stdout: diff } = await runGit(
        [
          "-C",
          dir,
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-status",
          "--no-renames",
          `origin/${repo.defaultBranch}`,
          "--",
          pathspec,
        ],
        { maxBuffer: GIT_OUT_MAX },
      );
      const { stdout: untracked } = await runGit(
        ["-C", dir, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "--", pathspec],
        { maxBuffer: GIT_OUT_MAX },
      );
      const out = new Map<string, "modified" | "added" | "deleted">();
      for (const line of diff.split("\n")) {
        const [status, path] = line.split("\t").map((c) => c.trim());
        if (!status || !path) continue;
        out.set(path, status.startsWith("D") ? "deleted" : status.startsWith("A") ? "added" : "modified");
      }
      for (const line of untracked.split("\n")) {
        const path = line.trim();
        if (path) out.set(path, "added");
      }
      // a platform rename/move names the file an added path came from — only
      // while BOTH halves are still changes (a released or undone half ends it)
      const renamedFrom = new Map(
        (await this.readRenames(dir))
          .filter((r) => out.get(r.to) === "added" && out.get(r.from) === "deleted")
          .map((r) => [r.to, r.from]),
      );
      return [...out]
        .map(([path, status]) => {
          const from = renamedFrom.get(path);
          return from ? { path, status, renamedFrom: from } : { path, status };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      /* no git/origin — leave clean */
      return [];
    }
  }

  /**
   * Remember renames and moves the platform made (#208), so the release pairs
   * their delete + add halves (changedFiles → renamedFrom) and git records a
   * rename. Chains collapse (a → b, then b → c is a → c), a rename back to
   * the original drops the pair, and a pair whose new file is gone is pruned.
   * So is a pair whose old path the default branch no longer has (released
   * and merged, or never released): it pairs nothing any more, and a later
   * rename must not chain onto it — a → b merged, then b → c would record
   * a → c, and b → c would ship as two unrelated halves.
   */
  async recordRenames(repo: ConnectedRepo, pairs: Array<{ from: string; to: string }>): Promise<void> {
    if (pairs.length === 0) return;
    const dir = this.dir(repo);
    await this.serial(repo, async () => {
      const recorded = await this.readRenames(dir);
      const origins = recorded.map((r) => r.from);
      const gone = await this.absentOnDefault(repo, dir, origins);
      const journal = recorded.filter((r) => !gone.has(r.from));
      for (const { from, to } of pairs) {
        const chained = journal.find((r) => r.to === from);
        if (chained) chained.to = to;
        else journal.push({ from, to });
      }
      const open = journal.filter((r) => r.from !== r.to && existsSync(join(dir, r.to)));
      await this.writeState(dir, RENAMES_FILE, open.length > 0 ? open : undefined, await this.gitDir(dir));
    });
  }

  /** the platform's renames/moves (#208) — what a reset (load latest from
   *  main) may undo; [] for a checkout without the journal. A pair released
   *  since may still be listed (pruned on the next recordRenames): check it
   *  against what the reset actually changed */
  async renames(repo: ConnectedRepo): Promise<Array<{ from: string; to: string }>> {
    return this.readRenames(this.dir(repo));
  }

  /** those of `paths` origin/<defaultBranch> does not have — empty when git
   *  cannot tell (no origin yet): best effort, like the journal itself */
  private async absentOnDefault(repo: ConnectedRepo, dir: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    try {
      const { stdout } = await runGit(
        ["-C", dir, "ls-tree", "-z", "--name-only", `origin/${repo.defaultBranch}`, "--", ...paths],
        { maxBuffer: GIT_OUT_MAX },
      );
      const present = new Set(stdout.split("\0").filter(Boolean));
      return new Set(paths.filter((p) => !present.has(p)));
    } catch {
      return new Set();
    }
  }

  /** never throws — a lost journal only costs the pairing, never the changes list */
  private async readRenames(dir: string): Promise<Array<{ from: string; to: string }>> {
    let parsed: unknown;
    try {
      parsed = await this.readState(dir, RENAMES_FILE, await this.gitDir(dir));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is { from: string; to: string } =>
        typeof r === "object" && r !== null && typeof r.from === "string" && typeof r.to === "string",
    );
  }

  /** the checkout's git directory — `.git` itself, or wherever a `.git` FILE
   *  points (the in-place host checkout may be a linked worktree) */
  private async gitDir(dir: string): Promise<string> {
    const dotGit = join(dir, ".git");
    if (lstatSync(dotGit, { throwIfNoEntry: false })?.isFile() !== true) return dotGit;
    const { stdout } = await runGit(["-C", dir, "rev-parse", "--absolute-git-dir"]);
    return stdout.trim();
  }

  /**
   * Hard-reset the workspace onto origin/<defaultBranch> — "load the latest
   * state from main", DISCARDING every uncommitted live edit (the opposite of
   * reconcile, which never touches one), release marks and conflicts included.
   * Fetches first, records the
   * paths the reset will overwrite or remove (tracked diffs vs origin PLUS
   * untracked files git clean will delete) so their Yjs lineage can be dropped,
   * then `reset --hard` + `clean -fd`. Returns those repo-root-relative paths.
   *
   * REFUSES the in-place host checkout: a `reset --hard` there would wipe the
   * operator's own working tree (the whole monorepo, not just models). Only
   * cloned workspaces under <dataDir>/workspaces are reset-safe — the caller
   * (application/sync.ts) already rejects the host repo with a 422, this is the
   * defense-in-depth backstop.
   */
  async resetToDefault(repo: ConnectedRepo): Promise<string[]> {
    if (this.isHostRepo(repo.fullName)) {
      throw new Error(`refusing to hard-reset the in-place host checkout ${repo.fullName}`);
    }
    return this.serial(repo, () => this.hardReset(repo));
  }

  private async hardReset(repo: ConnectedRepo): Promise<string[]> {
    const dir = this.dir(repo);
    const token = await this.registry.tokenFor(repo);
    await runGit(["-C", dir, "fetch", "origin", repo.defaultBranch], { env: gitEnv(token) });
    const affected = new Set<string>();
    // tracked files whose working-tree content (committed or not) differs from
    // origin — exactly what `reset --hard` will overwrite
    const { stdout: diff } = await runGit(["-C", dir, "diff", "--name-only", `origin/${repo.defaultBranch}`], {
      maxBuffer: GIT_OUT_MAX,
    });
    // untracked files (live-created, never committed) — `clean -fd` removes them
    const { stdout: untracked } = await runGit(["-C", dir, "ls-files", "--others", "--exclude-standard"], {
      maxBuffer: GIT_OUT_MAX,
    });
    for (const list of [diff, untracked]) {
      for (const line of list.split("\n")) {
        const p = line.trim();
        if (p) affected.add(p);
      }
    }
    await runGit(["-C", dir, "reset", "--hard", `origin/${repo.defaultBranch}`]);
    await runGit(["-C", dir, "clean", "-fd"]);
    // nothing unreleased is left to conflict, and an open release that merges
    // later is plain upstream work for the reset tree (the catch-up takes it)
    await this.writeConflicts(dir, []);
    await this.writeReleased(dir, new Map());
    await this.writeState(dir, RENAMES_FILE, undefined);
    // the tree now matches the ref we just fetched — keep provision()'s 60s
    // throttle honest so it doesn't immediately re-fetch/reconcile behind us
    this.ensured.set(repo.fullName, Date.now());
    return [...affected];
  }

  /**
   * Commit history of ONE content file on the default branch, newest first.
   * Prefers origin/<defaultBranch> (the released truth release/dirty diff
   * against — local HEAD may carry unmerged release commits); the in-place
   * host checkout may have no origin, so fall back to the local branch, then
   * HEAD. Runs in the checkout root — the path is repo-root-relative (= the
   * room path). Deliberately NO --follow: it would list pre-rename commits
   * whose content fileAtCommit(currentPath) can never fetch — every row the
   * panel shows must be comparable/restorable, so a rename honestly cuts the
   * visible history instead of offering dead actions. Errors (no git, no
   * commits yet) yield []: an empty history, not a 500.
   */
  async fileHistory(repo: ConnectedRepo, path: string, limit: number): Promise<FileCommitWire[]> {
    await this.freshenHostRepo(repo);
    const dir = this.dir(repo);
    try {
      const ref = await this.historyRef(repo, dir);
      const { stdout } = await runGit(
        ["-C", dir, "log", `--max-count=${limit}`, `--format=${FILE_LOG_FORMAT}`, ref, "--", path],
        { maxBuffer: GIT_OUT_MAX },
      );
      return parseFileLog(stdout);
    } catch (e) {
      console.log(`history ${repo.fullName}/${path}: ${scrub((e as Error).message).split("\n")[0]}`);
      return [];
    }
  }

  /**
   * ensure() never fetches the in-place host checkout, so its origin/<branch>
   * would stay frozen at deploy time and the history panel would never see a
   * merged release. Refresh the REF here (same 60s throttle) — a fetch only
   * moves remote-tracking refs, it never touches the operator's working tree.
   * Failures (no remote, no credentials) are throttled too, then served from
   * the last known ref — historyRef falls back to the local branch anyway.
   */
  private async freshenHostRepo(repo: ConnectedRepo): Promise<void> {
    if (!this.isHostRepo(repo.fullName)) return; // clones are fetched by ensure()
    if (Date.now() - (this.ensured.get(repo.fullName) ?? 0) <= 60_000) return;
    this.ensured.set(repo.fullName, Date.now());
    try {
      const token = await this.registry.tokenFor(repo);
      await runGit(["-C", this.checkoutDir(repo), "fetch", "origin", repo.defaultBranch], { env: gitEnv(token) });
    } catch (e) {
      console.log(`history fetch ${repo.fullName}: ${scrub((e as Error).message).split("\n")[0]}`);
    }
  }

  /**
   * Content of ONE file at a commit — `git show <sha>:./<path>` in the
   * checkout root (`./` pins the blob path as cwd-relative). null when the
   * commit is unknown or the file does not exist at it.
   */
  async fileAtCommit(repo: ConnectedRepo, path: string, sha: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(["-C", this.dir(repo), "show", `${sha}:./${path}`], {
        maxBuffer: GIT_OUT_MAX,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  /** best available "default branch" ref: fetched origin, local branch, HEAD */
  private async historyRef(repo: ConnectedRepo, dir: string): Promise<string> {
    for (const ref of [`origin/${repo.defaultBranch}`, repo.defaultBranch]) {
      try {
        await runGit(["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
        return ref;
      } catch {
        /* not present — try the next */
      }
    }
    return "HEAD";
  }
}
