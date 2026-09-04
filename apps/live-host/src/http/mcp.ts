/**
 * The Live Host's MCP endpoint — AI clients talk to the LIVE platform state
 * through the same application use-cases the REST routes call, in-process.
 * Mounted at POST /mcp by api.ts (which authenticates first: session id, dev
 * token or OIDC JWT — one auth surface for humans and agents).
 *
 * Stateless Streamable HTTP on the official SDK, one fresh McpServer per
 * request (the pattern of packages/mcp/http.ts): tools close over the CALLER's
 * session, so per-repo authorization runs per tool call — there is no warm
 * state a different principal could ever be handed.
 *
 * Write path: save_bpmn_xml REQUIRES the baseVersion from a prior get — the
 * compare-and-set lives in application/content.ts; a stale token returns the
 * current XML as a retryable result (not an error), so agents re-derive and
 * retry. All validation (BPMN structure, BPMNDI coverage, size cap) is
 * enforced server-side in the use-case, never only here.
 *
 * Todos (list/create/close) ride the IssueTracker port — model-anchored work
 * items live in the customer's OWN tracker, never in a platform database. The
 * tools register only when the platform HAS tracker credentials, so an agent's
 * tools/list tells it the truth instead of failing at call time.
 *
 * LIVE_MCP_READONLY=1 (opts.mcpReadOnly) registers no write tools at all —
 * absent from tools/list, not erroring (agents plan against reality).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { fileDeepLink, processDeepLink } from "@bpmiq/contracts/deep-link";
import { roomName } from "@bpmiq/contracts/live";
import type { ContentConflictWire, TodoWire, WidgetBootWire } from "@bpmiq/contracts/live-host";
import { mcpAppToolName } from "@bpmiq/contracts/mcp-app";
import { analyzeDecision, simulateDecision } from "@bpmiq/decisions";
import { parseTestSuite, type TestCase, testsPathFor } from "@bpmiq/decisions/tests";
import { fail, ok, READ, safe, WRITE } from "@bpmiq/mcp-kit";
import { mountStatelessMcp } from "@bpmiq/mcp-kit/mount";
import { byExtension, byId, modelStem, NOTATIONS } from "@bpmiq/notations";
import { deriveDecision, deriveProcess, deriveView, hasDeriver } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";
import { hasTemplate } from "@bpmiq/notations/templates";
import { checkModel } from "@bpmiq/validator";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Session } from "../adapters/sqlite/sessions.ts";
import { authorizeRepo } from "../application/authz.ts";
import { type ContentDeps, getContent, putContent } from "../application/content.ts";
import { readDecisionTests, runTestsFor, saveTestsFor } from "../application/decision-tests.ts";
import { findDecisionPath, findModelPath, findProcessPath } from "../application/find-model.ts";
import {
  decisionUsers,
  listAllModels,
  listChanges,
  listDecisions,
  listProcesses,
  listRepos,
  type OverviewDeps,
} from "../application/overview.ts";
import { createDecision, createNotationModel, createProcess } from "../application/scaffold.ts";
import { closeTodoFor, fileTodo } from "../application/todos.ts";
import type { WsTicketStore } from "../application/ws-tickets.ts";
import type { GitProvider } from "../ports/git-provider.ts";
import type { IssueTracker } from "../ports/issue-tracker.ts";
import { release, type ReleaseDeps, releaseFiles } from "../release.ts";
import { discoverModels, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

/** everything the tools need — ApiOptions satisfies this structurally (the
 *  house DI convention), declared here so http/mcp.ts and http/api.ts share no
 *  import cycle */
export type McpDeps = OverviewDeps &
  ContentDeps &
  ReleaseDeps & {
    providers: Map<string, GitProvider>;
    github: GitProvider;
    /** issue-tracker seam (model-anchored todos) — absent when the platform has
     * no credentials to act on the tracker; the todo tools then do not register */
    issues?: IssueTracker;
    mcpReadOnly?: boolean;
    /** built web assets — the MCP-App widgets (WIDGET_FILES, one single-file
     *  bundle per modeler) are read from here */
    webDist: string;
    /** the host's public URL — the widget derives its ws endpoint from it */
    publicUrl: string;
    /** ws tickets for the widget's live Yjs connection — absent = no live mode */
    wsTickets?: WsTicketStore;
  };

// tool result codec: @bpmiq/mcp-kit — safe() runs WITHOUT a prefix here, the
// AppErrors from the use-cases carry actionable, agent-readable messages
// (validation findings, conflict guidance, authz denials)

// ── MCP-App widgets (the embedded modelers) ──────────────────────────────────
// The single-file HTML files built by apps/web (vite.mcp-app*.config.ts), one
// per WidgetSpec below (WIDGET_SPECS). Read once per process, memoised —
// a fresh McpServer per request must not mean a disk read per POST. The hash
// rides in the ui:// URI so a redeploy busts whatever cache the host keeps
// (its cadence is undocumented).
export interface Widget {
  html: string;
  uri: string;
}
const widgetCache = new Map<string, Widget | null>();
/** `configSalt` folds the served-time boot payload into the uri hash: hosts
 *  cache resources BY URI, so a config-only change (LIVE_PUBLIC_URL migration,
 *  the readonly flip) must mint a new uri or cached widgets keep booting with
 *  the stale payload until the web dist itself changes. */
function loadWidget(webDist: string, file: string, name: string, configSalt: string): Widget | undefined {
  // webDist is part of the key too: production has one dist per process, but
  // the test suite hands every server its own tmp dist — a widget absent from
  // one must never be answered from another's memo
  const key = `${webDist}\0${file}\0${configSalt}`;
  const cached = widgetCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let html: string;
  try {
    html = readFileSync(join(webDist, file), "utf8");
  } catch {
    // web dist without this widget (older build) — /mcp works, just without it
    widgetCache.set(key, null);
    return undefined;
  }
  const hash = createHash("sha256").update(html).update("\0").update(configSalt).digest("hex").slice(0, 8);
  const widget = { html, uri: `ui://bpmiq/${name}-${hash}.html` };
  widgetCache.set(key, widget);
  return widget;
}

// ── input shapes (zod v4 raw shapes, ported from the retired apps/live-mcp) ──
const repoArg = z.string().describe("repository full name, 'owner/repo'");
const processRef = {
  repo: repoArg,
  id: z.string().optional().describe("process id = BPMN file stem (from list_processes)"),
  path: z.string().optional().describe("repo-relative BPMN path (alternative to id; needed for sub-processes)"),
};
const decisionRef = {
  repo: repoArg,
  id: z.string().optional().describe("decision id = DMN file stem (from list_decisions)"),
  path: z.string().optional().describe("repo-relative DMN path (alternative to id)"),
};
/** a model of ANY notation: id (= file stem) or path, `notation` to pick one
 *  when a stem is shared across notations (bpmn wins without it) */
