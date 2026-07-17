/**
 * Workspace manager (docs/multi-repo-architecture.md, C): one working
 * directory per connected repo.
 *
 *   host repo   — the checkout the Live Host runs in (zero-migration path:
 *                 live edits, dirty state and the demo keep working)
 *   other repos — cloned under <dataDir>/workspaces/<owner>/<name>; fetched
 *                 (never auto-merged: the working tree is owned by
 *                 write-through, release cuts worktrees from origin/<branch>)
 *
 * The installation token is passed to git via env config (GIT_CONFIG_* →
 * http.extraHeader), NEVER baked into the persisted remote URL — so it never
 * lands at rest in .git/config and never appears in an error's command line.
 *
 * LIVE_GIT_URL_OVERRIDE (tests/offline): clone/fetch URL becomes
 * `<override>/<owner>/<name>.git` instead of the provider URL.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FileCommitWire } from "@bpmiq/contracts/live-host";

import { gitEnv, runGit, scrub } from "../adapters/git/run.ts";
import { FILE_LOG_FORMAT, parseFileLog } from "../domain/file-history.ts";
import { CONTENT_CONFIG_FILE } from "./content.ts";
import type { ConnectedRepo, RepoRegistry } from "./registry.ts";

/** model blobs can exceed execFile's 1 MB default (large BPMN diagrams) */
const GIT_OUT_MAX = 16 * 1024 * 1024;

export interface WorkspaceHooks {
  /** true while any live document of this repo has connections — blocks reconcile */
  hasLiveDocs?: (repo: ConnectedRepo) => boolean;
  /** upstream commits were fast-forwarded into the tree — invalidate these files' Yjs lineages */
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
    return fullName.toLowerCase() === this.hostRepo && existsSync(join(this.hostRoot, CONTENT_CONFIG_FILE));
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
   * Clone (first time) or fetch (at most every 60s). NEVER merges into a DIRTY
   * working tree — write-through owns it; release/dirty-diff use origin/<branch>
   * which the fetch updates. But a clean tree with no live sessions IS
   * reconciled (fast-forward): otherwise upstream-merged changes never reach
   * live documents, upstream-created processes never appear, and the next
   * release silently reverts foreign work.
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
          await this.reconcile(repo, dir);
        } catch (e) {
          console.log(`fetch ${repo.fullName} failed: ${scrub((e as Error).message).split("\n")[0]}`);
        }
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

  /**
   * Fast-forward the working tree onto origin/<branch> when it is SAFE:
   * no uncommitted live edits (write-through owns dirty trees) and no live
   * sessions (an open doc's lineage must not race a reseed). Lineages of files
   * the fast-forward changed are invalidated via hooks.onReconciled so the next
   * open reseeds from the updated tree instead of write-through resurrecting
   * the stale state.
   */
  private async reconcile(repo: ConnectedRepo, dir: string): Promise<void> {
    if (this.hooks.hasLiveDocs?.(repo)) return;
    const { stdout: status } = await runGit(["-C", dir, "status", "--porcelain"]);
    if (status.trim().length > 0) return; // live edits on disk — never merge over them
    const { stdout: oldHead } = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    const { stdout: newHead } = await runGit(["-C", dir, "rev-parse", `origin/${repo.defaultBranch}`]);
    if (oldHead.trim() === newHead.trim()) return;
    try {
      await runGit(["-C", dir, "merge", "--ff-only", `origin/${repo.defaultBranch}`]);
    } catch (e) {
      console.log(`reconcile ${repo.fullName}: fast-forward failed (${scrub((e as Error).message).split("\n")[0]})`);
      return;
    }
    const { stdout: changed } = await runGit([
      "-C",
      dir,
      "diff",
      "--name-only",
      `${oldHead.trim()}..${newHead.trim()}`,
    ]);
    // lineage keys are repo-root-relative — exactly what git diff emits
    const changedPaths = changed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    console.log(
      `reconciled ${repo.fullName}: ${oldHead.trim().slice(0, 7)} → ${newHead.trim().slice(0, 7)} (${changedPaths.length} content file(s))`,
    );
    if (changedPaths.length > 0) this.hooks.onReconciled?.(repo, changedPaths);
  }

  /**
   * Files under `pathspec` in which the working tree differs from
   * origin/<defaultBranch> — the overview's "dirty" signal. Runs in the
   * checkout root (paths come back repo-root-relative, matching room names).
   * Errors (no git, no origin — e.g. the in-place host checkout) yield []
   * silently: "not dirty" is the honest answer with nothing to diff against.
   */
  async changedPaths(repo: ConnectedRepo, pathspec: string): Promise<string[]> {
    try {
      const { stdout } = await runGit([
        "-C",
        this.dir(repo),
        "diff",
        "--name-only",
        `origin/${repo.defaultBranch}`,
        "--",
        pathspec,
      ]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* no git/origin — leave clean */
      return [];
    }
  }

  /**
   * Hard-reset the workspace onto origin/<defaultBranch> — "load the latest
   * state from main", DISCARDING every uncommitted live edit (the opposite of
   * reconcile, which refuses to touch a dirty tree). Fetches first, records the
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
