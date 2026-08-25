# Integrations

Ways for tools _outside_ the content repo's skill layer to consume the models.

The platform has **two MCP surfaces**:

- **`packages/mcp`** — read-only, runs against any checkout, zero infrastructure.
- **the Live Host's `POST /mcp`** — read-write against the **live**, collaboratively-edited
  state, with per-repo auth, served by the running platform.

Rule of thumb: talk _about_ released models → `packages/mcp`; read or **edit**
work-in-progress → the Live Host endpoint.

## MCP server (`packages/mcp/`)

A minimal, read-only [MCP](https://modelcontextprotocol.io) server that exposes a content
repo's processes. Any MCP client (Claude Code, other IDEs, agent frameworks) can query the
processes **live from HEAD**: a content repo is a root `bpmiq.yml` naming its models folder
(`models:`, legacy alias `processes:`), a model IS a file with a registered notation extension
there (a process its `.bpmn`, a decision its `.dmn`), and the process view is **derived from
the BPMN** at call time (`@bpmiq/notations/derive`). No build step; the tool definitions live in
`packages/mcp/tools.ts`, shared by two entry points:

- `packages/mcp/server.ts` — **stdio**, for local use (Claude Code auto-connects via `.mcp.json`)
- `packages/mcp/http.ts` — **Streamable HTTP** (`POST /mcp`), for remote use; the root
  `Dockerfile` packages exactly this

| Tool                         | Question it answers                 | Reads / derives                                                                                                                                                  |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`                | What models exist, of ANY notation? | every registered-notation file under the `bpmiq.yml` folder, grouped by notation: id (file stem), path, plus name/summary/stats where the notation has a deriver |
| `list_processes`             | What processes exist?               | every `.bpmn` under the `bpmiq.yml` folder: id (file stem), derived name, path, stats                                                                            |
| `get_process(id)`            | Everything about one process        | the derived view: name, roles (BPMN lanes), steps (with role), gateways, events, flow, sub-process calls                                                         |
| `get_model(id)`              | What does the MODEL say?            | the process's BPMN parsed into a generic graph (nodes/edges/lanes/pools) via `@bpmiq/notations/extract`                                                          |
| `enumerate_paths(id, max?)`  | Which ways can a case take?         | the BPMN, start→end path enumeration (cycle-safe, capped)                                                                                                        |
| `find_cycles(id)`            | Where does the flow loop?           | the BPMN's sequence flows                                                                                                                                        |
| `who_owns(id)`               | Who does what?                      | the BPMN lanes (roles) and the steps each contains; the pools                                                                                                    |
| `which_processes_use(query)` | Impact: what references this?       | each process's id, derived name, role names, step names, and `callActivity` `calledElement`                                                                      |
| `list_todos(process?)`       | What work is open (opt-in)?         | the content repo's issue tracker (label `todo` + `process:<id>`), anchors parsed from issue bodies                                                               |

All tools carry `readOnlyHint` annotations, so clients may auto-approve them. The content repo
is configurable: `node server.ts --root /path/to/repo` or the `BPM_CONTENT_ROOT` env var — the
bundled `process-documentation/` is only the default.

`list_todos` is the one tool that leaves the checkout (a read-only query against the repo's
issue tracker) and is **strictly opt-in**: it only registers when both `BPM_TODOS_REPO`
(`owner/name`) and `BPM_TODOS_TOKEN` (a token with issues:read) are set — without them the
server stays zero-auth and the tool does not exist. `GITHUB_API_URL` overrides the REST base
(default `https://api.github.com`).

### Live from HEAD vs. exported snapshots

`export-process-skill` remains the right tool for **external** consumers — a claude.ai
project, another repository's `.claude/skills/` — because its output under `dist/skills/<id>/`
is self-contained and needs no repo access. But a snapshot starts rotting the moment the model
changes. **Internal** consumers that can reach this repository should not accept that
staleness: the MCP server has no snapshot to rot, so a model edit is visible on the very next
tool call.

Rule of thumb: repo access → MCP server. No repo access → `export-process-skill`.

### Setup

```sh
pnpm install        # monorepo root — installs all workspace packages
```

Requires Node >= 23.6 (runs the TypeScript server directly via built-in type stripping). That is all:

- **Claude Code** reads the repo-root [`.mcp.json`](../.mcp.json) and connects automatically
  when you open the repository (you approve the server once).
- **Any other MCP client** — register a stdio server:

  ```json
  {
    "mcpServers": {
      "bpm-architecture": {
        "command": "node",
        "args": ["/absolute/path/to/bpm-iq/packages/mcp/server.ts"]
      }
    }
  }
  ```

### Remote: the read-only server over HTTP

A deployed instance of the read-only server serves its tools at `POST /mcp` over
Streamable HTTP — stateless, so no session management is needed:

```sh
# Claude Code
claude mcp add --transport http bpm https://<app>/mcp

# any HTTP MCP client: point it at https://<app>/mcp
```

The MCP endpoint is public by default; to require auth, set `MCP_TOKEN=<token>` — clients must
then send `Authorization: Bearer <token>`. Local development: `PORT=8080 node packages/mcp/http.ts`.

## Live Host MCP endpoint (`apps/live-host`)

The Live Host serves its own MCP endpoint at `POST /mcp` (official
`@modelcontextprotocol/sdk`, stateless Streamable HTTP) — same container, same port as
sync, REST API and web app. Where `packages/mcp` reads a checkout, this endpoint reads and
**writes the live collaborative state**: the same Y.Text the browser tabs and VS Code edit,
accessed server-side via a Hocuspocus direct connection. `repo` is a **tool argument**
(`owner/name`), not a URL segment — one endpoint serves every connected repo, and every
call is gated by the caller's per-repo permission.

| Tool                    | Kind  | What it does                                                                             |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `list_repos`            | read  | The connected repos the caller may work on.                                              |
| `list_models`           | read  | EVERY model file of one repo, grouped by notation — the superset of the two lists below. |
| `list_processes`        | read  | The processes of one repo (id, `bpmn` path, folder, dirty flag, live sessions).          |
| `get_process`           | read  | The derived view (name, roles, steps, flow, calls) from the **live** BPMN.               |
| `get_bpmn_xml`          | read  | The live BPMN XML plus the `baseVersion` for a later save.                               |
| `validate_bpmn`         | read  | Dry-run the platform validator on submitted XML — check before saving.                   |
| `list_decisions`        | read  | The DMN decisions of one repo (id = `.dmn` file stem, path, dirty, live sessions).       |
| `get_decision`          | read  | The derived decision view (hit policy, columns, rules, DRD wiring) — see below.          |
| `get_dmn_xml`           | read  | The live DMN XML plus the `baseVersion` for a later save.                                |
| `simulate_decision`     | read  | Run one scenario and see which rules fired — live model or unsaved `xml`.                |
| `analyze_decision`      | read  | Static checks (broken FEEL, dead rules, dead wiring) + test-value candidates.            |
| `run_decision_tests`    | read  | Run the stored test suite (or cases passed inline) with rule coverage.                   |
| `get_decision_tests`    | read  | The stored suite + the `baseVersion` a save needs.                                       |
| `list_changes`          | read  | A repo's unreleased live changes.                                                        |
| `list_todos`            | read  | Open model-anchored todos — whole repo, or narrowed to one process.                      |
| `open_modeler`          | read  | Open the embedded BPMN modeler widget (MCP App) — see below.                             |
| `open_decision_modeler` | read  | Open the embedded DMN modeler + simulator, optionally with a scenario applied.           |
| `create_process`        | write | Scaffold a new process `.bpmn` in the live workspace.                                    |
| `save_bpmn_xml`         | write | Validated, conflict-guarded save into the live document (requires `baseVersion`).        |
| `create_decision`       | write | Scaffold a new decision `.dmn` from the blank template.                                  |
| `save_dmn_xml`          | write | Conflict-guarded save of DMN XML into the live document (requires `baseVersion`).        |
| `save_decision_tests`   | write | Write `<decision>.tests.yaml` next to the model (`record` freezes today's behaviour).    |
| `create_todo`           | write | File a todo, anchored to the process and (optionally) concrete BPMN elements.            |
| `close_todo`            | write | Complete a todo in the tracker (`todoId` from `list_todos`).                             |
| `release_process`       | write | Open the release PR — merge rights stay at the git provider.                             |

### Decisions: DMN as a first-class model

A decision **is** a `.dmn` file under the same `bpmiq.yml` folder (id = file stem), so the
decision tools mirror the process tools one-to-one: `list_decisions` → `get_decision` →
`save_dmn_xml`, all addressed by `id` or `path`, all conflict-guarded the same way.

`get_decision` returns the **derived view**, not the XML: every decision with its hit
policy, aggregation, input/output columns and rule rows (`when`/`then` hold the raw FEEL
source text, aligned to the columns), plus the DRD wiring — which InputData and which
upstream decisions each one requires. That is the shape to reason about the logic in; read
the XML only when you intend to write it back.

### Simulating and analysing a decision

`simulate_decision` runs one scenario through the decision and reports **which rules
fired**, by rule id. `given` is keyed by variable name — the columns' input expressions,
not their labels; a table written without modelled InputData works exactly the same
(`analyze_decision` lists the variables it needs). The whole DRD is evaluated in
dependency order, so a chain comes back decision by decision, each with its matched and
reported rules, outputs, aggregation and any hit-policy violation. Keys that match no
variable, and variables the scenario left unset, are reported rather than quietly
behaving like a rule that did not match.

`analyze_decision` is the pass that needs **no** test data. It exists because every FEEL
engine treats a broken expression as "did not match" — a typo in a rule is otherwise
indistinguishable from a rule that legitimately did not apply. It reports FEEL that does
not parse, rules that can never fire (or that guarantee a UNIQUE violation), requirements
whose result variable nothing reads, cycles — and returns, per variable, the literals and
numeric boundaries the rules use: the raw material for writing test cases.

Both take either a stored decision (`repo` + `id`/`path`) or an explicit `xml` — the
same dry-run shape as `validate_bpmn`, so an edit can be checked before it is saved.

Evaluation runs on `@bpmiq/decisions`, and MCP is only one of its callers: the package is
**isomorphic**, so the very same module also runs in the browser — in the web client's
live DMN editor (the **Checks** panel: findings and "try a scenario" without a
round-trip) and in the MCP-App widget. Together with the engine it drives
(`@emaarco/dmn-js-simulation`, FEEL via `feelin`, the add-on dmn-js mounts), that means a
scenario an agent simulates, one a human clicks and one CI runs are the same computation
rather than three implementations that agree until they don't.

### Decision tests: the sidecar

A decision's test cases live in **`<decision>.tests.yaml` next to the model** — an
ordinary repo file that diffs, reviews and ships in the same release PR:

```yaml
decision: credit-limit-check
cases:
  - name: A blocked customer is rejected even for a tiny, clean order
    given: { customerSegment: blocked, orderValue: 50, overdueInvoices: 0 }
    expect:
      value: reject
      rules: [Rule_blocked_customer] # WHICH rule produced it
```

`expect.rules` is what makes a case more than an output check: a right answer produced by
the wrong rule still fails. A case with **no** `expect` is legal — it comes back as
`pending` together with the value it currently produces, and `save_decision_tests` with
`record: true` freezes exactly that (golden master). That is the one honest way for a
machine to author expectations: it states what the model does today, which makes the next
change visible. Expectations about what the model _should_ do belong to the business.

`run_decision_tests` also reports **rule coverage** — `uncoveredRules` lists every rule
whose result no case ever observed. Note the distinction it draws: under `FIRST` a
shadowed rule can match in every case without ever deciding anything, so "matched" would
overstate coverage; the metric counts rules the hit policy actually _reported_.

The same suites run headless in CI: `pnpm validate` invokes the platform validator
(structure, DMNDI, requirement integrity) and then `packages/decisions/cli.ts`, which
analyses every `.dmn` in the checkout and runs its cases. Exit code 1 on an error or a
failing case.

### Which process uses which decision

A `businessRuleTask` names the decision it delegates to — the platform reads
`decisionRef` (Camunda 7), `<zeebe:calledDecision decisionId>` (Camunda 8) and a plain
`calledDecision` or `calledElement` (hand-written models), and in every spelling the
value is the **`.dmn` file stem**, exactly like `callActivity`'s `calledElement` is a
`.bpmn` file stem. From that one link:

- `get_process` lists the decisions a process delegates to (and each step carries its
  `decides`),
- `get_decision` returns `usedBy` — the processes and the concrete task ids that call it,
  which is the impact answer before changing a table,
- the validator warns when a `businessRuleTask` points at a decision the repo does not
  contain (a warning, not an error: the decision may live in another system).

### The release PR explains what the decision now decides

When a release ships a `.dmn` (or only its `.tests.yaml`), the PR body gains a **Decision
impact** section: the suite is run against both the workspace version and
`origin/<default>`, and every case whose answer moved is listed with before and after.
A DMN diff is unreadable — reordered rules, renamed ids, a `>=` that became a `>`; a
table of changed answers is a review a business reader can actually do. The section also
carries the static findings and, when a decision has no cases at all, says so plainly.
It degrades quietly (new decision, no suite, no git access) — a release never fails
because its commentary could not be produced.

### Todos: work items in your own tracker

`list_todos` / `create_todo` / `close_todo` speak to the **IssueTracker port**
(`ports/issue-tracker.ts`): model-anchored work items live as first-class items in the
customer's own tracker (GitHub: repo issues labelled `todo` + `process:<id>`), never in a
platform database. Items are bot-authored via the installation token and the human stays
attributed textually — the same model as releases. The anchor (process, model file, BPMN
element ids with a name snapshot) rides invisibly in the item body, so an agent can file
"this gateway needs a decision table" against an element id and the modeler shows a badge
on exactly that shape.

The three tools register **only when the platform has tracker credentials** — no tracker,
no tools in `tools/list` (agents plan against reality instead of discovering it by failing).
Listing is a read and survives `LIVE_MCP_READONLY=1`; filing and closing do not. Every call
runs the same per-(user, repo) authorization as the model tools.

### MCP App: the embedded modeler

`open_modeler` is an [MCP App](https://modelcontextprotocol.io/specification/2026-01-26)
(`io.modelcontextprotocol/ui`): in apps-capable clients (claude.ai, Claude Desktop) it
renders an interactive bpmn-js modeler inline in the conversation — pan/zoom, edit, and
save through the same validated, `baseVersion`-guarded path as `save_bpmn_xml` (a
concurrent save shows a conflict banner: load theirs, overwrite, or keep editing; a
save tells the model to re-read instead of trusting stale XML). The widget is the
single-file bundle `apps/web/dist/mcp-app.html` (built by
`vite.mcp-app.config.ts`), served as a `ui://` resource; its tool calls ride the
host's authenticated connection, so per-repo authorization applies per call exactly
like agent calls.

The widget edits **live**: it first tries the same Hocuspocus/Yjs session the web
editor uses (a single-use, room-bound ws ticket from `mint_ws_ticket`, 60s TTL — see
ADR 0005's 2026-08-04 amendment) — then edits sync instantly in both directions,
co-editors included. If the host sandbox blocks the socket (claude.ai's
`connectDomains` enforcement is partially buggy), it degrades to **autosave over the
bridge**: a debounced `save_bpmn_xml` with `lint:"warn"`, where validator findings
inform in the status line instead of blocking — the ws rooms' trust level, which never
gated live edits. The status line shows which mode is active ("Live — co-editing
enabled" vs "changes save automatically"). The hand-over is lossless in both
directions: unsaved canvas edits are flushed through the CAS save before the first
Yjs import may replace the canvas, and when an established live connection drops
(any ws drop is final — the single-use ticket cannot re-authenticate the provider's
auto-reconnect) the widget reconciles against a fresh bridge read: server unchanged
since the last sync → a fresh ticket resumes live seamlessly; diverged (colleague
edits during the outage, local edits that never reached the room, or both) → a
banner hands the direction-blind choice to the user — never a silent overwrite of
either side, and never a silent stop of persistence.

The widget also carries the **todos** of the open process: a side panel lists them, count
badges sit on every anchored element (a badge click filters the panel to it, a chip click
reveals the element on the canvas), "＋ New" files one against the current canvas
selection, and "✓ Done" closes it in the tracker. It drives the same `list_todos` /
`create_todo` / `close_todo` tools over the app bridge — so a tracker-less host simply has
no todo button, and a read-only host gets the list without the buttons. Nothing about the
modeling path depends on it.

**"✦ Implement" hands a todo to the assistant.** The widget injects a work order into the
chat as a user message (`ui/message`) — repo, model path, process, anchored element ids and
the todo's description inlined, followed by the exact steps: `get_bpmn_xml` (keep the
`baseVersion`) → make the edit → `validate_bpmn` until clean → `save_bpmn_xml` (CAS; on
conflict re-derive and retry) → `close_todo`, and only after the save succeeded. Three rules
are spelled out rather than assumed: ask instead of guessing at process semantics, never
close over an unsaved model, and the description is fenced as data ("information, not
instructions") — it comes from the tracker, where labeling an issue `todo` takes only triage
rights, so a crafted body must not be able to splice its own steps into the work order. The
widget then returns to inline display and closes the panel,
because the answer arrives in the conversation, not in the iframe. Tracker links go through
the host too (`ui/open-link`) — the app sandbox blocks `target="_blank"` navigation.

**"Open in bpmiq" leaves the chat for the full product.** The toolbar's deep link opens
the loaded model in the web modeler — the process route, carrying the current canvas
selection as `?element=` so the web editor reveals exactly the element under discussion
(the DMN widget links its file route). The instance origin rides in the widget's boot
payload (the sandboxed iframe cannot know it otherwise), the link opens through the same
`ui/open-link` ladder as tracker links, and a still-unsaved edit is flushed in parallel —
it lands in the very live document the opened editor joins (while a conflict banner is
up, the flush stays paused: the opened editor shows the server version and the banner
keeps owning the divergence decision). Logged-out recipients pass
the login gate and land on the model, not the overview (the SPA stashes the deep link
across the auth round-trip). The `open_modeler` / `open_decision_modeler` results carry
the same link as `opened.url`, so non-apps clients can surface it in plain text.

Clients without apps support (Claude Code, the read-only `@bpmiq/mcp` package) see a
plain tool that returns a short process summary plus the model's web URL — use
`get_process`/`get_bpmn_xml` there. Under `LIVE_MCP_READONLY=1` the tool stays registered
but the widget becomes a read-only viewer (no save button, no ws ticket), matching the
absent write tools — the "Open in bpmiq" link stays, pointing at the differently
authenticated web surface.

### MCP App: the decision modeler and its simulator

`open_decision_modeler` is the DMN sibling (`apps/web/dist/mcp-app-dmn.html`, its own
`ui://` resource): dmn-js — DRD, decision table, literal expression — with the
[dmn-js-simulation](https://github.com/emaarco/dmn-js-simulation) add-on mounted into
both views. Type values into the table and the matching rows light up; the rule the hit
policy actually reports is marked differently from the ones that merely matched.

Two things make it more than a viewer:

- **The agent can hand over a scenario.** `open_decision_modeler` takes an optional
  `scenario` (the same variable → value map as `simulate_decision`), which the widget
  plays straight into the simulator. "This case returns `manual-review` instead of
  `approve`" stops being a sentence and becomes a highlighted row.
- **A run can be captured as a test.** "＋ Capture current run" takes the values
  currently entered, asks for a name, and writes them into `<decision>.tests.yaml` via
  `save_decision_tests` with `record: true` — the server evaluates and freezes what the
  decision produces. The panel lists the stored cases with their pass/fail state
  (`run_decision_tests`), and clicking one replays it on the table, so a failing case is
  visible _on the model_.

Both sides run the same engine, so a run clicked here and one simulated by an agent
cannot disagree. Saving works like the BPMN widget (autosave, `lint:"warn"`,
`baseVersion` CAS with a conflict banner); it deliberately does **not** take the Yjs
live upgrade — decision tables are edited cell by cell by one person at a time, and the
conflict flow covers the rare collision honestly.

### Analyse with AI: the deep link into the widget

The web editor's toolbar (and every process/decision row on the repo overview) carries
an **"Analyse with AI"** dropdown — the doorway in the opposite direction: one click
opens an AI chat whose first move is `open_modeler` / `open_decision_modeler` for
exactly the model on screen, so the widget comes up live-synced with the editor the
user just left. The menu only picks the destination — Claude Desktop, ChatGPT, or the
clipboard. The prompt is a work order built by `@bpmiq/contracts/assist`: the literal
tool call with repo and path inlined, the Live Host's MCP URL named (a connector
pointed at a _different_ instance then fails as a recognizable "wrong instance", not a
phantom missing repo), and the current canvas selection riding along as fenced data —
what to do with the model stays the user's next message.

Every target is a **prefill** — the chat opens with the prompt prepared and the user
reviews and sends it; nothing runs on its own:

- **Claude Desktop** — `claude://claude.ai/new?q=…`
  ([documented](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link);
  `q` truncates around 14k characters, our prompts stay far below). Whether the scheme
  is handled cannot be read from a browser, so a quiet miss softly offers the fallback.
- **ChatGPT** — `https://chatgpt.com/?prompt=…` (undocumented; deliberately not `?q=`,
  which auto-submits). ChatGPT implements the open MCP Apps standard, so the same
  widgets render there; the tools additionally carry ChatGPT's legacy
  `openai/outputTemplate` alias. Caveats: the connector must be added in developer
  mode, and full (write-capable) MCP is currently a Business/Enterprise/Edu beta —
  Pro is read-only. Register ChatGPT's redirect URIs at the IdP
  (see [extending/mcp-idp-setup.md](extending/mcp-idp-setup.md)).
- **Copy the prompt** — the escape hatch for every other client (or a missing
  install): paste it into any chat connected to this connector.

The connector is the hard prerequisite — without it the chat opens and stalls, which is
why the menu links to this page. And a prompt is not a protocol: the receiving model
_should_ open the widget first, but nothing guarantees it — the imperative first step
with the literal tool call is the lever, honest UI copy is the promise.

`save_bpmn_xml` is compare-and-set: the caller passes the `baseVersion` from a prior
`get_bpmn_xml`, and if the live document moved in between, the save is refused with a
retryable `{conflict: true, currentXml}` — re-read (or rebase onto `currentXml`) and retry;
nothing is overwritten. Saves are validation-gated (`@bpmiq/validator`: ERROR findings
refuse the save, WARN findings come back as warnings) and land in the live Yjs state —
every open editor sees them instantly, exactly like a keystroke.

**Auth** is the Live Host's one auth surface: a browser session cookie,
`Authorization: Bearer <session-id>`, the dev token (`LIVE_DEV_TOKEN` — local only), or an
**OIDC JWT** from your IdP (`LIVE_OIDC_ISSUER` + `LIVE_OIDC_JWKS_URL`; audience defaults
to `LIVE_PUBLIC_URL`, and the login claim — default `github_login` — must carry the
IdP-verified GitHub login; see [on-prem/configuration.md](on-prem/configuration.md) and
the verified IdP recipe in [extending/mcp-idp-setup.md](extending/mcp-idp-setup.md)).
Per-repo authorization runs app-side against real GitHub permissions on every tool
call — with one deliberate exception: the dev token bypasses it entirely (that is its
purpose; local spikes only, never set it in production — see
[on-prem/configuration.md](on-prem/configuration.md)).
`LIVE_MCP_READONLY=1` registers **no** write tools — they are absent from `tools/list`,
not erroring.

Connect a client:

```sh
claude mcp add --transport http bpm-live http://localhost:8301/mcp \
  --header "Authorization: Bearer <token>"
```

Locally the token is `LIVE_DEV_TOKEN`; in production it is an OIDC access token obtained
via the client's OAuth flow — when OIDC is configured the host publishes RFC-9728
protected-resource metadata at `/.well-known/oauth-protected-resource`, so clients like
claude.ai discover the IdP themselves. Manual smoke test:
`SMOKE_TOKEN=<dev-token> node apps/live-host/scripts/mcp-smoke.mjs [mcpUrl] [repo]`.

Non-MCP clients get the same live content over plain REST:
`GET/PUT /api/repos/:owner/:repo/content?path=<model path>` — GET returns
`{repo, path, xml, baseVersion}`; PUT requires `{xml, baseVersion}` and applies the same
validation + compare-and-set (a stale `baseVersion` → `409` with the current state instead
of overwriting).

Decision record: [ADR 0005](adr/0005-in-process-mcp-and-oidc-resource-server.md).

## Read-only vs. write-capable — which server holds a pen

**`packages/mcp` stays read-only by construction.** The server only ever reads files; no
tool creates, edits, or deletes anything, and missing or invalid files produce an
explanatory message instead of an error. Changes keep going through the modeling workflow:
edit in VS Code, check with `process-review` and `pnpm validate`, commit. That MCP server
is a window onto the models, never a pen.

**The Live Host's `/mcp` IS write-capable** — but its writes land in the live Yjs state
(and its write-through workspace file), never directly in git. Every save is
validation-gated and conflict-guarded (`baseVersion`), and changes reach the repository
only through the release-as-PR flow — merge stays a human decision at the git provider.