const modelRef = {
  repo: repoArg,
  id: z.string().optional().describe("model id = file stem (from list_models)"),
  path: z.string().optional().describe("repo-relative model path (alternative to id)"),
  notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
};
/** the id-or-path half of every ref shape (repo is resolved separately) */
type RefArgs = { id?: string; path?: string; notation?: string };
/** every notation id the registry knows — tool copy lists them from here */
const NOTATION_IDS = NOTATIONS.map((n) => n.id).join(", ");
/** the notations a blank model can be created for (templates.ts) */
const CREATABLE_IDS = NOTATIONS.filter((n) => hasTemplate(n.id))
  .map((n) => n.id)
  .join(", ");

// ── MCP-App widgets: the static half of a registry row — DATA, module-level,
// so the test suite's stub list (WIDGET_FILES) derives from the SAME list the
// server registers from (the tool-list pins there stay literal on purpose: a
// new row must show up in a reviewed diff). The per-server half (how a call
// resolves, links and summarises) lives inside createLiveMcpServer. ─────────
interface WidgetSpec {
  /** registry notation id — the generated rows resolve `id` WITH it
   *  (findModelPath is bpmn-first without it) */
  notation: string;
  /** the widget upgrades to live co-editing (mint_ws_ticket is registered for
   *  the served widgets that do; the DMN widget deliberately never mints) */
  live: boolean;
  /** apps/web/dist/<file> — apps/web/package.json's build chain emits it */
  file: string;
  /** `ui://bpmiq/<name>-<hash8>.html` (the tests pin the prefix) */
  name: string;
  /** open_modeler / open_decision_modeler are wire-pinned; the rest come from
   *  mcpAppToolName (@bpmiq/contracts/mcp-app — the SPA's assist prompt
   *  derives the same name) */
  tool: string;
  description: string;
  /** processRef / decisionRef(+scenario) for the pinned twins (unchanged
   *  wire), a noun-worded {repo, id?, path?} when generated */
  inputSchema: z.ZodRawShape;
}

const BPMN_WIDGET: WidgetSpec = {
  notation: "bpmn",
  live: true,
  file: "mcp-app.html",
  name: "modeler",
  tool: "open_modeler",
  description:
    "Open the interactive BPMN modeler widget for a process. Renders an embedded diagram " +
    "editor in MCP-Apps-capable clients (claude.ai, Claude Desktop) — including the process's " +
    "todos, with a badge on every anchored element; other clients get a " +
    "text summary — use get_process/get_bpmn_xml there instead. The result's " +
    "`opened.url` links the same model in the full bpmiq web modeler.",
  inputSchema: processRef,
};
const DMN_WIDGET: WidgetSpec = {
  notation: "dmn",
  live: false,
  file: "mcp-app-dmn.html",
  name: "decision-modeler",
  tool: "open_decision_modeler",
  description:
    "Open the interactive DMN decision modeler widget: the decision table plus a SIMULATOR — " +
    "enter values, see which rules match. Pass `scenario` (variable → value, like " +
    "simulate_decision's `given`) to open it with that case already applied and highlighted, " +
    "which is how to SHOW someone a failing case instead of describing it. The widget also " +
    "runs and captures the decision's test cases. Non-apps clients get a text summary — use " +
    "get_decision / simulate_decision there. The result's `opened.url` links the same " +
    "decision in the bpmiq web app.",
  inputSchema: {
    ...decisionRef,
    scenario: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("input values to pre-fill the simulator with, keyed by variable name"),
  },
};
/** the notations whose widget rides the widget core (apps/web/src/mcp-app/core).
 *  Adding one = this id + the engine adapter + the build entry in apps/web. */
const GENERATED_WIDGET_NOTATIONS = ["wardley", "team-topology", "event-storming", "context-map"] as const;
/** a core-based widget: everything derives from the descriptor */
const generatedWidget = (id: string): WidgetSpec => {
  const n = byId(id);
  // a typo here must fail the boot, not surface as a phantom tool at call time
  if (!n) throw new Error(`widget registry: unknown notation '${id}'`);
  const noun = n.noun.singular;
  return {
    notation: n.id,
    live: true,
    file: `mcp-app-${n.id}.html`,
    name: `${n.id}-modeler`,
    tool: mcpAppToolName(n.id),
    description:
      `Open the interactive ${n.label} modeler widget for a ${noun} (${n.extensions.join("/")}). Renders the ` +
      "canvas inline in MCP-Apps-capable clients (claude.ai, Claude Desktop): edits save through the same " +
      "validated, conflict-guarded path as save_model_content and upgrade to live co-editing where the host " +
      "allows the socket. Other clients get a text summary — use get_view / get_model_content there. The " +
      `result's \`opened.url\` links the same ${noun} in the bpmiq web app.`,
    inputSchema: {
      repo: repoArg,
      id: z.string().optional().describe(`${noun} id = file stem (from list_models)`),
      path: z.string().optional().describe(`repo-relative ${noun} path (alternative to id)`),
    },
  };
};
const WIDGET_SPECS: readonly WidgetSpec[] = [
  BPMN_WIDGET,
  DMN_WIDGET,
  ...GENERATED_WIDGET_NOTATIONS.map(generatedWidget),
];
/** the dist files the widgets live in — test/mcp.test.ts writes its stubs from this list */
export const WIDGET_FILES: readonly string[] = WIDGET_SPECS.map((w) => w.file);

/** one test case of a decision suite — the wire shape of `<stem>.tests.yaml` */
const testCaseSchema = z.object({
  name: z.string().describe("what this case is about, in the team's own words"),
  given: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe("input values keyed by variable name"),
  expect: z
    .object({
      value: z.unknown().optional().describe("the decision's expected result (null = no rule matches)"),
      rules: z
        .array(z.string())
        .optional()
        .describe("rule ids that MUST fire — catches a right answer for the wrong reason"),
      decisions: z
        .record(z.string(), z.object({ value: z.unknown().optional(), rules: z.array(z.string()).optional() }))
        .optional()
        .describe("expectations per decision, for chained DRDs"),
    })
    .optional()
    .describe("omit to record the current behaviour instead (golden master)"),
});
const testCasesArg = z.array(testCaseSchema);
type TestCaseArg = z.infer<typeof testCaseSchema>;

/** the process a model path belongs to — id IS the file stem (the content
 *  contract, @bpmiq/notations/content), so a path always names its process */
const processIdOf = modelStem;
/** the decision id of a .dmn path — the same file-stem rule */
const decisionIdOf = modelStem;

/** stands in for the path of a caller-supplied (unsaved) model */
const PROVIDED = "<provided xml>";

/**
 * A per-capability tool contribution — the composition hook capability modules
 * (the @bpmiq/decisions pattern) plug their live tools into. Contributions run
 * AFTER the core registration, against the same deps and caller session; the
 * decision-semantics quartet migrates onto this hook once a second semantics
 * module exists (epic #118 — the same restraint as the sidecar-test framework).
 *
 * Contributions run regardless of LIVE_MCP_READONLY — a contribution that
 * registers WRITE tools must gate them on deps.mcpReadOnly itself, exactly
 * like the core registration does.
 */
