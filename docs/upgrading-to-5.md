# Upgrading to 5.0 — the rename to designIQ

5.0 renames the product to **designIQ** (repository
[Miragon/design-iq](https://github.com/Miragon/design-iq)); the server keeps its name, the
**Live Host**, and its `LIVE_*` variables. Your data stays where it is: live documents,
workspaces, content repos, todos and BPMN files with sticky notes are read as before. What
changes are the names the platform publishes and writes. Rationale:
[ADR 0008](adr/0008-rename-to-designiq.md).

## Order

1. Bring every Live Host, CI validator and read-only MCP server that works on the same
   repositories to **4.3.1 or later** first — 4.3.x already reads the contract file and the
   todo wording 5.0 writes. A host that shares its repositories with no other host can go
   from any 4.x straight to 5.0.
2. Upgrade to 5.0 (below).
3. Only then rename contract files in your content repos ([Content repos](#content-repos-designiqyml)).

## Container image

|                            | 4.x                                                       | 5.0                                                                                                 |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| image                      | `ghcr.io/miragon/bpmiq-live-host` <!-- legacy-name-ok --> | `ghcr.io/miragon/designiq-live-host`                                                                |
| version variable (compose) | `BPMIQ_VERSION` <!-- legacy-name-ok -->                   | `DESIGNIQ_VERSION` (`BPMIQ_VERSION` is still read; `DESIGNIQ_VERSION` wins) <!-- legacy-name-ok --> |

- The old image name is **no longer published**; 4.3.1 is its last release. A compose file,
  `docker run` or manifest that keeps it raises no error — it silently stays on 4.3.1,
  `:latest` included. Change the `image:` line, or take the new
  [`deploy/docker-compose.yml`](../deploy/docker-compose.yml).
- The new name starts at 5.0.0; earlier releases exist under the old name only. With the
  new compose file an existing `BPMIQ_VERSION=v4.x` pin asks for a tag the new image does <!-- legacy-name-ok -->
  not have: set `DESIGNIQ_VERSION=v5.0.0` (or later) and delete the old line.
- **Keep your volume name.** The docs now show `-v designiq-data:/data`; an install started
  from the older docs uses `-v bpmiq-data:/data`. Do not copy the new name into an existing <!-- legacy-name-ok -->
  `docker run`: a new name is a new, empty `/data`, and the host would come up without its
  live documents and unreleased edits. The compose file's `./data` bind mount is unchanged.

## Everyone signs in again once

The browser session and login cookies are renamed (`bpm_live_sid`, `bpm_live_oauth`, <!-- legacy-name-ok -->
`bpm_live_pkce`, `bpm_live_editor` → `designiq_sid`, `designiq_oauth`, `designiq_pkce`, <!-- legacy-name-ok -->
`designiq_editor`), and 5.0 reads only the new names: every browser is signed out once. A
sign-in that is in flight during the deploy fails its state check — start it again. Bearer
tokens (MCP clients, CI) are not affected.

## Keycloak quickstart

The realm shipped in `deploy/keycloak/` is renamed:

|                | 4.x                                        | 5.0                   |
| -------------- | ------------------------------------------ | --------------------- |
| realm file     | `realm-bpmiq.json` <!-- legacy-name-ok --> | `realm-designiq.json` |
| realm          | `bpmiq` <!-- legacy-name-ok -->            | `designiq`            |
| browser client | `bpmiq-web` <!-- legacy-name-ok -->        | `designiq-web`        |
| MCP client     | `bpmiq-mcp` <!-- legacy-name-ok -->        | `designiq-mcp`        |
| audience       | `bpmiq` <!-- legacy-name-ok -->            | `designiq`            |

The Live Host does not care what the realm is called — it only reads `LIVE_OIDC_*`. Choose:

- **Keep your realm** (do this when it holds real users): leave `.env` as it is and keep
  importing your own realm file — mount it where the compose file now mounts
  `realm-designiq.json`, or stop importing if your Keycloak keeps a database.
- **Move to the new realm:** in `.env`, point `LIVE_OIDC_ISSUER`, `LIVE_OIDC_JWKS_URL`,
  `LIVE_OIDC_AUTHORIZE_URL` and `LIVE_OIDC_TOKEN_URL` at `…/realms/designiq/…`, set
  `LIVE_OIDC_AUDIENCE=designiq` and `LIVE_OIDC_CLIENT_ID=designiq-web`, and re-add MCP
  clients with `--client-id designiq-mcp`. The shipped dev-mode Keycloak keeps no state, so
  it imports the new realm on restart with the demo users only — set `github_login` on your
  own users again. A Keycloak with a database that still starts with `--import-realm` and
  the mounted file gets `designiq` as a second realm next to the old one; its users stay in
  the old realm.

## Content repos: `designiq.yml`

- `designiq.yml` is now the documented contract file. The legacy name `bpmiq.yml` stays
  readable for good, and so does the key `processes:` — nothing breaks if you keep it.
- To rename, finish the [order](#order) above first (older versions read only the legacy
  name), then `git mv bpmiq.yml designiq.yml` and add `/designiq.yml` to `CODEOWNERS`
  wherever `/bpmiq.yml` is listed — the file decides what the platform serves. Do not keep
  both files naming different folders: `designiq.yml` wins and the validator warns.
- The validator warns on a repo that carries only the legacy name:
  `[WARN] bpmiq.yml: legacy contract file name — rename it to designiq.yml (git mv bpmiq.yml designiq.yml); still read`.
  The exit code stays 0, but a CI step that fails on any warning will trip.
- [`process-documentation-starter`](https://github.com/Miragon/process-documentation-starter)
  ships `designiq.yml` from now on; repos created from it need 4.3.1 or later.

## Validator and read-only MCP server (npm)

|                       | 4.x                                                           | 5.0                                                                    |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| validator package/bin | `@bpmiq/validator` / `bpmiq-validate` <!-- legacy-name-ok --> | `@designiq/validator` / `designiq-validate`                            |
| MCP package/bin       | `@bpmiq/mcp` / `bpmiq-mcp` <!-- legacy-name-ok -->            | `@designiq/mcp` / `designiq-mcp-server`                                |
| MCP env               | `BPM_CONTENT_ROOT`, `BPM_TODOS_REPO`, `BPM_TODOS_TOKEN`       | `DESIGNIQ_CONTENT_ROOT`, `DESIGNIQ_TODOS_REPO`, `DESIGNIQ_TODOS_TOKEN` |
| MCP serverInfo name   | `bpm-architecture`                                            | `designiq-mcp`                                                         |

Run them as `npx @designiq/validator --root .` and `npx @designiq/mcp --root <path>`. The
old env names are still read; when both are set, `DESIGNIQ_*` wins. The MCP bin is
`designiq-mcp-server`, not `designiq-mcp` — that bare name belongs to an unrelated npm
package.

## MCP connectors

Connectors keep working: the endpoint is still `https://<host>/mcp` and no tool was renamed.
The Live Host now reports the serverInfo name `designiq-live` (was `bpmiq-live`) and the <!-- legacy-name-ok -->
resource name "designIQ Live Host". The docs suggest `designiq` as the local alias
(`claude mcp add --transport http designiq https://<host>/mcp`) where they said `bpm-live`; <!-- legacy-name-ok -->
an existing connector does not need to be added again.

Contributors to this repository: `.mcp.json` names the read-only server `designiq-content` (was
`bpm-architecture`), so Claude Code asks for approval once more, and permission entries
`mcp__bpm-architecture__*` become `mcp__designiq-content__*`. It is no longer called like
the suggested Live Host alias `designiq`, so a local `claude mcp add … designiq` does not shadow it.

## VS Code extension

The extension (side-loaded, never on the Marketplace) is renamed:

- id `miragon-gmbh.design-iq` (was `miragon-gmbh.bpm-live`) — uninstall the old build; <!-- legacy-name-ok -->
- documents `designiq:/<owner>/<repo>/<path>` (was `bpm-live:/…`) — editors restored with <!-- legacy-name-ok -->
  the old scheme no longer open; reopen them with **designIQ: Open Live Model**;
- setting `designiq.serverUrl` — a `bpmLive.serverUrl` value in user or workspace settings <!-- legacy-name-ok -->
  is copied once on the first start (never over a value already set); delete the old key
  afterwards;
- commands `designiq.*`, shown as **designIQ: …** in the palette.

Sign in again: the stored session belongs to the old extension id. The browser sign-in needs
a 5.0 host **and** a 5.0 extension — the host sends the callback to the extension id it
knows. Against a mixed pair, use **designIQ: Sign in with a session token…**.

## GitHub App

`create-app` proposes the name `designIQ <org>` for a **new** app (GitHub app names are
unique across all of GitHub). Existing apps, their names and slugs are untouched;
`GITHUB_APP_SLUG` stays as it is.

## What else you will notice

- **Todos** filed by 5.0 end with "_Created from the designIQ live model by @…_" (close
  comments: "_Closed from …_"). Hosts from 4.3.1 on read both wordings; an older host on the
  same repo shows the line as part of the todo text. Labels the host creates get designIQ
  descriptions; existing `todo` and `process:*` labels keep theirs — edit them in GitHub if
  you like.
- **Release PRs** say "opened by designIQ on behalf of the releaser".
- **"Not a content repo"** now reads
  `<repo> has no usable designiq.yml (or legacy bpmiq.yml) at its root — not a content repo`
  in the Live Host's API and MCP errors and its boot line; the read-only MCP server and the
  CLIs (`pnpm validate`) word it alike. Codes and statuses are unchanged — match on the code
  (`content/not-a-content-repo`, …), not on the text.
- **Web app**: the product name reads designIQ, the BPMN header toggle for t.BPM workshop
  mode is labelled "Workshop" (files are unchanged), and the cached repo list reloads once.
- **"Analyse with AI"** names the connector by its URL, so the prompt works whatever you
  called the connector.
