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
import type { TodoWire, WidgetBootWire } from "@bpmiq/contracts/live-host";
import { analyzeDecision, simulateDecision } from "@bpmiq/decisions";
import { parseTestSuite, type TestCase, testsPathFor } from "@bpmiq/decisions/tests";
import { fail, ok, READ, safe, WRITE } from "@bpmiq/mcp-kit";
import { mountStatelessMcp } from "@bpmiq/mcp-kit/mount";
import { modelStem } from "@bpmiq/notations";
import { deriveDecision, deriveProcess } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";
import { checkModel } from "@bpmiq/validator";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Session } from "../adapters/sqlite/sessions.ts";
import { authorizeRepo } from "../application/authz.ts";
import { type ContentDeps, getContent, putContent } from "../application/content.ts";
import { readDecisionTests, runTestsFor, saveTestsFor } from "../application/decision-tests.ts";
import { findDecisionPath, findProcessPath } from "../application/find-model.ts";
import {
  decisionUsers,
  listAllModels,
  listChanges,
  listDecisions,
  listProcesses,
  listRepos,
  type OverviewDeps,
} from "../application/overview.ts";
import { createDecision, createProcess } from "../application/scaffold.ts";
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
    /** built web assets — the MCP-App widgets (mcp-app.html for BPMN,
     *  mcp-app-dmn.html for decisions) are read from here */
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
// The single-file HTML files built by apps/web (vite.mcp-app*.config.ts): the
// BPMN modeler and the DMN decision modeler. Read once per process, memoised —
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
  const key = `${file}\0${configSalt}`;
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

