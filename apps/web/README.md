# @bpmiq/web

The collaborative web client of bpmiq — the SPA (bpmn-js / dmn-js / the Miragon
renderers + Monaco on a shared Y.Text, the repo overview) **and** the MCP-App
modeler widgets the Live Host serves inline in AI chats (claude.ai, Claude
Desktop, ChatGPT).

## Scripts

| Script                               | What it does                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @bpmiq/web dev`       | Vite dev server: the SPA, and every widget at `/mcp-app*.html` (raw boot marker → editable, this origin as the deep-link base). |
| `pnpm --filter @bpmiq/web build`     | The SPA plus **one single-file bundle per widget** into `dist/` (seven vite invocations, see below).                            |
| `pnpm --filter @bpmiq/web test`      | `node --test test/*.test.ts` — the DOM-free widget-core suites (lifecycle, live upgrade, engines).                              |
| `pnpm --filter @bpmiq/web typecheck` | `tsc --noEmit` over `src/` and `test/`.                                                                                         |

## The MCP-App widgets

Each widget is ONE self-contained HTML file (`dist/mcp-app*.html`: scripts, CSS
and, for bpmn/dmn, the icon font inlined) built by `vite.widget.config.ts`'s
factory from a 3-line `vite.mcp-app-<notation>.config.ts`. The Live Host
(`apps/live-host/src/http/mcp.ts`) serves it as a `ui://` resource behind an
`open_*` tool — a dist without a bundle simply lacks that tool.

| Bundle                        | Tool                          | Engine                                  |
| ----------------------------- | ----------------------------- | --------------------------------------- |
| `mcp-app.html`                | `open_modeler`                | bpmn-js (+ stickies, t.BPM, todos)      |
| `mcp-app-dmn.html`            | `open_decision_modeler`       | dmn-js + simulation (its own lifecycle) |
| `mcp-app-wardley.html`        | `open_wardley_modeler`        | `@miragon/wardley-renderer`             |
| `mcp-app-team-topology.html`  | `open_team_topology_modeler`  | `@miragon/team-topologies-renderer`     |
| `mcp-app-event-storming.html` | `open_event_storming_modeler` | `@miragon/event-storming-renderer`      |
| `mcp-app-context-map.html`    | `open_context_map_modeler`    | `@miragon/context-maps-renderer`        |

**One lifecycle.** The canvas widgets share `src/mcp-app/core/`: `lifecycle.ts`
(tool input → load via `get_model_content` → engine → debounced CAS autosave via
`save_model_content` with `lint:"warn"` → the conflict banner → the newest-widget
claim → the progressive live upgrade → the post-outage reconcile), `live.ts` (the
single-use ws ticket + Yjs session) and `widget.ts` (the DOM composition:
`bootWidget(spec)`). A notation contributes an **engine adapter**
(`src/mcp-app/engines/*.ts`) against the contract in `core/engine.ts` —
`importText` / `exportText` / `onDirty` / optional `selectedElementId` /
optional `bindLive` — plus a `WidgetSpec` in a ~6-line entry (`<notation>-main.ts`).
Two engine invariants the core relies on: `importText` never fires `onDirty` (the
Miragon DSL renderers emit `commandStack.changed` from their own `clear()` —
`engines/dsl.ts` suppresses the echo), and `bindLive` is a capability (absent =
CAS autosave only). Full behaviour: [docs/mcp-integration.md](../../docs/mcp-integration.md).

**One engine per bundle.** The iframe sandbox allows no external requests, so
nothing is shared between the emitted files — and exactly one engine per file is
also the widgets' whole CSS scoping: the SPA's postcss vendor-CSS scoping is
deliberately absent here. Never bundle two engines (or bpmn-js next to a Miragon
sheet) into one widget.

**Read-only hosts** (`LIVE_MCP_READONLY=1` on the Live Host) mount each engine's
`NavigatedViewer`; for the wardley and event-storming renderers with an inert
`commandStack` value module (`engines/diagram-js.ts` — their import clears a stack
only the Modeler registers).

### Adding a notation widget

1. An engine adapter in `src/mcp-app/engines/<notation>.ts` (`mountDslEngine`
   covers the Miragon DSL renderers; see `team-topology.ts` for a JSON one).
2. An entry `src/mcp-app/<notation>-main.ts` (`bootWidget({ notation, noun, engine })`),
   its stylesheet `<notation>-styles.css` (the vendor sheet + `chrome.css`) and
   the HTML `mcp-app-<notation>.html` (the chrome skeleton of `mcp-app-wardley.html`,
   the boot-marker line verbatim — `shell.ts`'s `mountChrome` names the ids).
3. `vite.mcp-app-<notation>.config.ts` and one more `&& vite build --config …`
   segment in `package.json`'s `build`.
4. The notation id in `GENERATED_WIDGET_NOTATIONS` (`apps/live-host/src/http/mcp.ts`)
   — the tool, its description and its resource derive from the registry
   descriptor (`@bpmiq/contracts/mcp-app` names the tool) and the test stubs
   follow `WIDGET_FILES`; the two literal tool-list pins in
   `apps/live-host/test/mcp.test.ts` gain the new name (on purpose — a new tool
   shows up in a reviewed diff).
5. `docs/mcp-integration.md` (tool table + the widgets section).

### Mixed deployments

The widgets and the Live Host ship in one image. A web dist newer than a
pre-#160 Live Host has no `get_model_content` and fails its first load with
"Tool get_model_content not found" — there is no fallback on purpose.
