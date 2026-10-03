# ADR 0008 — Rename to designIQ: readers before writers, stored identifiers frozen

- **Status:** accepted (2026-10-03); Release A shipped as 4.3.0 (#222) and 4.3.1 (#224),
  Release B is 5.0.0
- **Context:** the product outgrew its name; an inventory of every place the old name
  lives — code, published artifacts, customer data — taken while writing the codemod
  `scripts/rename-designiq.mjs`
- **Related:** [0004](0004-open-source-split.md) (one artifact — the image whose name
  changes), [0006](0006-notation-plugins-and-structured-doc-shape.md) (the notation
  plugins that made a BPM name too narrow), [0007](0007-idp-only-login-and-no-auth-mode.md)
  (the cookies and the Keycloak quickstart renamed here)

ADRs 0001–0007 predate this decision and keep the names of their time.

## Context

The platform started as a BPM tool and was named for it — "bpmiq", "BPM Live". <!-- legacy-name-ok -->
Since ADR 0006 it models BPMN, DMN, Wardley Maps, Team Topologies, Event Storming and
Context Maps; the name described one notation of six. The GitHub repository was renamed to
`Miragon/design-iq` first; everything else followed in two releases.

The name is not one string. It lives in four kinds of places, and each breaks differently:

1. **What people read** — UI copy, page titles, notifications, issue and PR texts, docs.
   Free to change.
2. **What we publish** — the npm scope, the container image, CLI bins, the VS Code
   extension id, the Keycloak quickstart realm. A rename breaks every consumer that pins
   the old name, once — loudly or silently.
3. **What other programs read from us** — the contract file in every content repo, env
   vars, cookies, the attribution line in todo issues, the compose version variable.
   Writer and reader are deployed independently: a content repo, a host, a CI validator
   and the starter template each upgrade on their own schedule.
4. **What is stored in data we do not own** — the sticky XML namespace in customer BPMN
   files, the todo marker in customer issues, host state in the `.git` of running
   installations, the namespace of existing decisions, a wire value open clients match on.
   Renaming these means rewriting customer data or carrying two names forever, for values
   no user ever reads.

## Decision

### 1. The names

| Form            | Value       | Used for                                                                                                               |
| --------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| identifier      | `designiq`  | file names, keys, ids, env vars `DESIGNIQ_*`, CSS classes, log prefixes, serverInfo names, the npm scope `@designiq/*` |
| display name    | `designIQ`  | everything a human reads                                                                                               |
| repository slug | `design-iq` | `Miragon/design-iq`, the VS Code extension's package name                                                              |

The server component keeps its name — the **Live Host**, "designIQ Live Host" where the
product is named with it — and its `LIVE_*` variables. The concrete names:

- image `ghcr.io/miragon/designiq-live-host`;
- bins `designiq-validate` and `designiq-mcp-server` — not `designiq-mcp`: that bare name
  belongs to an unrelated npm package;
- contract file `designiq.yml`;
- cookies `designiq_sid`, `designiq_oauth`, `designiq_pkce`, `designiq_editor`;
- Keycloak quickstart: realm and audience `designiq`, clients `designiq-web` and
  `designiq-mcp`;
- VS Code: extension id `miragon-gmbh.design-iq`, URI scheme `designiq:`, commands and
  settings under `designiq.*`;
- serverInfo names `designiq-mcp` (the read-only server) and `designiq-live` (the Live
  Host's `/mcp`).

Where an identifier never needed a brand, it loses the brand instead of swapping it: the
structured codec header is `structured-model`, the sticky moddle key `sticky`. The next
rename touches fewer places.

### 2. Two releases: readers before writers

- **Release A (4.3.0, 4.3.1)** taught every reader the new names and wrote nothing new:
  `designiq.yml` read next to the legacy file and winning, the `DESIGNIQ_*` env vars of the
  read-only server read first, the todo attribution read in both wordings,
  `DESIGNIQ_VERSION` in compose with the old variable as fallback, the starter sync
  accepting both file names.
- **Release B (5.0.0)** switches the writers and the identity strings: what the platform
  publishes, writes and shows carries the new names; readers keep accepting the old ones
  wherever data in the wild carries them.

Once every reader runs 4.3.1, no writer can produce a name a deployed reader does not
understand — the precondition [upgrading-to-5.md](../upgrading-to-5.md) puts first. The
mechanical half of Release B is a re-runnable codemod: it rewrites only tokens with exactly
one meaning, masks the frozen ones (§4), and skips lines marked `legacy-name-ok` as well as
the history (CHANGELOG, ADRs 0001–0007). A branch that predates the rename replays it and
rebases without hand-merging.

### 3. Old names stay readable

- the legacy contract file name, for good, and its legacy key `processes:` — a repo with
  only the legacy name gets one validator warning (`content/legacy-config-name`, exit
  code 0);
- the legacy wording of the todo attribution line — issues filed before the rename keep
  their author;
- the read-only server's `BPM_*` env vars and compose's old version variable — the new name
  wins when both are set.

### 4. Frozen: stored identifiers keep their value

| Identifier                                                                                         | Lives in                                           | Why it never changes                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sticky namespace `https://bpmiq.io/schema/1.0/bpmiq`, prefix `bpmiq:` (`sticky`, `Sticky`, `mode`) | customer `.bpmn` files                             | rename both and the stickies and workshop flag of existing files silently vanish; rename only the URI and saving throws <!-- legacy-name-ok: frozen --> |
| todo marker `<!-- bpmiq:todo v1`                                                                   | issue bodies in customer trackers                  | todos are found by it; a new marker orphans every open todo <!-- legacy-name-ok: frozen -->                                                             |
| room message `bpmiq/moved`                                                                         | the broadcast after a move                         | clients open across a deploy (tabs, chat widgets) match on exactly this string <!-- legacy-name-ok: frozen -->                                          |
| `.git/bpmiq-{conflicts,released,renames}.json`, `.git/bpmiq-parked`                                | the workspaces of running installations            | a new name drops conflict flags and release marks on upgrade <!-- legacy-name-ok: frozen -->                                                            |
| DMN namespace base `http://bpmiq.dev/dmn/`                                                         | existing decisions — and the template for new ones | an opaque id, never resolved; one base keeps old and new decisions alike <!-- legacy-name-ok: frozen -->                                                |

The codemod masks every one of them. The sticky namespace, the todo marker, the room
message and the host-state names are also pinned by tests built from split literals, which a
blanket search and replace cannot reach; code and comments naming them carry
`legacy-name-ok`.

### 5. The image moves without a dual publish

From 5.0 the release workflow publishes `ghcr.io/miragon/designiq-live-host` only. The old
name keeps its tags up to 4.3.1 and receives nothing further. A dual publish has no natural
end and doubles ADR 0004's one artifact; a major release with an upgrade guide is the clean
cut. The private SaaS overlay (ADR 0004) switches its image references in the same step.

### 6. Cookies and the Keycloak quickstart are renamed, without a fallback

The host reads only the new cookie names: every browser signs in again once, and a login in
flight during the deploy is retried. Reading both names would keep the old ones in the auth
path indefinitely to save one sign-in. The quickstart realm, its clients and audience take
the new names too; the Live Host reads the realm only through `LIVE_OIDC_*`, so an install
can keep its existing realm unchanged.

## Consequences

- One breaking major release (5.0.0) with a written upgrade path:
  [upgrading-to-5.md](../upgrading-to-5.md).
- Installs that keep the old image name stay on 4.3.1 without an error — the guide leads
  with it, because nothing else will tell them.
- Everyone signs in once more; the VS Code extension is a new extension to VS Code (settings
  are carried over once, the stored session is not).
- Customer files and trackers keep the frozen values; anyone reading BPMN XML or an issue's
  source still sees the old name there. Accepted: §4 lists them so nobody "fixes" them.
- Legacy repos get a validator warning until renamed; CI that fails on any warning trips.
- History keeps the old names: CHANGELOG, ADRs 0001–0007, the GitHub App and Fly app names
  Miragon already registered.

## Rejected alternatives

- **One release that renames everything.** A repo renamed to `designiq.yml` breaks on every
  host not yet upgraded, and hosts sharing a repo misread each other's todos. Readers have
  to be deployed before writers.
- **Rename the stored identifiers with migrations.** Rewrites every customer BPMN file with
  stickies and every todo issue — diffs in repositories the platform does not own — for
  names no user sees.
- **Publish the image under both names for a while.** No natural end, twice the release
  flow, and a `:latest` on the old name that keeps working hides the move instead of
  completing it.
- **Read the old cookies as a fallback.** Saves one sign-in and keeps a second set of names
  in the auth path.
- **`designiq-mcp` as the read-only server's bin.** The bare name is taken by an unrelated
  npm package.
