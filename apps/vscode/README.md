# BPM Live Workspace (VS Code)

Opens the bpmiq Live Host's model documents as `bpm-live://` files — the same
live Y.Text the web app and the MCP tools edit. The Miragon BPMN Modeler
(`miragon-gmbh.vs-code-bpmn-modeler`) opens them like any other `.bpmn` file;
every other notation opens as text.

## Run it (development)

```
pnpm --filter bpm-live compile
code --extensionDevelopmentPath=$PWD/apps/vscode      # or open apps/vscode and press F5
```

Settings (`bpmLive.*`):

| Setting     | Default                 | What                                                                                                       |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `serverUrl` | `http://localhost:8301` | The Live Host — `http(s)://` or `ws(s)://`, both work.                                                     |
| `token`     | `demo`                  | Dev token (the host's `LIVE_DEV_TOKEN`) for a local host without a login provider; used until you sign in. |

Commands:

- **BPM Live: Open Live Model** — pick a repository (the ones you may write),
  then a model of any notation; the list shows folder, notation, who is on it
  and whether it carries unreleased changes. _Enter a path…_ at the end takes
  a repo-relative path by hand.
- **BPM Live: Sign in** / **Sign out**. The status-bar item runs the sign-in
  while signed out and the open command once signed in.

## Sign-in

_BPM Live: Sign in_ opens the host's own login (GitHub OAuth, or the SSO login
when the host has one) in your browser. The callback bounces back into this
editor through `vscode://miragon-gmbh.bpm-live/auth` with a one-time code,
which the extension exchanges for its session — the one credential the host
accepts on the websocket and the REST routes. It is stored in VS Code's
SecretStorage per host URL; the browser gets no cookie, so signing out of the
web app never signs the editor out (and vice versa). Sessions last a working
day (12h); after that the next open asks you to sign in again.

Works in VS Code, Insiders, Cursor and other `vscode.env.uriScheme` editors
on the desktop; browser-hosted VS Code (vscode.dev) is not covered.

## Presence

Each open live document announces you (name, avatar, the same color as in
the web app) in the room's roster; on the dev token you show up as
`dev-token`.

## Limits

- Remote changes are applied while the document is not dirty. Once you edit,
  the document goes dirty and re-syncs on save — `files.autoSave: afterDelay`
  keeps a co-editing session flowing until the live binding lands.
- No Explorer tree yet: models are opened through the picker, not browsed as
  a workspace folder.

## Tests

- `pnpm --filter bpm-live test` — unit tests of the sign-in and picker helpers.
- `pnpm --filter bpm-live test:e2e` — a real VS Code (downloaded once) with
  the Miragon modeler, against a running Live Host on `localhost:8301` with
  `LIVE_DEV_TOKEN=demo`; asserts the picker's data path, content sync both
  ways, presence and the custom editor.
