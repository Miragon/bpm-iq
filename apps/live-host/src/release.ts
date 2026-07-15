/**
 * Release-as-PR (ADR 0001): validate → worktree → push → open PR. Extracted from
 * api.ts. The git + network orchestration is integration-tested by
 * test/release-e2e.sh; the pure governance/security sub-logic below (version-bump
 * gate, model-change detection, push-token redaction, attribution strings) is
 * unit-tested in test/release.test.ts.
 *
 * Bot-authored: push + PR run with the app INSTALLATION token, so the PR is opened
 * by the platform bot — which lets the releasing human approve their own release
 * (merge = approval). The commit carries the human as git author (+ Co-authored-by)
 * for attribution. No user token is needed, so a handoff/cell session (zero stored
 * user token) can release too; it falls back to the user token only in legacy
 * OAuth-only mode (no app installation token).
 *
 * Error convention: user-actionable release GATES throw typed AppErrors
 * (http-kit) — the http catch-all maps them to 404/409/422 with their message
 * exposed. Internal failures (validator run, missing credential, git push)
 * stay plain Errors → 500, message only for authenticated sessions.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ReleaseResult } from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";
import { parse as parseYaml } from "yaml";

import { runGit } from "./adapters/git/run.ts";
import type { Session } from "./adapters/sqlite/sessions.ts";
import type { RepoConnectionSource } from "./ports/connection-source.ts";
import type { GitProvider } from "./ports/git-provider.ts";
import type { ConnectedRepo } from "./repos/registry.ts";
import type { WorkspaceManager } from "./repos/workspaces.ts";

// ONLY the platform validator run — every git call goes through adapters/git/run.ts
const exec = promisify(execFile);

// ── pure helpers (unit-tested in test/release.test.ts) ──────────────────────

/** extensions whose change requires a version bump (governance Hard Rule 5) */
const MODEL_RE = /\.(bpmn|dmn|owm|tt|vc\.json)$/;

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

/** does any staged file touch a model (vs. only docs / metadata)? */
export function hasModelChange(files: string[]): boolean {
  return files.some((f) => MODEL_RE.test(f));
}

/** governance gate: a model change must carry a version bump (Hard Rule 5) */
export function needsVersionBump(modelChanged: boolean, baseVersion: unknown, newVersion: unknown): boolean {
  return modelChanged && baseVersion !== undefined && String(newVersion) === String(baseVersion);
}

/** redact a push token a git error might echo, so it never reaches a client */
export function redactToken(message: string, token: string | undefined): string {
  return token ? message.split(token).join("«redacted»") : message;
}

/** keep only the validator's "[...]" finding lines from its stdout */
export function validatorFindings(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("["))
    .join("\n");
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
    "- validated with the platform validator before this PR was created",
    botAuthored
      ? "- opened by the bpmiq platform on behalf of the releaser — **you can approve this PR yourself** (merge = approval, CODEOWNERS)"
      : "- merge = approval (CODEOWNERS)",
    "- the pipeline validates again and redeploys portal + MCP",
  ].join("\n");
}

// ── orchestration (integration-tested by test/release-e2e.sh) ───────────────

/** the subset of ApiOptions release() needs — keeps the dep one-way (api → release) */
export interface ReleaseDeps {
  workspaces: Pick<WorkspaceManager, "ensure">;
  /** platform validator entry (packages/validator) — runs against any checkout */
  validatorScript: string;
  /** validator package dir (cwd so its own deps resolve) */
  validatorDir: string;
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
  const processDir = join(workspace, "processes", id);
  if (!existsSync(processDir)) {
    throw new AppError("release/unknown-process", `unknown process: ${id} (${repo.fullName})`, {
      status: 404,
      expose: true,
    });
  }

  // where the content lives inside the git checkout: "" for plain content repos,
  // "process-documentation/" when the workspace is a monorepo subdirectory —
  // without this the PR would create a bogus top-level processes/ tree
  const { stdout: prefixRaw } = await runGit(["-C", workspace, "rev-parse", "--show-prefix"]);
  const prefix = prefixRaw.trim();
  const relProcess = `${prefix}processes/${id}`;

  try {
    // the PLATFORM's validator (packages/validator), target checkout as data — never repo code
    await exec("node", [opts.validatorScript, "--root", workspace, id], { cwd: opts.validatorDir });
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? "";
    throw new Error(`validation failed:\n${validatorFindings(out)}`);
  }

  const branch = releaseBranch(id, now);
  const worktree = await mkdtemp(join(tmpdir(), "bpm-release-"));
  try {
    await runGit(["-C", workspace, "fetch", "origin", repo.defaultBranch]);

    // upstream guard: commits on origin touching this process that this workspace
    // has never absorbed would be silently REVERTED by the copy below
    const { stdout: upstream } = await runGit([
      "-C",
      workspace,
      "log",
      "--oneline",
      `HEAD..origin/${repo.defaultBranch}`,
      "--",
      relProcess,
    ]);
    if (upstream.trim().length > 0) {
      throw new AppError(
        "release/upstream-changed",
        `processes/${id} wurde upstream geändert, seit dieser Workspace zuletzt synchronisiert wurde:\n${upstream.trim()}\n` +
          `Ein Release jetzt würde diese Änderungen still zurückdrehen. Der Workspace gleicht sich automatisch ab, ` +
          `sobald keine Live-Sessions offen sind — danach erneut releasen.`,
        { status: 409, expose: true },
      );
    }

    await runGit(["-C", workspace, "worktree", "add", "-b", branch, worktree, `origin/${repo.defaultBranch}`]);

    // governance gate (Hard Rule 5): a semantic model change requires a version bump
    const baseYaml = join(worktree, relProcess, "process.yaml");
    const baseVersion = existsSync(baseYaml) ? parseYaml(await readFile(baseYaml, "utf8"))?.version : undefined;

    await rm(join(worktree, relProcess), { recursive: true, force: true });
    await cp(processDir, join(worktree, relProcess), { recursive: true });
    await runGit(["-C", worktree, "add", "--all", relProcess]);
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

    const newVersion = parseYaml(await readFile(join(processDir, "process.yaml"), "utf8"))?.version;
    if (needsVersionBump(hasModelChange(stagedFiles), baseVersion, newVersion)) {
      throw new AppError(
        "release/version-bump-required",
        `Modelländerung ohne Versions-Bump: version ist weiterhin '${newVersion}'. ` +
          `Bitte version erhöhen und einen history-Eintrag ergänzen (docs/governance.md), dann erneut releasen.`,
        { status: 422, expose: true },
      );
    }

    // the credential that pushes + opens the PR. Prefer the app installation token
    // (bot-authored → the human can approve their own release); fall back to the
    // user token only when there is no app installation.
    const instToken =
      repo.installationId !== null
        ? await opts.connectionSource?.cloneToken(repo.installationId).catch(() => undefined)
        : undefined;
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
