/**
 * ONE-TIME VENDOR STEP — the Netlify/GitBook model: the product owner registers
 * ONE central GitHub App; every user of every instance then only ever sees
 * GitHub's two standard screens (Authorize + install picker).
 *
 *   GITHUB_REPO=<owner>/<repo> pnpm --filter @bpmiq/live-host create-app
 *
 * Opens a tiny local page → one click posts the app manifest to GitHub (org of
 * GITHUB_REPO, editable on GitHub's page) → GitHub redirects back → credentials
 * are exchanged automatically and written to apps/live-host/.env — done,
 * forever. Requires being signed in to GitHub as an org owner.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.GITHUB_REPO;
if (!REPO || !REPO.includes("/")) {
  console.error("GITHUB_REPO must be set to <owner>/<repo> — the app is registered in that owner's org.");
  console.error("Example: GITHUB_REPO=acme/process-docs pnpm --filter @bpmiq/live-host create-app");
  process.exit(1);
}
const OWNER = REPO.split("/")[0] ?? "";
const GH_BASE = (process.env.GITHUB_BASE_URL ?? "https://github.com").replace(/\/$/, "");
const GH_API = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const PUBLIC_URL = process.env.LIVE_PUBLIC_URL ?? "http://localhost:8301";
const PORT = 8302;
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
const state = randomBytes(12).toString("base64url");

const isPublicHost = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(PUBLIC_URL);
const webhookUrl = process.env.LIVE_WEBHOOK_URL ?? (isPublicHost ? `${PUBLIC_URL}/webhook/github` : undefined);

const manifest = JSON.stringify({
  name: "BPM Live",
  url: PUBLIC_URL,
  redirect_url: `http://localhost:${PORT}/callback`,
  callback_urls: [`${PUBLIC_URL}/auth/github/callback`],
  setup_url: `${PUBLIC_URL}/setup/installed`,
  setup_on_update: true,
  request_oauth_on_install: true,
  description: "Live BPM collaboration — releases become pull requests in the name of the releasing user.",
  public: false,
  default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  ...(webhookUrl ? { hook_attributes: { url: webhookUrl, active: false } } : {}),
});

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BPM Live — create the GitHub App</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f8fa}
.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:40px 48px;max-width:560px}
h1 em{color:#fa8100;font-style:normal} p{color:#656d76;font-size:14px;line-height:1.6}
button{background:#fa8100;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer}
code{background:#f6f8fa;padding:1px 5px;border-radius:4px}</style></head><body><div class="card">
<h1><em>BPM</em> Live — create the central GitHub App (one-time)</h1>
<p>This is the vendor step from the Netlify/GitBook model: <strong>one</strong> app,
registered in the <strong>${OWNER}</strong> organization. From then on users only ever see
GitHub's standard screens (sign in + connect repositories).</p>
<p>Prerequisite: you are signed in to GitHub as an owner of the org. Name and details can
still be adjusted on GitHub's page.</p>
<form action="${GH_BASE}/organizations/${encodeURIComponent(OWNER)}/settings/apps/new?state=${state}" method="post">
  <input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}' />
  <button type="submit">Create the app under ${OWNER}</button>
</form>
<p style="font-size:12px">Credentials are written to <code>apps/live-host/.env</code>
automatically — nothing to copy.</p></div></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  if (url.pathname === "/callback") {
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400);
      return res.end("invalid state");
    }
    const code = url.searchParams.get("code");
    const conv = await fetch(`${GH_API}/app-manifests/${encodeURIComponent(code!)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "bpm-live-create-app" },
    });
    if (!conv.ok) {
      res.writeHead(500);
      return res.end(`conversion failed: ${conv.status} ${await conv.text()}`);
    }
    const app = (await conv.json()) as {
      id: number;
      slug: string;
      client_id: string;
      client_secret: string;
      pem: string;
      webhook_secret: string | null;
      html_url: string;
    };
    // GitHub returns pem + webhook_secret EXACTLY ONCE, at conversion time.
    // They are the key to app-JWTs (installation enumeration = the multi-repo
    // overview) and webhook verification — losing them means regenerating
    // keys manually in the app settings (docs/multi-repo-architecture.md).
    writeFileSync(
      ENV_FILE,
      [
        `# BPM Live — central GitHub App (created ${new Date().toISOString().slice(0, 10)} via pnpm create-app)`,
        `GITHUB_CLIENT_ID=${app.client_id}`,
        `GITHUB_CLIENT_SECRET=${app.client_secret}`,
        `GITHUB_APP_SLUG=${app.slug}`,
        `GITHUB_APP_ID=${app.id}`,
        `GITHUB_APP_PRIVATE_KEY_B64=${Buffer.from(app.pem).toString("base64")}`,
        ...(app.webhook_secret ? [`GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`] : []),
        "",
      ].join("\n"),
    );
    console.log(`✓ App "${app.slug}" (id ${app.id}) created — credentials written to ${ENV_FILE}`);
    console.log("  Next step: (re)start the Live Host — pnpm start");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body style="font-family:system-ui;padding:40px"><h1 style="color:#1a7f37">✓ App created</h1>
      <p>Credentials were written to <code>apps/live-host/.env</code>.</p>
      <p><strong>(Re)start the Live Host</strong> (<code>pnpm start</code>) — from then on every user just
      clicks "Sign in with GitHub".</p><p>Manage the app: <a href="${app.html_url}">${app.html_url}</a></p></body></html>`);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log("──────────────────────────────────────────────────");
  console.log("One-time vendor step: create the central GitHub App");
  console.log(`Open in your browser:  http://localhost:${PORT}`);
  console.log(`(registers under org "${OWNER}", writes ${ENV_FILE})`);
  console.log("──────────────────────────────────────────────────");
});
