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

import { runGit, scrub } from "../adapters/git/run.ts";
import type { ConnectedRepo, RepoRegistry } from "./registry.ts";

/** git env carrying the token as an auth header — not in argv, not in config files */
function gitEnv(token: string | undefined): NodeJS.ProcessEnv {
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
    // Serve the local host content (process-documentation) in place — no clone —
    // when it actually holds process content. In a deployed image without that
    // folder, the host repo is cloned like any other via an installation token.
    return fullName.toLowerCase() === this.hostRepo && existsSync(join(this.hostRoot, "processes"));
  }

  /** git checkout location for a connected repo (clone target; no provisioning) */
  private checkoutDir(repo: ConnectedRepo): string {
    if (this.isHostRepo(repo.fullName)) return this.hostRoot;
    return join(this.dataDir, "workspaces", ...repo.fullName.split("/"));
  }

  /**
   * Content directory for a connected repo (no provisioning). Everything
   * downstream — rooms, process listing, releases — is content-relative.
   */
  dir(repo: ConnectedRepo): string {
    return this.contentRoot(this.checkoutDir(repo));
  }

  /**
   * Where the BPM content lives inside a checkout. Normally the repo root; a
   * monorepo (like bpmiq itself) keeps its content under process-documentation/.
   * Release paths re-derive the git prefix via `git rev-parse --show-prefix`.
   */
  private contentRoot(checkout: string): string {
    if (existsSync(join(checkout, "processes"))) return checkout;
    const nested = join(checkout, "process-documentation");
    if (existsSync(join(nested, "processes"))) return nested;
    return checkout;
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
      return this.contentRoot(dir);
    }

    await mkdir(dirname(dir), { recursive: true });
    console.log(`cloning ${repo.fullName} → ${dir}`);
    try {
      await runGit(["clone", "--branch", repo.defaultBranch, url, dir], { env: gitEnv(token) });
    } catch (e) {
      throw new Error(`clone ${repo.fullName} failed: ${scrub((e as Error).message)}`);
    }
    this.ensured.set(repo.fullName, Date.now());
    return this.contentRoot(dir);
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
    // lineage keys are content-relative — strip the content prefix (monorepo case)
    const content = this.contentRoot(dir);
    const prefix = content === dir ? "" : `${content.slice(dir.length + 1)}/`;
    const changedPaths = changed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l.startsWith(prefix))
      .map((l) => l.slice(prefix.length));
    console.log(
      `reconciled ${repo.fullName}: ${oldHead.trim().slice(0, 7)} → ${newHead.trim().slice(0, 7)} (${changedPaths.length} content file(s))`,
    );
    if (changedPaths.length > 0) this.hooks.onReconciled?.(repo, changedPaths);
  }

  /**
   * Files under `pathspec` in which the working tree differs from
   * origin/<defaultBranch> — the overview's "dirty" signal. Runs in the CONTENT
   * directory (paths come back content-relative, matching room names). Errors
   * (no git, no origin — e.g. the in-place host content) yield [] silently:
   * "not dirty" is the honest answer when there is nothing to diff against.
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
}