export function createLiveMcpServer(opts: McpDeps, session: Session): McpServer {
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
      view: decisionViewOf(content.path, content.xml),
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
   *  not an error (the sidecar save renames the payload key: it carries YAML) */
  const conflictResult = (
    c: { path: string; currentXml: string; baseVersion: string; error: string },
    key: "currentXml" | "currentYaml" = "currentXml",
  ) =>
    ok({ ok: false, conflict: true, path: c.path, [key]: c.currentXml, baseVersion: c.baseVersion, message: c.error });

  const registerGetXmlTool = (cfg: {
    name: string;
    description: string;
    ref: typeof processRef;
    resolve: (r: ConnectedRepo, id?: string, path?: string) => Promise<string>;
  }): void => {
    server.registerTool(
      cfg.name,
      { description: cfg.description, inputSchema: cfg.ref, annotations: READ },
      safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
        const r = await requireRepo(repo);
        return ok(await getContent(opts, r, await cfg.resolve(r, id, path)));
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
    ref: typeof processRef;
    xmlDoc: string;
    baseVersionDoc: string;
    resolve: (r: ConnectedRepo, id?: string, path?: string) => Promise<string>;
  }): void => {
    server.registerTool(
      cfg.name,
      {
        description: cfg.description,
        inputSchema: {
          ...cfg.ref,
          xml: z.string().describe(cfg.xmlDoc),
          baseVersion: z.string().describe(cfg.baseVersionDoc),
          lint: lintArg,
        },
        annotations: WRITE,
      },
      safe(
        async ({
          repo,
          id,
          path,
          xml,
          baseVersion,
          lint,
        }: {
          repo: string;
          id?: string;
          path?: string;
          xml: string;
          baseVersion: string;
          lint?: "block" | "warn";
        }) => {
          const r = await requireRepo(repo);
          const out = await putContent(opts, r, await cfg.resolve(r, id, path), { xml, baseVersion, lint });
          if (!out.ok) return conflictResult(out.conflict);
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
      const graph = extractModelGraph(content.path, content.xml);
      if (!graph) return fail(`could not derive a process view from ${content.path}.`);
      return ok({ id: id ?? null, path: content.path, baseVersion: content.baseVersion, ...deriveProcess(graph) });
    }),
  );

  registerGetXmlTool({
    name: "get_bpmn_xml",
    description:
      "The current LIVE BPMN XML of a process plus the baseVersion token save_bpmn_xml requires " +
      "for conflict-safe writes.",
    ref: processRef,
    resolve: resolveBpmnPath,
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
      let modelIds: Map<string, Set<string>> | undefined;
      if (repo) {
        const r = await requireRepo(repo);
        const workspace = await opts.workspaces.ensure(r);
        const cfg = loadContentConfig(workspace);
        if (cfg) {
          modelIds = new Map();
          for (const m of await discoverModels(workspace, cfg)) {
            (modelIds.get(m.notation) ?? modelIds.set(m.notation, new Set()).get(m.notation)!).add(m.id);
          }
        }
      }
      const findings = checkModel(xml, { path: path ?? "<bpmn>", notation: "bpmn", modelIds }) ?? [];
      return ok({ ok: !findings.some((f) => f.severity === "ERROR"), findings });
    }),
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
        ...decisionViewOf(content.path, content.xml),
        // the impact side: which processes delegate to this decision
        usedBy: await decisionUsers(workspace, decisionId),
      });
    }),
  );

  registerGetXmlTool({
    name: "get_dmn_xml",
    description:
      "The current LIVE DMN XML of a decision plus the baseVersion token save_dmn_xml requires " +
      "for conflict-safe writes.",
    ref: decisionRef,
    resolve: resolveDmnPath,
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
        "baseVersion (from get_bpmn_xml) is REQUIRED; a stale one returns {conflict:true, currentXml} " +
        "instead of overwriting — re-derive your edit against currentXml and retry.",
      ref: processRef,
      xmlDoc: "the complete BPMN XML (must include a full BPMNDI section)",
      baseVersionDoc: "the baseVersion from a prior get_bpmn_xml — call that first",
      resolve: resolveBpmnPath,
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
        "baseVersion (from get_dmn_xml) is REQUIRED; a stale one returns {conflict:true, currentXml} " +
        "instead of overwriting — re-derive your edit against currentXml and retry. Keep the DMNDI " +
        "section complete or the visual editor breaks. Structural validation runs here; for the " +
        "logic run analyze_decision / run_decision_tests before saving.",
      ref: decisionRef,
      xmlDoc: "the complete DMN XML (must include the DMNDI section)",
      baseVersionDoc: "the baseVersion from a prior get_dmn_xml — call that first",
      resolve: resolveDmnPath,
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
          const view = decisionViewOf(content.path, content.xml);
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

  // ── MCP Apps: the embedded modelers (registered in BOTH modes — opening is a
  // read; the readonly marker switches the widget to a viewer) ───────────────
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

  const modeler = loadWidget(opts.webDist, "mcp-app.html", "modeler", boot);
  if (modeler) {
    serveWidget(modeler);
    registerAppTool(
      server,
      "open_modeler",
      {
        description:
          "Open the interactive BPMN modeler widget for a process. Renders an embedded diagram " +
          "editor in MCP-Apps-capable clients (claude.ai, Claude Desktop) — including the process's " +
          "todos, with a badge on every anchored element; other clients get a " +
          "text summary — use get_process/get_bpmn_xml there instead. The result's " +
          "`opened.url` links the same model in the full bpmiq web modeler.",
        inputSchema: processRef,
        annotations: READ,
        // "openai/outputTemplate" is ChatGPT's compatibility alias for
        // ui.resourceUri — current builds read the MCP-Apps key, older ones
        // only the alias; registerAppTool passes extra _meta keys through
        _meta: { ui: { resourceUri: modeler.uri }, "openai/outputTemplate": modeler.uri },
      },
      safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
        const r = await requireRepo(repo);
        const bpmnPath = await resolveBpmnPath(r, id, path);
        // lean result on purpose: hosts cap tool results (~150k chars) and the
        // widget fetches the XML itself via get_bpmn_xml — never send it here
        const content = await getContent(opts, r, bpmnPath);
        const graph = extractModelGraph(content.path, content.xml);
        const view = graph ? deriveProcess(graph) : undefined;
        return ok({
          opened: {
            repo: r.fullName,
            path: content.path,
            // the same model in the full web modeler — the link non-apps
            // clients surface instead of the widget
            url: processDeepLink(opts.publicUrl, r.fullName, processIdOf(content.path)),
          },
          summary: view
            ? { name: view.name, roles: view.roles, steps: view.steps.length }
            : "modeler opened (no derivable view)",
        });
      }),
    );

    // live Yjs upgrade for the widget: a single-use, room-bound ws ticket.
    // Write-gated like every repo tool (requireRepo) and absent in read-only
    // mode — the viewer stays on bridge reads.
    if (!opts.mcpReadOnly && opts.wsTickets) {
      const wsTickets = opts.wsTickets;
      registerAppTool(
        server,
        "mint_ws_ticket",
        {
          description:
            "Mint a short-lived, single-use WebSocket ticket for the modeler widget's live " +
            "co-editing connection (Hocuspocus/Yjs). Internal to the widget — agents edit via " +
            "save_bpmn_xml instead.",
          inputSchema: processRef,
          annotations: READ,
          _meta: { ui: { resourceUri: modeler.uri, visibility: ["app"] } },
        },
        safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
          const r = await requireRepo(repo);
          const bpmnPath = await resolveBpmnPath(r, id, path);
          const room = roomName(r.fullName, bpmnPath);
          const ticket = wsTickets.issue(
            { login: session.user.login, name: session.user.name, avatarUrl: null, provider: session.user.provider },
            room,
          );
          return ok({ ticket, url: opts.publicUrl.replace(/^http/, "ws"), room, expiresInSeconds: 60 });
        }),
      );
    }
  }

  // ── MCP App: the decision modeler (dmn-js + the simulation add-on) ─────────
  const decisionModeler = loadWidget(opts.webDist, "mcp-app-dmn.html", "decision-modeler", boot);
  if (decisionModeler) {
    serveWidget(decisionModeler);
    registerAppTool(
      server,
      "open_decision_modeler",
      {
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
        annotations: READ,
        // same ChatGPT alias as open_modeler
        _meta: { ui: { resourceUri: decisionModeler.uri }, "openai/outputTemplate": decisionModeler.uri },
      },
      safe(async ({ repo, id, path }: { repo: string; id?: string; path?: string }) => {
        const r = await requireRepo(repo);
        const dmnPath = await resolveDmnPath(r, id, path);
        // lean result on purpose (hosts cap tool results): the widget fetches
        // the XML itself via get_dmn_xml — never send it here
        const content = await getContent(opts, r, dmnPath);
        const view = decisionViewOf(content.path, content.xml);
        return ok({
          opened: {
            repo: r.fullName,
            path: content.path,
            // decisions open on the file-editor splat route (the same target
            // the repo overview links them to)
            url: fileDeepLink(opts.publicUrl, r.fullName, content.path),
          },
          summary: {
            name: view.name,
            decisions: view.decisions.map((d) => ({ id: d.id, hitPolicy: d.hitPolicy ?? null, rules: d.rules.length })),
          },
        });
      }),
    );
  }

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
