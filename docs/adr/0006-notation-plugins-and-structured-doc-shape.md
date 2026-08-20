# ADR 0006 — Notation plugins: capability slots, a reference meta-model, and the structured doc shape

- **Status:** accepted (2026-08-20)
- **Context:** synthesized from three fully drafted alternatives (evolutionary
  slot extension, versioned plugin SDK, meta-model-first) that were
  adversarially judged against the codebase; every load-bearing claim below was
  verified against the code
- **Related:** [0003](0003-module-architecture-and-shared-packages.md)
  (hexagonal backends, CI-enforced boundaries — extended, not changed),
  [0004](0004-open-source-split.md) (the published `bpmiq-validate` binary
  constrains where checkers may live),
  [0005](0005-in-process-mcp-and-oidc-resource-server.md) (the /mcp surface
  this ADR generalizes per notation)
- **Tracking:** epic [#118](https://github.com/Miragon/bpm-iq/issues/118),
  steps #119–#126

## Context

bpmiq is growing from a BPM platform into a general architecture tool: one
plugin per notation — BPMN, DMN, Markdown, Wardley Maps, Team Topologies,
Event Storming, Domain Storytelling, and notations we have not named yet.

`@bpmiq/notations` is already declared as "the ONE place that knows what a
modeling notation is", and wardley/team-topology/value-chain descriptors
exist. But today a descriptor buys only file identity and a Monaco language.
Everything behavioral is hard-coded to BPMN/DMN:

- **Discovery** knows exactly two shapes: `discoverProcesses` (`.bpmn`) and
  `discoverDecisions` (`.dmn`); `bpmiq.yml`'s schema is `{ processes: string }`.
  The three non-BPMN extractors in `extract.ts` are therefore **dead code** —
  no discovery path ever reaches an `.owm`/`.tt`/`.vc.json` file, and a
  syntactically broken `.tt` passes `pnpm validate` untouched.
- **`derive.ts` is two hand-written functions**, not a mechanism; every caller
  gates on `graph.notation === "bpmn" | "dmn"`.
- **The web client** mounts editors via `isBpmn`/`isDmn` branches; the
  Analyse-with-AI contract carries a closed `"bpmn" | "dmn"` union.
- **Link integrity** (callActivity→subprocess, decisionRef→decision) lives as
  bespoke `Set<string>` parameters inside the validator; impact analysis
  re-implements traversal per feature.
- **The live `/mcp`** registers 19 individual hand-written tools; the generic
  graph tools in `packages/mcp` pin `sequenceFlow`/`startEvent`.
- **The live contract is one Y.Text per file**, and the minimal-diff writer
  computes a single contiguous edit region per save — correct for text
  notations, structurally wrong for boards (below).

Two of the target notations (Event Storming, Domain Storytelling) are canvas
notations whose defining scenario is many simultaneous writers.

## Decision

1. **The descriptor becomes the capability contract; registration stays
   static.** `NotationDescriptor` gains optional, pure, isomorphic slots —
   `noun`, `docShape` (replacing the dead `processModel` flag), `template`,
   `extract` (absorbing the module-private `EXTRACTORS` map), `derive`
   (absorbing the `deriveProcess`/`deriveDecision` dispatch behind a generic
   `DerivedView` whose rich payloads live in `detail`), `refs`, and
   `graphHints` (unpinning the BPMN vocabulary in generic graph analyses).
   A descriptor with no slots still gets everything generic: live room,
   Monaco, discovery, listing, release, history. Notations are compiled in —
   adding one is a PR, not a runtime load.

2. **One boundary rule, CI-enforced.** The light descriptor data stays in
   `packages/notations/index.ts`, browser-safe and zero-dep — the
   `notations-index-and-derive-stay-browser-safe` dependency-cruiser rule
   survives verbatim. Behavior slots attach in Node-safe capability modules
   composed at the composition roots (live-host `server.ts`, validator CLI,
   web bootstrap), never as function values on the eagerly exported array:
   two of the three drafted designs failed exactly here (`fast-xml-parser`
   in the web bundle, `pnpm arch` red). **Checkers stay in
   `packages/validator`** behind one `checkModel` dispatch shared by the
   validator CLI and live-host `lintModel` — protecting the published
   `bpmiq-validate` binary, its near-zero-dep budget, and the
   never-executes-content-repo-code invariant. Nothing yjs-typed enters
   `packages/notations`.

3. **A cross-notation reference meta-model is the linking substrate.** Typed
   `Reference { from, rel, to, strength: required | informative }` emitted by
   a `refs` slot; a repo-wide `RepoIndex` with incoming/outgoing traversal;
   one generic dangling-ref rule replacing the bespoke id-set plumbing
   behavior-identically. This single mechanism powers link validation,
   `which_models_use`, backlink navigation, and a notation-agnostic
   reference-diff section in release PRs — it is what turns seven notations
   into one architecture tool. `ModelGraph` gains additive `parent`
   (containment), `layout`, and `edge.order` channels; it remains the floor
   for generic analyses, **not** the validation substrate (checkers keep
   parsing raw content with their rich models).

4. **Two doc shapes; boards never ride Y.Text.** `docShape: "text"` (today's
   contract, byte-identical — BPMN, DMN, Markdown, Wardley OWM, Team
   Topologies JSON) and `docShape: "structured"`: a Y.Map-of-Y.Maps element
   store plus a per-notation **deterministic codec** to canonical
   line-per-element text as the at-rest format — so git diff/PR review,
   sha256 compare-and-set, per-file history, validator input, and VS Code
   bytes all survive unchanged. Agent/REST writes reconcile element-wise;
   ordering uses fractional indices. The Y.Text route was rejected for
   boards on verified mechanics: the minimal-diff writer's single contiguous
   region makes any multi-element save conflict with every concurrent remote
   edit inside the span — last-writer-wins precisely in the workshop scenario
   the notations exist for. The structured contract ships **dark** (test-only
   descriptor through seed→edit→persist→history→release in CI) before the
   first board notation uses it.

5. **Editors are external modeler libraries behind a lazy browser registry.**
   A browser-only `WebNotationPlugin` registry (`mountEditor`, `panels`,
   `historyDiff`, `assistTool`; absent editor ⇒ collaborative Monaco)
   replaces the `isBpmn`/`isDmn` branches; bpmn-js/dmn-js become the first
   two plugins. Visual editors for further notations come from standalone
   Miragon modeler repos sharing one proven template (DOM-free schema-model
   with deterministic serialization, diagram-js renderer with an
   `additionalModules` hook, thin webapp/vscode shells):
   `wardley-maps-modeler` and `team-topologies-modeler` — whose formats
   already match the registry — and the Event Storming modeler built in the
   same manner (#116). Sync reuses their battle-tested webview recipe
   (echo suppression, serialized import chain, viewport preservation,
   last-good-diagram on invalid text) on top of the minimal-diff writer.

6. **Third-party runtime plugin loading is deferred, with a named trigger.**
   No versioned plugin-API semver gating, no boot-time npm loading, no
   browser `import()` of foreign editor bundles, no worker sandboxing — for
   now. The browser path has an unsolved correctness hazard (a runtime-loaded
   bundle carries its own yjs; yjs is single-instance by design, so a foreign
   editor creating Y types against host docs corrupts them), and the server
   path would trade the validator's compiled-in
   never-executes-content guarantee for machinery with zero current
   consumers. **Trigger to revisit:** a concrete external team wanting to
   ship a notation without a PR against this repo. Until then, the manifest
   idea survives only as cheap introspection: capabilities are listable
   without loading heavy code.

## Consequences

- **Migration is eight independently shippable steps** (epic #118): hygiene
  incl. the compound-extension stem fix (#119) → registry-driven discovery +
  generalized `bpmiq.yml` with per-mediaKind baseline validation (#120) →
  capability slots + `checkModel` (#121) → reference meta-model +
  `Finding.ruleId` (#122) → MCP factories + registry-driven tools (#123) →
  web plugin registry (#124) → mount the two existing modelers (#125) →
  structured doc shape dark launch (#126). 1→2→3 are sequential; 4/5/6
  parallelize after 3; 7 needs 2+6; 8 gates the Event Storming integration.
- **Wire and tool compatibility is preserved by aliasing**, never breaking:
  `processes:` stays valid in `bpmiq.yml`, existing MCP tool names/schemas
  are reproduced by the noun mechanism, existing link warnings keep their
  texts.
- **`@bpmiq/decisions` is untouched** and becomes the template for future
  per-notation semantics modules (variables/analyze/simulate/tests); the
  `.tests.yaml` sidecar framework is NOT generalized until a second
  executable-semantics notation exists.
- **Carve-out discipline:** when BPMN/DMN code eventually moves into
  per-notation packages, the shared view types (`DerivedDecision` et al.)
  must be extracted into a types-only module first — `@bpmiq/decisions`
  imports `notations/derive`, so a naive carve-out creates a workspace
  package cycle. The `one-bpmn-reader` and `bpmn-kinds-has-zero-imports`
  rules survive until that day because no BPMN code moves packages in
  steps 1–8.
- **Costs accepted:** the descriptor/capability split adds one indirection
  (composition-root wiring) per notation; the structured shape adds a second
  persistence branch in `collab.ts` (bounded by the codec contract and
  property-tested round-trips); per-notation editor packages pin exact
  versions of external libs.
- **Rejected alternatives:** a full plugin SDK now (speculative surface for
  zero consumers, the yjs single-instance flaw, biggest file-move churn —
  see Decision 6); boards on Y.Text with validity-gated imports (verified
  conflict mechanics, degrades to silent lost edits — Decision 4);
  centralizing checkers and yjs-typed codecs inside `packages/notations`
  (drags the rule corpus and a yjs runtime dep into the browser-reachable
  core and the published validator's graph — Decision 2); `ModelGraph` as
  the universal validation substrate (too lossy; the BPMN checker needs its
  rich reader — Decision 3).
