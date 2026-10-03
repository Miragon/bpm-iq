/**
 * Release-as-PR (ADR 0001): worktree → push → open PR. Extracted from api.ts.
 * Two entry points share one publish core:
 *
 *   release(id)          — the classic per-process release: a process is a
 *                          single .bpmn file (repos/content.ts), the release
 *                          publishes the live state of exactly that file.
 *   releaseFiles(body)   — file selection: ship exactly the files the caller
 *                          picked from GET /changes. The workspace is SHARED
 *                          per repo, so selection is the safety mechanism —
 *                          colleagues' in-progress files stay behind unless
 *                          explicitly chosen. Only files that actually differ
 *                          from origin may ship (this gate also rules out
 *                          traversal — git never reports foreign paths), and
 *                          a file deleted in the workspace ships as a delete.
 *
 * A MOVED model (#182) is a delete + add pair in the workspace; both entry
 * points ship such a pair whole (moveUnits), so git records a rename and the
 * default branch never holds the model twice — or not at all.
 *
 * The git + network orchestration is integration-tested by test/release-e2e.sh;
 * the pure sub-logic below (push-token redaction, attribution strings, slugs)
 * is unit-tested in test/release.test.ts.
 *
 * Bot-authored: push + PR run with the app INSTALLATION token, so the PR is opened
 * by the platform bot — which lets the releasing human approve their own release
 * (merge = approval). The commit carries the human as git author (+ Co-authored-by)
 * for attribution. No user token exists anywhere (ADR 0001, completed by ADR 0007):
 * a repository without an app installation cannot be released.
 *
 * Error convention: user-actionable release GATES throw typed AppErrors
 * (http-kit) — the http catch-all maps them to 400/404/409 with their message
 * exposed. Internal failures (missing credential, git push) stay plain
 * Errors → 500, message only for authenticated sessions.
 */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { moveSources, moveUnits, type ReleaseResult } from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";
import { modelStem, processIdFromName } from "@designiq/notations";

import { gitEnv, runGit } from "./adapters/git/run.ts";
import type { Session } from "./adapters/sqlite/sessions.ts";
import { decisionImpact } from "./application/decision-impact.ts";
import { referenceImpact } from "./application/reference-impact.ts";
import type { RepoConnectionSource } from "./ports/connection-source.ts";
import type { GitProvider } from "./ports/git-provider.ts";
import { CONTENT_CONFIG_FILE, type ContentConfig, discoverProcesses, loadContentConfig } from "./repos/content.ts";
import type { ConnectedRepo } from "./repos/registry.ts";
import type { WorkspaceManager } from "./repos/workspaces.ts";

// ── pure helpers (unit-tested in test/release.test.ts) ──────────────────────

/** the release branch for a slug, stamped to the minute */
export function releaseBranch(id: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `release/${id}-${stamp}`;
}

/** the branch slug of a file-selection release: title, else lone file stem, else
 * "changes" — capped so the ref name stays far below the filesystem's NAME_MAX */
export function releaseFilesSlug(files: string[], title?: string): string {
  const cap = (slug: string) => slug.slice(0, 60).replace(/-+$/, "");
  const fromTitle = title ? cap(processIdFromName(title)) : "";
  if (fromTitle) return fromTitle;
  if (files.length === 1) {
    const fromStem = cap(processIdFromName(modelStem(files[0] ?? "")));
    if (fromStem) return fromStem;
  }
  return "changes";
}

/**
 * The file-selection release branch — stamped to the SECOND: unlike process
 * releases (branch keyed by a unique process id), untitled selections share
 * the "changes" slug, so a minute stamp would collide for back-to-back
 * releases from the repo view.
 */
export function releaseFilesBranch(slug: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `release/${slug}-${stamp}`;
}

