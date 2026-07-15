/**
 * RepoConnectionSource (GitHub App source) — the platform-credentialed seam.
 * Runs the REAL createGitHubAppSource against the offline stub provider, so the
 * cell tenant-filter (ADR 0002) and webhook verification are exercised end to
 * end without GitHub. A throwaway RSA key signs the app JWT (the stub does not
 * verify it, but node:crypto must sign with a valid key).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AppCredentials } from "../src/adapters/github/app-auth.ts";
import { createGitHubAppSource } from "../src/adapters/github/app-source.ts";
import { localMintFn, TokenService } from "../src/repos/token-minter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_PORT = Number(process.env.CS_STUB_PORT ?? 8521);
const STUB_URL = `http://localhost:${STUB_PORT}`;
const WEBHOOK_SECRET = "stub-webhook-secret";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const creds: AppCredentials = { appId: "4711", privateKey: pem, apiUrl: STUB_URL };
/** local minter using the app JWT against the stub */
const tokens = () => new TokenService(localMintFn(creds));
/** default source args (LOCAL mode) */
const src = (over: Record<string, unknown> = {}) =>
  createGitHubAppSource({ apiUrl: STUB_URL, tokens: tokens(), creds, baseUrl: STUB_URL, ...over });

let stub: ChildProcess;
async function control(body: unknown): Promise<void> {
  const res = await fetch(`${STUB_URL}/_control`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`_control failed: ${res.status}`);
}

before(async () => {
  stub = spawn(process.execPath, [join(HERE, "stub-provider.ts")], {
    env: { ...process.env, STUB_PORT: String(STUB_PORT) },
    stdio: "ignore",
  });
  // wait for readiness
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${STUB_URL}/_control`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // two tenants: installation 1 (acme) and installation 2 (globex)
  await control({ setInstallation: { id: 1, repos: ["acme/processes"], account: "acme" } });
  await control({ setInstallation: { id: 2, repos: ["globex/ops", "globex/hr"], account: "globex" } });
});

after(() => {
  stub?.kill();
});

test("multi-tenant mode enumerates ALL installations", async () => {
  const source = src({ appSlug: "bpm-live" });
  const snap = await source.listConnectedRepos();
  const names = snap.repos.map((r) => r.fullName).sort();
  assert.deepEqual(names, ["acme/processes", "globex/hr", "globex/ops"]);
  assert.deepEqual([...snap.knownRefs].sort(), [1, 2]);
  assert.deepEqual([...snap.enumeratedRefs].sort(), [1, 2]);
});

test("cell mode (tenantInstallationId) sees ONLY that tenant's repos", async () => {
  const source = src({ appSlug: "bpm-live", tenantInstallationId: 2 });
  const snap = await source.listConnectedRepos();
  assert.deepEqual(snap.repos.map((r) => r.fullName).sort(), ["globex/hr", "globex/ops"]);
  assert.deepEqual([...snap.knownRefs], [2], "cell must not even know other installations exist");
  assert.ok(snap.repos.every((r) => r.connectionRef === 2));
});

test("cell mode with an unknown installation fails loudly (not silently empty)", async () => {
  const source = src({ tenantInstallationId: 999 });
  await assert.rejects(() => source.listConnectedRepos(), /installation 999 → 404/);
});

test("cloneToken is installation-scoped", async () => {
  const source = src({ tenantInstallationId: 2 });
  const token = await source.cloneToken(2);
  assert.equal(token, "stub-installation-token-2");
  assert.equal(await source.cloneToken(null), undefined);
});

test("webhook verification: valid HMAC authentic, bad signature rejected, no secret => undefined", () => {
  const withSecret = src({ webhookSecret: WEBHOOK_SECRET });
  const body = Buffer.from(JSON.stringify({ action: "created" }));
  const good = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

  const ok = withSecret.verifyWebhook({ "x-hub-signature-256": good, "x-github-event": "installation" }, body);
  assert.equal(ok?.authentic, true);
  assert.equal(ok?.membershipChanged, true);

  const bad = withSecret.verifyWebhook(
    { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "installation" },
    body,
  );
  assert.equal(bad?.authentic, false);

  const nonMembership = withSecret.verifyWebhook({ "x-hub-signature-256": good, "x-github-event": "push" }, body);
  assert.equal(nonMembership?.membershipChanged, false);

  const noSecret = src();
  assert.equal(noSecret.verifyWebhook({ "x-github-event": "installation" }, body), undefined);
});
