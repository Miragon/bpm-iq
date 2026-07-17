/**
 * The release upstream-guard fetch must be AUTHENTICATED (src/release.ts):
 * workspaces are cloned with the installation token via env (gitEnv →
 * http.extraHeader, never persisted in .git/config), so release()'s own
 * `git fetch origin <branch>` needs the same env — an anonymous fetch of a
 * private repo dies on a username prompt in the container ("fatal: could not
 * read Username for 'https://github.com'"). Regression: point origin at a
 * local HTTP endpoint and assert git presents the Basic header on the very
 * first request.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runGit } from "../src/adapters/git/run.ts";
import type { Session } from "../src/adapters/sqlite/sessions.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";
import { release } from "../src/release.ts";
import type { ConnectedRepo } from "../src/repos/registry.ts";

const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@test"];

test("release: the upstream-guard fetch carries the installation token", async () => {
  // a "remote" that only records auth headers — git aborts after the 500,
  // which is fine: the assertion is about the FIRST request's credential
  const authHeaders: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // a content-repo workspace whose origin is that endpoint
  const workspace = mkdtempSync(join(tmpdir(), "bpm-release-auth-"));
  mkdirSync(join(workspace, "processes"), { recursive: true });
  writeFileSync(join(workspace, "bpmiq.yml"), "processes: processes\n");
  writeFileSync(join(workspace, "processes", "order.bpmn"), "<v1/>");
  await runGit(["init", "-b", "main", workspace]);
  await runGit(["-C", workspace, "add", "--all"]);
  await runGit(["-C", workspace, ...GIT_ID, "commit", "-m", "initial"]);
  await runGit(["-C", workspace, "remote", "add", "origin", `http://127.0.0.1:${port}/acme/models.git`]);

  const repo: ConnectedRepo = {
    fullName: "acme/models",
    defaultBranch: "main",
    private: true,
    avatarUrl: null,
    installationId: 7,
    suspended: false,
  };
  const session: Session = {
    id: "s1",
    user: { login: "petra", name: "Petra", avatarUrl: null, provider: "github" },
    providerToken: "",
    createdAt: Date.now(),
  };

  try {
    await assert.rejects(
      release(
        {
          workspaces: { ensure: async () => workspace, changedFiles: async () => [] },
          connectionSource: { cloneToken: async () => "inst-tok-123" },
        },
        session,
        { id: "github" } as unknown as GitProvider, // never reached — the fetch fails first
        repo,
        "order",
      ),
    );
  } finally {
    server.close();
  }

  const expected = `Basic ${Buffer.from("x-access-token:inst-tok-123").toString("base64")}`;
  assert.ok(authHeaders.length > 0, "the fetch never reached the remote");
  assert.equal(authHeaders[0], expected, "first fetch request must present the installation token");
});
