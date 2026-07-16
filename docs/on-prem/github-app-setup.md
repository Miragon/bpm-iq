# GitHub App setup

The platform runs against **your own GitHub App, registered in your own organization**. The
app is what makes the on-prem model work: users sign in through it (OAuth), repositories
are connected by installing it, per-(user,repo) write permission is checked with its
installation tokens, and release PRs are authored by its bot — the server stores zero user
tokens ([ADR 0001](../adr/0001-zero-stored-user-tokens.md)). Your users only ever see
GitHub's two standard screens: sign in + the install picker.

Two ways to register the app: guided (recommended — one click, no copying from GitHub's UI)
or manual. Both end with the same set of values in your deployment's `.env`
([configuration.md](configuration.md)).

## Path A — guided (`create-app`)

Runs from a source checkout of this repo (Node ≥ 23.6 + pnpm, `pnpm install` once). It
drives GitHub's [app-manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
you click one button, GitHub creates the app and returns the credentials — including the
private key and webhook secret, which GitHub hands out **exactly once, at this moment**.

```bash
LIVE_PUBLIC_URL=https://bpm.example.com \
GITHUB_REPO=<owner>/<repo> \
pnpm --filter @bpmiq/live-host create-app
```

Set `LIVE_PUBLIC_URL` to the deployment's public URL **before** running — the callback,
setup, and webhook URLs are baked into the manifest from it (they can be edited later in
the app settings, but starting correct is easier). `GITHUB_REPO` names the org the app is
registered under. For GitHub Enterprise, also export `GITHUB_BASE_URL`/`GITHUB_API_URL`.

Then:

1. Open `http://localhost:8302`, signed in to GitHub as an **owner of the org**.
2. One click posts the manifest; GitHub shows its create-app page (name and details still
   editable there); confirm.
3. GitHub redirects back, the tool exchanges the temporary code and writes
   `apps/live-host/.env`:

   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   GITHUB_APP_SLUG=...
   GITHUB_APP_ID=...
   GITHUB_APP_PRIVATE_KEY_B64=...   # the PEM, base64 — returned exactly once
   GITHUB_WEBHOOK_SECRET=...        # returned exactly once
   ```

4. **Transfer these values into your deployment's `.env`** (`deploy/.env` for the compose
   setup) — the file on the machine that ran the tool is just the drop point. Treat the
   private key and secrets accordingly; losing them means regenerating keys in the app
   settings.
5. The manifest registers the webhook **inactive**. Once the deployment is reachable,
   activate it: app settings → Webhook → check _Active_ (URL
   `https://<host>/webhook/github`, secret already set). See
   [Webhooks](#what-the-webhook-does) below for what you get.

## Path B — manual

Org → **Settings → Developer settings → GitHub Apps → New GitHub App** (these values
mirror the manifest in
[`apps/live-host/src/tools/create-app.ts`](../../apps/live-host/src/tools/create-app.ts)):

| Field                                                      | Value                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Name / Homepage URL                                        | e.g. `BPM Live` / `https://<host>`                                                                                         |
| Callback URL                                               | `https://<host>/auth/github/callback`                                                                                      |
| **Request user authorization (OAuth) during installation** | **checked** — installing and logging in become one flow                                                                    |
| Setup URL                                                  | `https://<host>/setup/installed`, with **Redirect on update** checked                                                      |
| Webhook                                                    | Active, URL `https://<host>/webhook/github`, generate + note a webhook secret                                              |
| Repository permissions                                     | **Contents: Read and write** · **Pull requests: Read and write** · **Issues: Read and write** · Metadata: Read (mandatory) |
| Subscribe to events                                        | Installation target events suffice — the server reacts to `installation` and `installation_repositories`                   |
| Where can this app be installed?                           | _Only on this account_ (the app stays private to your org)                                                                 |

> **Apps registered before the todo feature:** add **Issues: Read and write** in the app's
> permission settings. GitHub then asks each org that already installed the app to **approve
> the added permission** (the org owner gets a prompt/notification) — todos return a clear
> 403 until that approval happens. Contents/pull-requests features are unaffected.

After creation:

1. Note the **App ID** and the **slug** (the URL name: `github.com/apps/<slug>`).
2. **Generate a client secret** (OAuth credentials section).
3. **Generate a private key** — downloads a `.pem`.
4. Fill the deployment's `.env`: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, and the key via one of
   `GITHUB_APP_PRIVATE_KEY` (raw PEM), `GITHUB_APP_PRIVATE_KEY_FILE` (mounted file), or
   `GITHUB_APP_PRIVATE_KEY_B64` (`base64 -w0 app.pem`) — precedence in
   [configuration.md](configuration.md#github-app-mode-recommended-on-prem).

## First run

Start (or restart) the Live Host with the new values. Then install the app: app settings →
**Install App** → choose the org and select your content repositories — or just click
**Sign in with GitHub** in the web app and follow the connect flow; the install picker link
comes from `GITHUB_APP_SLUG`. Every selected repo appears in the overview for users with
write permission on it; connecting more repos later is the same picker, no server change.

## What the webhook does

`POST /webhook/github` is verified with `GITHUB_WEBHOOK_SECRET` (HMAC SHA-256, fail
closed: unverifiable requests are refused). `installation` and `installation_repositories`
events resync the connected-repo set, so adding/removing repos on GitHub shows up without
user action. It is a freshness mechanism, not a correctness requirement: the post-install
redirect (`/setup/installed`) triggers the same sync when a user connects a repo, and
workspace checkouts fetch upstream on access (at most every 60 s) — so a localhost
evaluation without a reachable webhook still works.

## Key rotation and loss

GitHub returns the private key and webhook secret only at creation time. If either is lost
or must be rotated: app settings → generate a new private key / webhook secret / client
secret, update the deployment's `.env`, restart. Old private keys keep working until
revoked, so rotation is zero-downtime.