export type LiveToolContribution = (server: McpServer, deps: McpDeps, session: Session) => void;

export function createLiveMcpServer(
  opts: McpDeps,
  session: Session,
  contributions: readonly LiveToolContribution[] = [],
): McpServer {
  const server = new McpServer({ name: "bpmiq-live", version: "1.0.0" });

  /** registry 404 + per-repo write authz — the shared application-layer gate;
   *  safe() surfaces the AppError message to the agent verbatim */
  const requireRepo = (fullName: string): Promise<ConnectedRepo> => authorizeRepo(opts, session, fullName);

  const resolveBpmnPath = async (repo: ConnectedRepo, id?: string, path?: string): Promise<string> => {
    if (path) return path;
    if (!id) throw new Error("provide either `id` or `path`.");
    return findProcessPath(opts, repo, id);
  };

  /** the .dmn sibling of resolveBpmnPath (id = decision file stem) */
  const resolveDmnPath = async (repo: ConnectedRepo, id?: string, path?: string): Promise<string> => {
    if (path) return path;
    if (!id) throw new Error("provide either `id` or `path`.");
    return findDecisionPath(opts, repo, id);
  };

  /** ANY notation: a path wins, an id resolves through the registry-wide
   *  discovery (bpmn-first on a shared stem unless `notation` says otherwise) */
  const resolveModelPath = async (repo: ConnectedRepo, a: RefArgs): Promise<string> => {
    if (a.path) return a.path;
    if (!a.id) throw new Error("provide either `id` or `path`.");
    return findModelPath(opts, repo, a.id, a.notation);
  };

  /** repo-wide model ids per notation — the link-check context of checkModel
   *  (the same aggregation the save gate runs); undefined without a repo */
  const repoModelIds = async (repo?: string): Promise<Map<string, Set<string>> | undefined> => {
    if (!repo) return undefined;
    const r = await requireRepo(repo);
    const workspace = await opts.workspaces.ensure(r);
    const cfg = loadContentConfig(workspace);
    if (!cfg) return undefined;
    const modelIds = new Map<string, Set<string>>();
    for (const m of await discoverModels(workspace, cfg)) {
      (modelIds.get(m.notation) ?? modelIds.set(m.notation, new Set()).get(m.notation)!).add(m.id);
    }
    return modelIds;
  };

  /** parse a .dmn into the decision view — one message for every "not DMN" case.
   *  A caller-supplied XML has no path (PROVIDED): address the extractor by
   *  notation id. A REAL path must still resolve to DMN by its extension, so a
   *  .bpmn handed to a decision tool is refused instead of silently deriving
   *  an empty decision. */
  const decisionViewOf = (path: string, xml: string) => {
    const graph = extractModelGraph(path === PROVIDED ? "dmn" : path, xml);
    if (!graph || graph.notation !== "dmn") throw new Error(`not a DMN model: ${path}`);
    return deriveDecision(graph);
  };

  /** the DMN a simulation/analysis runs on: an explicit `xml` (dry run, no repo
   *  needed — the validate_bpmn pattern) or the LIVE document of a decision */
  const dmnSource = async (
    repo?: string,
    id?: string,
    path?: string,
    xml?: string,
  ): Promise<{ view: ReturnType<typeof decisionViewOf>; at: { path: string | null; baseVersion?: string } }> => {
    if (xml !== undefined) {
      return { view: decisionViewOf(path ?? PROVIDED, xml), at: { path: path ?? null } };
    }
    if (!repo) throw new Error("provide `repo` (with `id` or `path`), or an explicit `xml` to dry-run.");
    const r = await requireRepo(repo);
    const content = await getContent(opts, r, await resolveDmnPath(r, id, path));
    return {
      view: decisionViewOf(content.path, content.content),
      at: { path: content.path, baseVersion: content.baseVersion },
    };
  };

  // ── notation-twin tool factories: the BPMN and DMN tools differ only in the
  // tool name, the description nouns, the resolver and the wire key — one
  // factory per pair keeps the schemas (incl. describe() strings) from
  // drifting (save_dmn_xml arrived as 46 byte-identical lines of its twin) ───
  const lintArg = z
    .enum(["block", "warn"])
    .optional()
    .describe(
      "default 'block': ERROR findings refuse the save — keep it for agent edits. " +
        "'warn' saves anyway and returns findings (the modeler widget's autosave).",
    );

  /** the stale-baseVersion result every save tool answers — retryable data,
   *  not an error. `currentContent` is THE payload field (#154); the legacy key
   *  (`currentXml` on the bpmn/dmn saves, `currentYaml` on the sidecar save)
   *  rides along as a deprecated alias for one release — the generic save was
   *  born without one. */
  const conflictResult = (c: ContentConflictWire, legacyKey?: "currentXml" | "currentYaml") =>
    ok({
      ok: false,
      conflict: true,
      path: c.path,
      currentContent: c.currentContent,
      ...(legacyKey ? { [legacyKey]: c.currentContent } : {}),
      baseVersion: c.baseVersion,
      message: c.error,
    });

  const registerGetContentTool = (cfg: {
    name: string;
    description: string;
    ref: typeof processRef | typeof modelRef;
    resolve: (r: ConnectedRepo, a: RefArgs) => Promise<string>;
    /** the bpmn/dmn twins keep the deprecated `xml` alias on their result for
     *  one release (#154); the generic tool never carried it */
    legacyAlias: boolean;
  }): void => {
    server.registerTool(
      cfg.name,
      { description: cfg.description, inputSchema: cfg.ref, annotations: READ },
      safe(async ({ repo, ...ref }: { repo: string } & RefArgs) => {
        const r = await requireRepo(repo);
        const { xml: _legacy, ...content } = await getContent(opts, r, await cfg.resolve(r, ref));
        return ok(cfg.legacyAlias ? { ...content, xml: _legacy } : content);
      }),
    );
  };

  const registerCreateTool = <T>(cfg: {
    name: string;
    /** wire key of the created row AND the audit-log noun */
    what: "process" | "decision";
    description: string;
    create: (r: ConnectedRepo, workspace: string, body: { name: string; folder?: string }) => Promise<T>;
    pathOf: (created: T) => string;
  }): void => {
    server.registerTool(
      cfg.name,
      {
        description: cfg.description,
        inputSchema: {
          repo: repoArg,
          name: z.string().describe("human title; the file stem is its kebab-case slug"),
          folder: z.string().optional().describe("target folder relative to the processes root"),
        },
        annotations: WRITE,
      },
      safe(async ({ repo, name, folder }: { repo: string; name: string; folder?: string }) => {
        const r = await requireRepo(repo);
        const workspace = await opts.workspaces.ensure(r);
        const created = await cfg.create(r, workspace, { name, folder });
        console.log(`${cfg.what} created in ${r.fullName} by @${session.user.login} via mcp: ${cfg.pathOf(created)}`);
        return ok({ [cfg.what]: created });
      }),
    );
  };

  const registerSaveTool = (cfg: {
    name: string;
    description: string;
    ref: typeof processRef | typeof modelRef;
    /** the payload argument: `xml` on the wire-pinned bpmn/dmn twins, `content`
     *  on the generic save (#154) */
    payloadKey: "xml" | "content";
    payloadDoc: string;
    baseVersionDoc: string;
    resolve: (r: ConnectedRepo, a: RefArgs) => Promise<string>;
    /** deprecated conflict alias the twins still emit; none on the generic save */
    legacyConflictKey?: "currentXml";
  }): void => {
    server.registerTool(
      cfg.name,
      {
        description: cfg.description,
        inputSchema: {
          ...cfg.ref,
          [cfg.payloadKey]: z.string().describe(cfg.payloadDoc),
          baseVersion: z.string().describe(cfg.baseVersionDoc),
          lint: lintArg,
        },
        annotations: WRITE,
      },
      safe(
        async ({
          repo,
          baseVersion,
          lint,
          ...rest
        }: {
          repo: string;
          baseVersion: string;
          lint?: "block" | "warn";
        } & RefArgs &
          Partial<Record<"xml" | "content", string>>) => {
          const r = await requireRepo(repo);
          const text = rest[cfg.payloadKey] ?? "";
          const out = await putContent(opts, r, await cfg.resolve(r, rest), { content: text, baseVersion, lint });
          if (!out.ok) return conflictResult(out.conflict, cfg.legacyConflictKey);
          console.log(`content saved: ${r.fullName}/${out.result.path} by @${session.user.login} via mcp`);
          return ok({ ok: true, ...out.result });
        },
      ),
    );
  };

  server.registerTool(
    "list_repos",
    {
      description:
        "List the repositories you can access on this Live Host, with permission and model counts (processes + decisions).",
      annotations: READ,
    },
    safe(async () => ok({ repos: await listRepos(opts, session) })),
  );

  server.registerTool(
    "list_processes",
    {
      description: "List the BPMN processes in a repository (id, name, path, dirty flag, live session count).",
      inputSchema: { repo: repoArg },
      annotations: READ,
    },
    safe(async ({ repo }: { repo: string }) => {
      const r = await requireRepo(repo);
      const workspace = await opts.workspaces.ensure(r);
      return ok({ processes: await listProcesses(opts, r, workspace) });
    }),
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List EVERY model file of the repository, grouped by notation (bpmn, dmn, wardley, " +
        "team-topology, …) — the registry-wide superset of list_processes/list_decisions. " +
        "Each row: id (file stem), path, dirty flag, live session count.",
      inputSchema: { repo: repoArg },
      annotations: READ,
    },
    safe(async ({ repo }: { repo: string }) => {
      const r = await requireRepo(repo);
      const workspace = await opts.workspaces.ensure(r);
      const models = await listAllModels(opts, r, workspace);
      const grouped: Record<string, typeof models> = {};
      for (const m of models) (grouped[m.notation] ??= []).push(m);
      return ok({ models: grouped });
    }),
  );

  server.registerTool(
    "get_process",
    {
      description:
        "Derived process view (name, roles from lanes, steps, flow, sub-process calls) from the LIVE BPMN — " +
        "the same shape the read-only content-repo MCP server derives.",
      inputSchema: processRef,
      annotations: READ,
    },
    safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
      const r = await requireRepo(repo);
      const bpmnPath = await resolveBpmnPath(r, id, path);
      const content = await getContent(opts, r, bpmnPath);
      const graph = extractModelGraph(content.path, content.content);
      if (!graph) return fail(`could not derive a process view from ${content.path}.`);
      return ok({ id: id ?? null, path: content.path, baseVersion: content.baseVersion, ...deriveProcess(graph) });
    }),
  );

  server.registerTool(
    "get_view",
    {
      description:
        "The derived view of ANY live model — its own name, a one-line summary, stats, and the " +
        "rich notation payload in `detail` where one exists. The notation-agnostic sibling of " +
        "get_process/get_decision: works for every notation with extract+derive capabilities " +
        `(${NOTATIONS.filter((n) => hasDeriver(n.id))
          .map((n) => n.id)
          .join(", ")}).`,
      inputSchema: {
        repo: repoArg,
        id: z.string().optional().describe("model id = file stem (from list_models)"),
        path: z.string().optional().describe("repo-relative model path (alternative to id)"),
        notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
      },
      annotations: READ,
    },
    safe(async ({ repo, id, path, notation }: { repo: string; id?: string; path?: string; notation?: string }) => {
      const r = await requireRepo(repo);
      const content = await getContent(opts, r, await resolveModelPath(r, { id, path, notation }));
      const graph = extractModelGraph(content.path, content.content);
      const view = graph && deriveView(graph);
      if (!view) return fail(`no derived view for ${content.path} — the notation has no extract/derive capability.`);
      // id from the RESOLVED path — a caller-supplied id must not ride along
      // verbatim when a conflicting `path` won the resolution
      return ok({ id: modelStem(content.path), path: content.path, baseVersion: content.baseVersion, ...view });
    }),
  );

  registerGetContentTool({
    name: "get_bpmn_xml",
    description:
      "The current LIVE BPMN XML of a process plus the baseVersion token save_bpmn_xml requires " +
      "for conflict-safe writes.",
    ref: processRef,
    resolve: (r, a) => resolveBpmnPath(r, a.id, a.path),
    legacyAlias: true,
  });

  server.registerTool(
    "validate_bpmn",
    {
      description:
        "Dry-run the platform validator on BPMN XML WITHOUT writing anything — structure, BPMNDI " +
        "coverage, callActivity links (against the repo's processes when `repo` is given). " +
        "Iterate here until ok before calling save_bpmn_xml.",
      inputSchema: {
        xml: z.string().describe("the complete BPMN XML to check"),
        repo: repoArg.optional(),
        path: z.string().optional().describe("repo-relative path, used to label findings"),
      },
      annotations: READ,
    },
    safe(async ({ xml, repo, path }: { xml: string; repo?: string; path?: string }) => {
      // THE one check dispatch (incl. the generic dangling-reference rule) —
      // the same path the CLI and the save gate run, so all three agree
      const modelIds = await repoModelIds(repo);
      const findings = checkModel(xml, { path: path ?? "<bpmn>", notation: "bpmn", modelIds }) ?? [];
      return ok({ ok: !findings.some((f) => f.severity === "ERROR"), findings });
    }),
  );

  // ── ANY notation: the generic model tools (#155). ONE set for the whole
  // registry beside the wire-pinned bpmn/dmn twins — ids resolve registry-
  // wide (bpmn-first on a shared stem, `notation` picks another); the text
  // travels as `content` in the notation's own format. ───────────────────

  registerGetContentTool({
    name: "get_model_content",
    description:
      `The current LIVE text of a model of ANY notation (${NOTATION_IDS}) plus the baseVersion token ` +
      "save_model_content requires for conflict-safe writes — the notation-agnostic sibling of " +
      "get_bpmn_xml/get_dmn_xml. Read get_view first when you need the derived structure, not the source.",
    ref: modelRef,
    resolve: resolveModelPath,
    legacyAlias: false,
  });

  server.registerTool(
    "validate_model",
    {
      description:
        "Dry-run the platform validator on the text of a model of ANY notation WITHOUT writing anything — " +
        "the same check the save gate and `pnpm validate` run (structure + DI coverage for the XML " +
        "notations, the baseline parse for the others, dangling references against the repo's models " +
        "when `repo` is given). The notation comes from `path`'s extension or an explicit `notation`. " +
        "Iterate here until ok before calling save_model_content.",
      inputSchema: {
        content: z.string().describe("the complete document text to check"),
        repo: repoArg.optional(),
        path: z
          .string()
          .optional()
          .describe("repo-relative path — selects the notation by extension and labels findings"),
        notation: z
          .string()
          .optional()
          .describe(`registry notation id (${NOTATION_IDS}) — required when \`path\` has no registered extension`),
      },
      annotations: READ,
    },
    safe(
      async ({
        content,
        repo,
        path,
        notation,
      }: {
        content: string;
        repo?: string;
        path?: string;
        notation?: string;
      }) => {
        const modelIds = await repoModelIds(repo);
        const findings = checkModel(content, { path: path ?? `<${notation ?? "model"}>`, notation, modelIds });
        if (!findings) {
          return fail(
            `no registered notation for ${path ? `'${path}'` : "the payload"} — pass \`notation\` (one of: ${NOTATION_IDS}).`,
          );
        }
        return ok({ ok: !findings.some((f) => f.severity === "ERROR"), findings });
      },
    ),
  );

  // ── DMN decisions: the .dmn sibling of the process tools. A decision IS a
  // .dmn file (id = file stem), so every tool takes the same id-or-path ref. ──

  server.registerTool(
    "list_decisions",
    {
      description: "List the DMN decisions in a repository (id, name, path, dirty flag, live session count).",
      inputSchema: { repo: repoArg },
      annotations: READ,
    },
    safe(async ({ repo }: { repo: string }) => {
      const r = await requireRepo(repo);
      const workspace = await opts.workspaces.ensure(r);
      return ok({ decisions: await listDecisions(opts, r, workspace) });
    }),
  );

  server.registerTool(
    "get_decision",
    {
      description:
        "Derived decision view from the LIVE DMN: every decision with its hit policy, input/output columns " +
        "and rules (FEEL source text, `when`/`then` aligned to the columns), plus the DRD wiring " +
        "(input data and required decisions). Read this instead of the XML to reason about the logic.",
      inputSchema: decisionRef,
      annotations: READ,
    },
    safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
      const r = await requireRepo(repo);
      const dmnPath = await resolveDmnPath(r, id, path);
      const content = await getContent(opts, r, dmnPath);
      const decisionId = id ?? decisionIdOf(content.path);
      const workspace = await opts.workspaces.ensure(r);
      return ok({
        id: decisionId,
        path: content.path,
        baseVersion: content.baseVersion,
        ...decisionViewOf(content.path, content.content),
        // the impact side: which processes delegate to this decision
        usedBy: await decisionUsers(workspace, decisionId),
      });
    }),
  );

  registerGetContentTool({
    name: "get_dmn_xml",
    description:
      "The current LIVE DMN XML of a decision plus the baseVersion token save_dmn_xml requires " +
      "for conflict-safe writes.",
    ref: decisionRef,
    resolve: (r, a) => resolveDmnPath(r, a.id, a.path),
    legacyAlias: true,
  });

  server.registerTool(
    "simulate_decision",
    {
      description:
        "Run one scenario through a decision and report WHICH RULES FIRED. `given` is keyed by variable " +
        "name (from get_decision/analyze_decision — the input expressions, not the column labels). " +
        "Evaluates the whole DRD in dependency order, so chained decisions come back one by one with " +
        "their matched rule ids, outputs and any hit-policy violation. Unknown or missing keys are " +
        "reported instead of silently matching nothing. Nothing is written; pass `xml` to try an edit " +
        "you have not saved yet.",
      inputSchema: {
        repo: repoArg.optional(),
        id: z.string().optional().describe("decision id = DMN file stem (from list_decisions)"),
        path: z.string().optional().describe("repo-relative DMN path (alternative to id)"),
        given: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe('input values keyed by variable name, e.g. {"kundentyp":"stamm","bestellwert":500}'),
        xml: z.string().optional().describe("simulate THIS DMN instead of the stored one (dry run)"),
      },
      annotations: READ,
    },
    safe(
      async ({
        repo,
        id,
        path,
        given,
        xml,
      }: {
        repo?: string;
        id?: string;
        path?: string;
        given: Record<string, string | number | boolean | null>;
        xml?: string;
      }) => {
        const source = await dmnSource(repo, id, path, xml);
        return ok({ ...source.at, ...simulateDecision(source.view, given) });
      },
    ),
  );

  server.registerTool(
    "analyze_decision",
    {
      description:
        "Static analysis of a decision — everything wrong with it that needs NO test data: FEEL that " +
        "does not parse (the engine treats it as 'did not match', so it is otherwise invisible), rules " +
        "that can never fire or violate the hit policy, requirements whose variable nothing reads, " +
        "cycles. Also returns, per variable, the literals and numeric boundaries its rules use — the " +
        "raw material for writing test cases. Pass `xml` to check an unsaved edit.",
      inputSchema: {
        repo: repoArg.optional(),
        id: z.string().optional().describe("decision id = DMN file stem (from list_decisions)"),
        path: z.string().optional().describe("repo-relative DMN path (alternative to id)"),
        xml: z.string().optional().describe("analyze THIS DMN instead of the stored one (dry run)"),
      },
      annotations: READ,
    },
    safe(async ({ repo, id, path, xml }: { repo?: string; id?: string; path?: string; xml?: string }) => {
      const source = await dmnSource(repo, id, path, xml);
      return ok({ ...source.at, ...analyzeDecision(source.view) });
    }),
  );

  server.registerTool(
    "run_decision_tests",
    {
      description:
        "Run a decision's test cases — the versioned suite in '<decision>.tests.yaml' next to the model, " +
        "or the `cases` you pass in (a trial run that saves nothing). Reports per case pass/fail/pending " +
        "with the value it actually produced, plus RULE COVERAGE: which rules no case ever made decide " +
        "the outcome. A decision without a suite comes back empty and passing — check uncoveredRules.",
      inputSchema: {
        ...decisionRef,
        cases: testCasesArg.optional().describe("run THESE cases instead of the stored suite (nothing is saved)"),
        xml: z.string().optional().describe("test THIS DMN instead of the stored one (dry run)"),
      },
      annotations: READ,
    },
    safe(
      async ({
        repo,
        id,
        path,
        cases,
        xml,
      }: {
        repo: string;
        id?: string;
        path?: string;
        cases?: TestCaseArg[];
        xml?: string;
      }) => {
        const r = await requireRepo(repo);
        const dmnPath = await resolveDmnPath(r, id, path);
        const content = xml === undefined ? await getContent(opts, r, dmnPath) : undefined;
        const view = decisionViewOf(dmnPath, xml ?? content?.xml ?? "");
        return ok({
          decisionPath: dmnPath,
          ...(await runTestsFor(opts, r, dmnPath, view, cases ? { cases: cases as TestCase[] } : undefined)),
        });
      },
    ),
  );

  server.registerTool(
    "get_decision_tests",
    {
      description:
        "The stored test suite of a decision (raw YAML + the baseVersion save_decision_tests needs). " +
        "Returns exists:false when the decision has no suite yet — then save without a baseVersion.",
      inputSchema: decisionRef,
      annotations: READ,
    },
    safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
      const r = await requireRepo(repo);
      const dmnPath = await resolveDmnPath(r, id, path);
      const stored = await readDecisionTests(opts, r, dmnPath);
      if (!stored) return ok({ exists: false, path: testsPathFor(dmnPath), decisionPath: dmnPath });
      return ok({ exists: true, decisionPath: dmnPath, ...stored, suite: parseTestSuite(stored.raw, stored.path) });
    }),
  );

  server.registerTool(
    "list_changes",
    {
      description: "Files that differ from origin (the release selection pool) in a repository.",
      inputSchema: { repo: repoArg },
      annotations: READ,
    },
    safe(async ({ repo }: { repo: string }) => {
      const r = await requireRepo(repo);
      const workspace = await opts.workspaces.ensure(r);
      return ok({ changes: await listChanges(opts, r, workspace) });
    }),
  );

  if (!opts.mcpReadOnly) {
    registerCreateTool({
      name: "create_process",
      what: "process",
      description:
        "Create a new BPMN process from the validator-clean blank template. Returns its ProcessInfo " +
        "incl. the bpmn path for get/save.",
      create: (r, workspace, body) => createProcess(r, workspace, body),
      pathOf: (created) => created.bpmn,
    });

    registerSaveTool({
      name: "save_bpmn_xml",
      description:
        "Validate and save complete BPMN XML into the LIVE document (co-editors see it immediately). " +
        "baseVersion (from get_bpmn_xml) is REQUIRED; a stale one returns {conflict:true, currentContent} " +
        "instead of overwriting — re-derive your edit against currentContent and retry.",
      ref: processRef,
      payloadKey: "xml",
      payloadDoc: "the complete BPMN XML (must include a full BPMNDI section)",
      baseVersionDoc: "the baseVersion from a prior get_bpmn_xml — call that first",
      resolve: (r, a) => resolveBpmnPath(r, a.id, a.path),
      legacyConflictKey: "currentXml",
    });

    registerCreateTool({
      name: "create_decision",
      what: "decision",
      description:
        "Create a new DMN decision from the blank template (one empty decision table). Returns its " +
        "DecisionInfo incl. the path for get_dmn_xml/save_dmn_xml.",
      create: (r, workspace, body) => createDecision(r, workspace, body),
      pathOf: (created) => created.path,
    });

    registerSaveTool({
      name: "save_dmn_xml",
      description:
        "Validate and save complete DMN XML into the LIVE document (co-editors see it immediately). " +
        "baseVersion (from get_dmn_xml) is REQUIRED; a stale one returns {conflict:true, currentContent} " +
        "instead of overwriting — re-derive your edit against currentContent and retry. Keep the DMNDI " +
        "section complete or the visual editor breaks. Structural validation runs here; for the " +
        "logic run analyze_decision / run_decision_tests before saving.",
      ref: decisionRef,
      payloadKey: "xml",
      payloadDoc: "the complete DMN XML (must include the DMNDI section)",
      baseVersionDoc: "the baseVersion from a prior get_dmn_xml — call that first",
      resolve: (r, a) => resolveDmnPath(r, a.id, a.path),
      legacyConflictKey: "currentXml",
    });

    server.registerTool(
      "create_model",
      {
        description:
          `Create a new model of ANY template-capable notation (${CREATABLE_IDS}) from its blank template — ` +
          "the registry-generic sibling of create_process/create_decision. Returns its ModelInfo incl. the " +
          "path for get_model_content/save_model_content. A notation without a template answers with an " +
          "error: its files arrive via git only.",
        inputSchema: {
          repo: repoArg,
          notation: z.string().describe(`registry notation id — one of: ${CREATABLE_IDS}`),
          name: z.string().describe("human title; the file stem is its kebab-case slug"),
          folder: z.string().optional().describe("target folder relative to the models root"),
        },
        annotations: WRITE,
      },
      safe(
        async ({ repo, notation, name, folder }: { repo: string; notation: string; name: string; folder?: string }) => {
          const r = await requireRepo(repo);
          const workspace = await opts.workspaces.ensure(r);
          const created = await createNotationModel(r, workspace, { notation, name, folder });
          console.log(
            `${created.notation} model created in ${r.fullName} by @${session.user.login} via mcp: ${created.path}`,
          );
          return ok({ model: created });
        },
      ),
    );

    registerSaveTool({
      name: "save_model_content",
      description:
        "Validate and save the complete text of a model of ANY notation into the LIVE document " +
        "(co-editors see it immediately) — the notation-agnostic sibling of save_bpmn_xml/save_dmn_xml. " +
        "The platform check gates it exactly like `pnpm validate` does (structure + DI for the XML " +
        "notations, the baseline parse for the others, dangling references against the repo). " +
        "baseVersion (from get_model_content) is REQUIRED; a stale one returns {conflict:true, " +
        "currentContent} instead of overwriting — re-derive your edit against currentContent and retry.",
      ref: modelRef,
      payloadKey: "content",
      payloadDoc: "the complete document text in the notation's own format (XML, DSL, JSON, …)",
      baseVersionDoc: "the baseVersion from a prior get_model_content — call that first",
      resolve: resolveModelPath,
    });

    server.registerTool(
      "save_decision_tests",
      {
        description:
          "Write a decision's test suite to '<decision>.tests.yaml' next to the model — a normal repo " +
          "file that reviews and ships in the release PR. The FIRST save needs no baseVersion (the file " +
          "is created); later ones require the one from get_decision_tests. Pass record:true to freeze " +
          "what each case WITHOUT an `expect` currently produces (golden master) — that is the honest " +
          "way to author expectations mechanically; anything else should come from the business.",
        inputSchema: {
          ...decisionRef,
          cases: testCasesArg.describe("the complete suite — this REPLACES the stored cases"),
          baseVersion: z.string().optional().describe("from get_decision_tests; omit only for the first save"),
          record: z.boolean().optional().describe("fill cases without `expect` with the current behaviour"),
        },
        annotations: WRITE,
      },
      safe(
        async ({
          repo,
          id,
          path,
          cases,
          baseVersion,
          record,
        }: {
          repo: string;
          id?: string;
          path?: string;
          cases: TestCaseArg[];
          baseVersion?: string;
          record?: boolean;
        }) => {
          const r = await requireRepo(repo);
          const dmnPath = await resolveDmnPath(r, id, path);
          const content = await getContent(opts, r, dmnPath);
          const view = decisionViewOf(content.path, content.content);
          const out = await saveTestsFor(
            opts,
            r,
            dmnPath,
            view,
            { cases: cases as TestCase[] },
            { baseVersion, record },
          );
          if ("conflict" in out) return conflictResult(out.conflict, "currentYaml");
          console.log(`decision tests saved: ${r.fullName}/${out.path} by @${session.user.login} via mcp`);
          return ok({ ok: true, ...out });
        },
      ),
    );

    server.registerTool(
      "release_process",
      {
        description:
          "Open a pull request releasing either one process (processId) or an explicit changed-file " +
          "selection. Merge rights stay at the git provider.",
        inputSchema: {
          repo: repoArg,
          processId: z.string().optional().describe("release exactly this process as one PR"),
          files: z.array(z.string()).optional().describe("or: release exactly these repo-relative files as one PR"),
          title: z.string().optional().describe("PR/commit title"),
        },
        annotations: WRITE,
      },
      safe(
        async ({
          repo,
          processId,
          files,
          title,
        }: {
          repo: string;
          processId?: string;
          files?: string[];
          title?: string;
        }) => {
          const r = await requireRepo(repo);
          const provider = opts.providers.get(session.user.provider) ?? opts.github;
          if (processId) {
            const result = await release(opts, session, provider, r, processId);
            console.log(`released ${r.fullName}#${processId} by @${result.by} via mcp → ${result.pr}`);
            return ok({ release: result });
          }
          if (files && files.length > 0) {
            const result = await releaseFiles(opts, session, provider, r, { files, title });
            console.log(
              `released ${r.fullName} (${result.files.length} file(s)) by @${result.by} via mcp → ${result.pr}`,
            );
            return ok({ release: result });
          }
          return fail("provide either `processId` or a non-empty `files` array.");
        },
      ),
    );
  }

  // ── Todos: model-anchored work items in the repo's OWN tracker (ports/
  // issue-tracker.ts). Registered only WITH a tracker — an agent's tools/list
  // then reflects reality instead of every call failing. Listing is a read and
  // survives read-only mode; filing and closing are writes and do not. ───────
  if (opts.issues) {
    const issues = opts.issues;

    server.registerTool(
      "list_todos",
      {
        description:
          "OPEN model-anchored todos of a repository — work items filed from the live model into the " +
          "repo's issue tracker. Pass `id`/`path` to narrow to ONE process, omit both for the whole repo. " +
          "Each row carries its tracker url, the anchored BPMN elements and the author.",
        inputSchema: processRef,
        annotations: READ,
      },
      safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
        const r = await requireRepo(repo);
        // a filter needs no existence check — an unknown process is simply an
        // empty list, never an error (the tracker-side label filter decides)
        const process = id ?? (path ? processIdOf(path) : undefined);
        const todos = await issues.listTodos(r.fullName, process);
        return ok({ repo: r.fullName, process: process ?? null, todos: todos satisfies TodoWire[] });
      }),
    );

    if (!opts.mcpReadOnly) {
      server.registerTool(
        "create_todo",
        {
          description:
            "File a model-anchored todo into the repository's issue tracker. Anchor it to concrete BPMN " +
            "elements via `elements` (ids from get_bpmn_xml/get_process) — the modeler then shows a badge " +
            "on each one; omit them for a process-level todo. The item is bot-authored, you stay attributed.",
          inputSchema: {
            ...processRef,
            title: z.string().describe("what needs to be done — the tracker item's title"),
            body: z.string().optional().describe("free-text description (markdown)"),
            elements: z
              .array(
                z.object({
                  id: z.string().describe("BPMN element id — the anchor"),
                  name: z.string().nullable().optional().describe("display name; snapshotted for readability"),
                }),
              )
              .optional()
              .describe("BPMN elements this todo is about; omit for a process-level todo"),
          },
          annotations: WRITE,
        },
        safe(
          async ({
            repo,
            id,
            path,
            title,
            body,
            elements,
          }: {
            repo: string;
            id?: string;
            path?: string;
            title: string;
            body?: string;
            elements?: Array<{ id: string; name?: string | null }>;
          }) => {
            const r = await requireRepo(repo);
            // validation, server-side anchor resolution and the audit line are
            // the shared use-case — same rules as POST /todos
            const todo = await fileTodo(
              opts,
              issues,
              session,
              r,
              { title, body, process: id, file: path, elements },
              "mcp",
            );
            return ok({ todo: todo satisfies TodoWire });
          },
        ),
      );

      server.registerTool(
        "close_todo",
        {
          description:
            "Close (complete) a todo in the repository's tracker. `todoId` is the tracker-native id from " +
            "list_todos — NOT a process id. The close is bot-authored with an attribution comment naming you.",
          inputSchema: {
            repo: repoArg,
            todoId: z.string().describe("tracker-native todo id from list_todos (GitHub: the issue number)"),
          },
          annotations: WRITE,
        },
        safe(async ({ repo, todoId }: { repo: string; todoId: string }) => {
          const r = await requireRepo(repo);
          await closeTodoFor(issues, session, r, todoId, "mcp");
          return ok({ ok: true, repo: r.fullName, todoId });
        }),
      );
    }
  }

  // ── MCP Apps: the embedded modelers — ONE registry row per single-file
  // widget apps/web MAY have built (WIDGET_SPECS). Registered in BOTH modes:
  // opening is a read; the readonly marker turns the widget into a viewer. A
  // row whose dist file is missing (an older web build) registers nothing and
  // never fails — /mcp works, just without that widget. ─────────────────────
  // the boot marker sits inside a quoted JS string in the HTML head; a double
  // stringify yields the correctly escaped string literal. `<` is escaped on
  // top: JSON never does, and a "</script>" inside a value (publicUrl is
  // operator env) would terminate the inline script element. Baked into the
  // served resource; the loadWidget salt below busts host resource caches when
  // any of these fields change — a per-SESSION field must never ride here.
  const boot = JSON.stringify(
    JSON.stringify({ readonly: opts.mcpReadOnly === true, publicUrl: opts.publicUrl } satisfies WidgetBootWire),
  ).replaceAll("<", "\\u003C");
  // the live Yjs connection needs connect-src for our ws AND https origin —
  // declared per spec (McpUiResourceCsp); hosts that ignore it leave the
  // widget on its bridge-autosave fallback, never broken
  const wsOrigin = opts.publicUrl.replace(/^http/, "ws");
  const csp = { connectDomains: [wsOrigin, opts.publicUrl] };
  const serveWidget = (widget: Widget): void => {
    registerAppResource(
      server,
      widget.uri,
      widget.uri,
      { mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { csp } } },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: RESOURCE_MIME_TYPE,
            // replacer FUNCTION: a plain replacement string would expand `$`
            // patterns ($&, $') lurking in the operator-controlled boot value
            text: widget.html.replace('"__BPMIQ_BOOT__"', () => boot),
            _meta: { ui: { csp } },
          },
        ],
      }),
    );
  };

  /** the per-server half of a row: how a call resolves, links and summarises */
  interface WidgetBehaviour {
    resolve(r: ConnectedRepo, a: RefArgs): Promise<string>;
    /** the same model in the web app — the link non-apps clients surface */
    url(fullName: string, path: string): string;
    /** LEAN on purpose: hosts cap tool results (~150k chars) and the widget
     *  fetches the text itself via get_model_content — never the model text */
    summary(path: string, content: string): unknown;
  }
  const behaviourOf = (spec: WidgetSpec): WidgetBehaviour => {
    switch (spec.notation) {
      case "bpmn":
        return {
          resolve: (r, a) => resolveBpmnPath(r, a.id, a.path),
          // the process route — the widget adds the canvas selection as ?element=
          url: (fullName, path) => processDeepLink(opts.publicUrl, fullName, processIdOf(path)),
          summary: (path, content) => {
            const graph = extractModelGraph(path, content);
            const view = graph ? deriveProcess(graph) : undefined;
            return view
              ? { name: view.name, roles: view.roles, steps: view.steps.length }
              : "modeler opened (no derivable view)";
          },
        };
      case "dmn":
        return {
          resolve: (r, a) => resolveDmnPath(r, a.id, a.path),
          // decisions open on the file-editor splat route (the repo overview's target)
          url: (fullName, path) => fileDeepLink(opts.publicUrl, fullName, path),
          summary: (path, content) => {
            const view = decisionViewOf(path, content);
            return {
              name: view.name,
              decisions: view.decisions.map((d) => ({
                id: d.id,
                hitPolicy: d.hitPolicy ?? null,
                rules: d.rules.length,
              })),
            };
          },
        };
      default: {
        const n = byId(spec.notation)!; // generatedWidget already proved it exists
        return {
          resolve: async (r, a) => {
            // the notation is fixed by the tool: a stem shared with a .bpmn twin
            // opens THIS notation's file; and a `path` wins server-side, so a
            // foreign file must fail HERE, not inside the single-engine iframe
            const path = await resolveModelPath(r, { id: a.id, path: a.path, notation: n.id });
            if (byExtension(path)?.id !== n.id) {
              throw new Error(`not a ${n.noun.singular}: ${path} — pass a ${n.extensions.join(" / ")} file.`);
            }
            return path;
          },
          // every non-BPMN model opens on the file-editor splat route
          url: (fullName, path) => fileDeepLink(opts.publicUrl, fullName, path),
          summary: (path, content) => {
            const graph = extractModelGraph(path, content);
            const view = graph ? deriveView(graph) : undefined;
            // `detail` stays out (timelines etc. — the agent has get_view for that)
            return view
              ? { name: view.name, summary: view.summary, stats: view.stats }
              : "modeler opened (no derivable view)";
          },
        };
      }
    }
  };

  const served: Array<{ spec: WidgetSpec; widget: Widget }> = [];
  for (const spec of WIDGET_SPECS) {
    const widget = loadWidget(opts.webDist, spec.file, spec.name, boot);
    if (!widget) continue; // older web dist without this bundle — tool absent, never failing
    served.push({ spec, widget });
    serveWidget(widget);
    const b = behaviourOf(spec);
    registerAppTool(
      server,
      spec.tool,
      {
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: READ,
        // "openai/outputTemplate" is ChatGPT's compatibility alias for
        // ui.resourceUri — current builds read the MCP-Apps key, older ones
        // only the alias; registerAppTool passes extra _meta keys through
        _meta: { ui: { resourceUri: widget.uri }, "openai/outputTemplate": widget.uri },
      },
      // `scenario` (dmn) is never read here — it reaches the widget via ontoolinput.
      // Lean result on purpose: hosts cap tool results (~150k chars) and the
      // widget fetches the text itself — never send it here
      safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
        const r = await requireRepo(repo);
        const content = await getContent(opts, r, await b.resolve(r, { id, path }));
        return ok({
          opened: { repo: r.fullName, path: content.path, url: b.url(r.fullName, content.path) },
          summary: b.summary(content.path, content.content),
        });
      }),
    );
  }

  // live Yjs upgrade for every served LIVE-capable widget — hoisted out of the
  // bpmn block (#156): a dist with only the wardley bundle must still go live.
  // Write-gated like every repo tool (requireRepo), absent in read-only mode
  // (the viewers stay on bridge reads) and absent when no live-capable widget
  // is served (a dmn-only dist never minted before either). The resource
  // binding stays what it was: the FIRST such widget — bpmn when its bundle is
  // present (today's exact _meta); an app-visibility tool binds to one
  // resource and hosts are only verified against this shape.
  const first = served.find((s) => s.spec.live)?.widget;
  if (first && !opts.mcpReadOnly && opts.wsTickets) {
    const wsTickets = opts.wsTickets;
    registerAppTool(
      server,
      "mint_ws_ticket",
      {
        description:
          "Mint a short-lived, single-use WebSocket ticket for the modeler widgets' live " +
          "co-editing connection (Hocuspocus/Yjs) to a model of ANY notation. Internal to the " +
          "widgets — agents edit via save_bpmn_xml / save_model_content instead.",
        inputSchema: modelRef,
        annotations: READ,
        _meta: { ui: { resourceUri: first.uri, visibility: ["app"] } },
      },
      safe(async ({ repo, ...ref }: { repo: string } & RefArgs) => {
        const r = await requireRepo(repo);
        const room = roomName(r.fullName, await resolveModelPath(r, ref));
        const ticket = wsTickets.issue(
          { login: session.user.login, name: session.user.name, avatarUrl: null, provider: session.user.provider },
          room,
        );
        return ok({ ticket, url: opts.publicUrl.replace(/^http/, "ws"), room, expiresInSeconds: 60 });
      }),
    );
  }

  for (const contribute of contributions) contribute(server, opts, session);

  return server;
}

/** Stateless Streamable HTTP mount (@bpmiq/mcp-kit). api.ts has already
 *  authenticated `session` and answered non-POST. */
export function handleMcp(req: IncomingMessage, res: ServerResponse, opts: McpDeps, session: Session): Promise<void> {
  // save_bpmn_xml carries whole models — same body budget as the content PUT
  return mountStatelessMcp(req, res, createLiveMcpServer(opts, session), {
    maxBytes: opts.maxDocBytes * 2 + 65_536,
  });
}
