/**
 * Release-as-PR (ADR 0001): worktree → push → open PR. Extracted from api.ts.
 * A process is a single .bpmn file under the repo's bpmiq.yml processes folder
 * (repos/content.ts) — the release publishes the live state of exactly that
 * file. The git + network orchestration is integration-tested by
 * test/release-e2e.sh; the pure sub-logic below (push-token redaction,
 * attribution strings) is unit-tested in test/release.test.ts.
 *
 * Bot-authored: push + PR run with the app INSTALLATION token, so the PR is opened
 * by the platform bot — which lets the releasing human approve their own release
 * (merge = approval). The commit carries the human as git author (+ Co-authored-by)
 * for attribution. No user token is needed, so a handoff/cell session (zero stored
 * user token) can release too; it falls back to the user token only in legacy
 * OAuth-only mode (no app installation token).
 *
 * Error convention: user-actionable release GATES throw typed AppErrors
 * (http-kit) — the http catch-all maps them to 404/409 with their message
 * exposed. Internal failures (missing credential, git push) stay plain
 * Errors → 500, message only for authenticated sessions.
 */
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ReleaseResult } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";

import { gitEnv, runGit } from "./adapters/git/run.ts";
import type { Session } from "./adapters/sqlite/sessions.ts";
import type { RepoConnectionSource } from "./ports/connection-source.ts";
import type { GitProvider } from "./ports/git-provider.ts";
import { CONTENT_CONFIG_FILE, discoverProcesses, loadContentConfig } from "./repos/content.ts";
import type { ConnectedRepo } from "./repos/registry.ts";
import type { WorkspaceManager } from "./repos/workspaces.ts";

// ── pure helpers (unit-tested in test/release.test.ts) ──────────────────────

/** the release branch for a process, stamped to the minute */
export function releaseBranch(id: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `release/${id}-${stamp}`;
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

/** the release commit message: subject + attribution body + Co-authored-by trailer */
export function releaseCommitMessage(id: string, name: string, login: string, email: string): string {
  return (
    `release(${id}): publish live model state\n\n` +
    `Released by ${name} (@${login}) from the live workspace.\n\n` +
    `Co-authored-by: ${name} <${email}>`
  );
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

// ── orchestration (integration-tested by test/release-e2e.sh) ───────────────

/** the subset of ApiOptions release() needs — keeps the dep one-way (api → release) */
export interface ReleaseDeps {
  workspaces: Pick<WorkspaceManager, "ensure">;
  /** REST backend for the app installation clone token (bot-authored release) */
  connectionSource?: Pick<RepoConnectionSource, "cloneToken">;
}

export async function release(
  opts: ReleaseDeps,
  session: Session,
  provider: GitProvider,
  repo: ConnectedRepo,
  id: string,
  now: Date = new Date(),
): Promise<ReleaseResult> {
  const workspace = await opts.workspaces.ensure(repo);
  const cfg = loadContentConfig(workspace);
  if (!cfg) {
    throw new AppError(
      "release/not-a-content-repo",
      `${repo.fullName} has no ${CONTENT_CONFIG_FILE} — not a BPM content repo`,
      { status: 404, expose: true },
    );
  }
  const proc = (await discoverProcesses(workspace, cfg)).find((p) => p.id === id);
  if (!proc) {
    throw new AppError("release/unknown-process", `unknown process: ${id} (${repo.fullName})`, {
      status: 404,
      expose: true,
    });
  }
  // the released artifact is exactly this repo-root-relative file
  const relFile = proc.path;

  const branch = releaseBranch(id, now);
  // the credential for the whole release: fetch, push, PR. Prefer the app
  // installation token (bot-authored → the human can approve their own
  // release); fall back to the user token only when there is no installation.
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
      env: gitEnv(instToken ?? (session.providerToken || undefined)),
    });

    // upstream guard: commits on origin touching this file that this workspace
    // has never absorbed would be silently REVERTED by the copy below
    const { stdout: upstream } = await runGit([
      "-C",
      workspace,
      "log",
      "--oneline",
      `HEAD..origin/${repo.defaultBranch}`,
      "--",
      relFile,
    ]);
    if (upstream.trim().length > 0) {
      throw new AppError(
        "release/upstream-changed",
        `${relFile} wurde upstream geändert, seit dieser Workspace zuletzt synchronisiert wurde:\n${upstream.trim()}\n` +
          `Ein Release jetzt würde diese Änderungen still zurückdrehen. Der Workspace gleicht sich automatisch ab, ` +
          `sobald keine Live-Sessions offen sind — danach erneut releasen.`,
        { status: 409, expose: true },
      );
    }

    await runGit(["-C", workspace, "worktree", "add", "-b", branch, worktree, `origin/${repo.defaultBranch}`]);

    // a brand-new process file may not exist on origin yet — create its folder
    await mkdir(dirname(join(worktree, relFile)), { recursive: true });
    await cp(join(workspace, relFile), join(worktree, relFile));
    await runGit(["-C", worktree, "add", "--", relFile]);
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

    const releaseToken = instToken ?? session.providerToken;
    const botAuthored = Boolean(instToken);
    if (!releaseToken && !process.env.LIVE_PUSH_URL_OVERRIDE) {
      throw new Error("no credential available to publish the release (no app installation token, no user token)");
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
      releaseCommitMessage(id, session.user.name, session.user.login, email),
    ]);
    // LIVE_PUSH_URL_OVERRIDE: test/offline escape hatch (stub provider + local bare repo).
    const pushUrl = process.env.LIVE_PUSH_URL_OVERRIDE ?? provider.pushUrl(releaseToken, repo.fullName);
    try {
      await runGit(["-C", worktree, "push", pushUrl, `${branch}:${branch}`]);
    } catch (e) {
      // the push URL carries a token — it must never reach the client in a 500
      throw new Error(`push failed: ${redactToken((e as Error).message, releaseToken)}`);
    }
    const pr = await provider.createPullRequest(releaseToken, repo.fullName, {
      branch,
      base: repo.defaultBranch,
      title: `release(${id}): publish live model state`,
      body: releasePrBody(id, repo.fullName, session.user.login, botAuthored),
    });
    return { pr: pr.url, branch, by: session.user.login, repo: repo.fullName, botAuthored };
  } finally {
    await runGit(["-C", workspace, "worktree", "remove", "--force", worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await runGit(["-C", workspace, "branch", "-D", branch]).catch(() => undefined);
  }
}