/** parse `git diff --cached --name-only` output into a clean file list */
export function parseStagedFiles(gitOutput: string): string[] {
  return gitOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** redact a push token a git error might echo, so it never reaches a client */
export function redactToken(message: string, token: string | undefined): string {
  return token ? message.split(token).join("«redacted»") : message;
}

/** the noreply attribution email for a releasing user on a provider */
export function noreplyEmail(login: string, providerId: string): string {
  return `${login}@users.noreply.${providerId}.com`;
}

/** a release commit message: subject + attribution body + Co-authored-by trailer */
export function releaseCommitBody(subject: string, name: string, login: string, email: string): string {
  return (
    `${subject}\n\n` +
    `Released by ${name} (@${login}) from the live workspace.\n\n` +
    `Co-authored-by: ${name} <${email}>`
  );
}

/** the per-process release commit message (subject keyed by the process id) */
export function releaseCommitMessage(id: string, name: string, login: string, email: string): string {
  return releaseCommitBody(`release(${id}): publish live model state`, name, login, email);
}

/** the file-selection release subject — the optional title becomes the headline */
export function releaseFilesSubject(title?: string): string {
  const trimmed = title?.trim() ?? "";
  return trimmed.length > 0 ? `release: ${trimmed}` : "release: publish live model state";
}

/** the PR body — the bot-authored note differs (you can approve your own PR) */
export function releasePrBody(id: string, repoFullName: string, login: string, botAuthored: boolean): string {
  return [
    `Release of **${id}** in \`${repoFullName}\` from the live collaboration workspace, by @${login}.`,
    "",
    botAuthored
      ? "- opened by the bpmiq platform on behalf of the releaser — **you can approve this PR yourself** (merge = approval, CODEOWNERS)"
      : "- merge = approval (CODEOWNERS)",
  ].join("\n");
}

/** the file-selection PR body: the shipped files, then the approval note */
export function releaseFilesPrBody(
  files: Array<{ path: string; deleted: boolean }>,
  repoFullName: string,
  login: string,
  botAuthored: boolean,
): string {
  return [
    `Release from the live collaboration workspace in \`${repoFullName}\`, by @${login}.`,
    "",
    ...files.map((f) => `- \`${f.path}\`${f.deleted ? " (deleted)" : ""}`),
    "",
    botAuthored
      ? "- opened by the bpmiq platform on behalf of the releaser — **you can approve this PR yourself** (merge = approval, CODEOWNERS)"
      : "- merge = approval (CODEOWNERS)",
  ].join("\n");
}

// ── orchestration (integration-tested by test/release-e2e.sh) ───────────────

/** the subset of ApiOptions release() needs — keeps the dep one-way (api → release) */
export interface ReleaseDeps {
  workspaces: Pick<WorkspaceManager, "ensure" | "changedFiles"> &
    // optional: without fileAtCommit a release simply ships without its
    // decision-impact section; without the catch-up trio (#185) the upstream
    // guard alone protects foreign work (tests and in-process fakes)
    Partial<Pick<WorkspaceManager, "fileAtCommit" | "reconcile" | "conflicts" | "markReleased">>;
  /** REST backend for the app installation clone token (bot-authored release) */
  connectionSource?: Pick<RepoConnectionSource, "cloneToken">;
}

interface ReleaseFileEntry {
  /** repo-root-relative path */
  path: string;
  /** deleted in the workspace — ships as a `git rm` */
  deleted: boolean;
}

interface PublishArgs {
  branch: string;
  files: ReleaseFileEntry[];
  /** commit subject line; attribution body is appended with the session user */
  subject: string;
  prTitle: string;
  /** rendered AFTER staging — `staged` is what the commit actually ships */
  prBody: (botAuthored: boolean, staged: string[]) => string | Promise<string>;
}

/**
 * The shared worktree → push → PR core: fetch origin and catch the workspace
 * up with it, guard against silently reverting upstream changes (per file),
 * stage exactly `files` on a fresh branch off origin/<default>, commit with
 * human attribution, push, open the PR bot-authored when possible, and mark
 * the shipped state in the workspace (#185) — once the PR merges, what it
 * shipped is no longer a change.
 */
async function publish(
  opts: ReleaseDeps,
  session: Session,
  provider: GitProvider,
  repo: ConnectedRepo,
  workspace: string,
  args: PublishArgs,
): Promise<ReleaseResult> {
  // the credential for the whole release: fetch, push, PR — the app
  // installation token (bot-authored → the human can approve their own release)
  const instToken =
    repo.installationId !== null
      ? await opts.connectionSource?.cloneToken(repo.installationId).catch(() => undefined)
      : undefined;
  const worktree = await mkdtemp(join(tmpdir(), "bpm-release-"));
  try {
    // authenticated like every WorkspaceManager fetch (gitEnv → http.extraHeader):
    // an anonymous fetch of a PRIVATE repo has no credential and no TTY in the
    // container — git dies on "could not read Username for 'https://github.com'"
    await runGit(["-C", workspace, "fetch", "origin", repo.defaultBranch], {
      env: gitEnv(instToken),
    });
    // absorb what the default branch gained since the last catch-up — a
    // release merged seconds ago must not read as an upstream change of its
    // own files. A failed catch-up leaves HEAD behind: the guard below still holds.
    await opts.workspaces.reconcile?.(repo).catch((e: unknown) => {
      console.log(`release ${repo.fullName}: catch-up failed (${(e as Error).message.split("\n")[0]})`);
    });

    // conflict guard: files changed upstream while the workspace held
    // unreleased edits of them — the catch-up kept the local version
    const conflicted = new Set((await opts.workspaces.conflicts?.(repo)) ?? []);
    const blocked = args.files.filter((f) => conflicted.has(f.path)).map((f) => f.path);
    if (blocked.length > 0) {
      throw new AppError(
        "release/conflict",
        `Diese Dateien wurden upstream geändert, während sie hier noch unveröffentlichte Änderungen hatten:\n` +
          `${blocked.join("\n")}\n` +
          `Ein Release jetzt würde die Änderungen auf ${repo.defaultBranch} still zurückdrehen. Konflikt zuerst ` +
          `auflösen (Version von ${repo.defaultBranch} übernehmen oder die eigene bewusst behalten), danach erneut releasen.`,
        { status: 409, expose: true },
      );
    }

    // upstream guard: commits on origin touching a selected file that this
    // workspace has never absorbed would be silently REVERTED by the copy below
    // (the catch-up was deferred — a changed file is open in an editor — or
    // this is the in-place host checkout, which never catches up)
    const conflicts: string[] = [];
    for (const file of args.files) {
      const { stdout: upstream } = await runGit([
        "-C",
        workspace,
        "log",
        "--oneline",
        `HEAD..origin/${repo.defaultBranch}`,
        "--",
        file.path,
      ]);
      if (upstream.trim().length > 0) conflicts.push(`${file.path}:\n${upstream.trim()}`);
    }
    if (conflicts.length > 0) {
      throw new AppError(
        "release/upstream-changed",
        `Diese Dateien wurden upstream geändert, seit dieser Workspace zuletzt synchronisiert wurde:\n` +
          `${conflicts.join("\n")}\n` +
          `Ein Release jetzt würde diese Änderungen still zurückdrehen. Der Workspace übernimmt sie automatisch, ` +
          `sobald keine davon betroffene Datei mehr im Editor geöffnet ist — danach erneut releasen.`,
        { status: 409, expose: true },
      );
    }

    await runGit(["-C", workspace, "worktree", "add", "-b", args.branch, worktree, `origin/${repo.defaultBranch}`]);

    for (const file of args.files) {
      if (file.deleted) {
        // deleted in the workspace — ship the deletion (tracked on origin by definition)
        await runGit(["-C", worktree, "rm", "-q", "--ignore-unmatch", "--", file.path]);
      } else {
        // a brand-new file may not exist on origin yet — create its folder
        await mkdir(dirname(join(worktree, file.path)), { recursive: true });
        await cp(join(workspace, file.path), join(worktree, file.path));
        await runGit(["-C", worktree, "add", "--", file.path]);
      }
    }
    const { stdout: staged } = await runGit(["-C", worktree, "diff", "--cached", "--name-only"]);
    const stagedFiles = parseStagedFiles(staged);
    if (stagedFiles.length === 0) {
      throw new AppError(
        "release/nothing-to-release",
        `nothing to release: live state equals origin/${repo.defaultBranch}`,
        {
          status: 409,
          expose: true,
        },
      );
    }

    const releaseToken = instToken ?? "";
    const botAuthored = Boolean(instToken);
    if (!releaseToken && !process.env.LIVE_PUSH_URL_OVERRIDE) {
      throw new Error(`no app installation token for ${repo.fullName} — releases need the GitHub App connection`);
    }

    const email = noreplyEmail(session.user.login, provider.id);
    await runGit([
      "-C",
      worktree,
      "-c",
      `user.name=${session.user.name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "--author",
      `${session.user.name} <${email}>`, // attribution: the human authored it
      "-m",
      releaseCommitBody(args.subject, session.user.name, session.user.login, email),
    ]);
    // LIVE_PUSH_URL_OVERRIDE: test/offline escape hatch (stub provider + local bare repo).
    const pushUrl = process.env.LIVE_PUSH_URL_OVERRIDE ?? provider.pushUrl(releaseToken, repo.fullName);
    try {
      await runGit(["-C", worktree, "push", pushUrl, `${args.branch}:${args.branch}`]);
    } catch (e) {
      // the push URL carries a token — it must never reach the client in a 500
      throw new Error(`push failed: ${redactToken((e as Error).message, releaseToken)}`);
    }
    const pr = await provider.createPullRequest(releaseToken, repo.fullName, {
      branch: args.branch,
      base: repo.defaultBranch,
      title: args.prTitle,
      body: await args.prBody(botAuthored, stagedFiles),
    });
    // the PR exists — a failed mark must not fail the release; the only cost is
    // a false conflict on this file once the PR merges (never a silent revert)
    const { stdout: commit } = await runGit(["-C", worktree, "rev-parse", "HEAD"]);
    await opts.workspaces
      .markReleased?.(
        repo,
        commit.trim(),
        args.files.map((f) => f.path),
      )
      .catch((e: unknown) => {
        console.log(
          `release ${repo.fullName}: marking the shipped state failed (${(e as Error).message.split("\n")[0]})`,
        );
      });
    return {
      pr: pr.url,
      branch: args.branch,
      by: session.user.login,
      repo: repo.fullName,
      botAuthored,
      files: stagedFiles,
    };
  } finally {
    await runGit(["-C", workspace, "worktree", "remove", "--force", worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await runGit(["-C", workspace, "branch", "-D", args.branch]).catch(() => undefined);
  }
}

function requireContentRepo(repo: ConnectedRepo, workspace: string): ContentConfig {
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "release/not-a-content-repo",
      `${repo.fullName} has no ${CONTENT_CONFIG_FILE} — not a BPM content repo`,
      { status: 404, expose: true },
    );
  }
  return cfg;
}

/** the classic per-process release: publish exactly the process's .bpmn file */
export async function release(
  opts: ReleaseDeps,
  session: Session,
  provider: GitProvider,
  repo: ConnectedRepo,
  id: string,
  now: Date = new Date(),
): Promise<ReleaseResult> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = requireContentRepo(repo, workspace);
  const proc = (await discoverProcesses(workspace, cfg)).find((p) => p.id === id);
  if (!proc) {
    throw new AppError("release/unknown-process", `unknown process: ${id} (${repo.fullName})`, {
      status: 404,
      expose: true,
    });
  }
  // the released artifact is exactly this repo-root-relative file — or, for a
  // moved process, the whole move (the new file AND the old one's deletion)
  const changed = await opts.workspaces.changedFiles(repo, cfg.processes);
  const deleted = new Set(changed.filter((c) => c.status === "deleted").map((c) => c.path));
  const paths = moveUnits(changed).get(proc.path) ?? [proc.path];
  return publish(opts, session, provider, repo, workspace, {
    branch: releaseBranch(id, now),
    files: paths.map((path) => ({ path, deleted: deleted.has(path) })),
    subject: `release(${id}): publish live model state`,
    prTitle: `release(${id}): publish live model state`,
    prBody: async (botAuthored, staged) =>
      releasePrBody(id, repo.fullName, session.user.login, botAuthored) +
      (await decisionImpact(opts, repo, workspace, staged, moveSources(changed))) +
      (await referenceImpact(workspace, staged)),
  });
}

/** hard cap on one release's selection — far above any real content repo's churn */
const MAX_RELEASE_FILES = 200;

/**
 * File-selection release: ship exactly the selected files. The single gate is
 * "the file is currently changed vs origin" (GET /changes) — that refuses
 * no-op selections AND foreign paths in one check, since git only ever reports
 * repo-relative content paths.
 */
export async function releaseFiles(
  opts: ReleaseDeps,
  session: Session,
  provider: GitProvider,
  repo: ConnectedRepo,
  body: { files: string[]; title?: string },
  now: Date = new Date(),
): Promise<ReleaseResult> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = requireContentRepo(repo, workspace);
  const requested = [...new Set(body.files.map((f) => f.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new AppError("release/no-files", "select at least one changed file to release", {
      status: 400,
      expose: true,
    });
  }
  if (requested.length > MAX_RELEASE_FILES) {
    throw new AppError("release/too-many-files", `a release ships at most ${MAX_RELEASE_FILES} files`, {
      status: 400,
      expose: true,
    });
  }
  // the pool is confined to the bpmiq.yml content scope, like GET /changes
  const pool = await opts.workspaces.changedFiles(repo, cfg.processes);
  const changed = new Map(pool.map((c) => [c.path, c.status]));
  const unknown = requested.filter((f) => !changed.has(f));
  if (unknown.length > 0) {
    throw new AppError(
      "release/not-changed",
      `not changed vs origin/${repo.defaultBranch} (nothing to release): ${unknown.join(", ")}`,
      { status: 409, expose: true },
    );
  }
  // a selected half of a move brings the other half along
  const units = moveUnits(pool);
  const shipped = [...new Set(requested.flatMap((path) => units.get(path) ?? [path]))];
  const files = shipped.map((path) => ({ path, deleted: changed.get(path) === "deleted" }));
  return publish(opts, session, provider, repo, workspace, {
    branch: releaseFilesBranch(releaseFilesSlug(requested, body.title), now),
    files,
    subject: releaseFilesSubject(body.title),
    prTitle: releaseFilesSubject(body.title),
    // list what the commit actually ships — a file that healed to the origin
    // state between the gate and the staging must not be advertised
    prBody: async (botAuthored, staged) =>
      releaseFilesPrBody(
        files.filter((f) => staged.includes(f.path)),
        repo.fullName,
        session.user.login,
        botAuthored,
      ) +
      // a moved decision is compared against its old path, not reported new
      (await decisionImpact(opts, repo, workspace, staged, moveSources(pool))) +
      (await referenceImpact(workspace, staged)),
  });
}
