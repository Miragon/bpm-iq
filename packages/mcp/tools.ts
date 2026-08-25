/**
 * bpm-mcp-server — tool definitions, shared by both transports:
 *   server.ts  → stdio (local: Claude Code picks it up via .mcp.json)
 *   http.ts    → Streamable HTTP (remote: fly.io, any MCP client via URL)
 *
 * Read-only by construction: only readFileSync + the content-repo discovery,
 * no write path. All tools carry readOnlyHint so clients may auto-approve them.
 * The one opt-in exception to "repo-local" is list_todos (registered ONLY when
 * BPM_TODOS_REPO + BPM_TODOS_TOKEN are set): a read-only GET against the content
 * repo's issue tracker — the zero-auth default stays untouched.
 *
 * The content contract is minimal (@bpmiq/notations/content): a repo is a BPM
 * content repo iff it has a root bpmiq.yml naming its BPMN processes folder; a
 * process IS a .bpmn file there. There is NO hand-written process.yaml — the
 * process view (name, roles, steps, flow, sub-process calls) is DERIVED from the
 * BPMN on the fly (@bpmiq/notations/derive). A new notation with an extractor is
 * automatically analyzable here.
 *
 * Content root: pass --root <dir> (server.ts) or BPM_CONTENT_ROOT — any content
 * repo works, the bundled process-documentation is only the default.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAnchor } from "@bpmiq/contracts/todo-anchor";
import { type GitHubIssueRow, isPullRequestRow, todoLabelQuery } from "@bpmiq/github-app/todos";
import { fail, ok, READ, safe as kitSafe, type ToolResult } from "@bpmiq/mcp-kit";
import { byId, NOTATIONS } from "@bpmiq/notations";
import {
  buildRepoIndex,
  type ContentConfig,
  type DiscoveredModel,
  type DiscoveredProcess,
  discoverModels,
  discoverProcesses,
  loadContentConfig,
} from "@bpmiq/notations/content";
import { deriveProcess, deriveView, hasDeriver } from "@bpmiq/notations/derive";
import { extractModelGraph, type ModelGraph } from "@bpmiq/notations/extract";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** This file lives at packages/mcp/; the example content repo is process-documentation/. */
export const DEFAULT_ROOT =
  process.env.BPM_CONTENT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "process-documentation");

// ── File access — read-only, never throws ────────────────────────────────────
const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// ── Tool result codec: @bpmiq/mcp-kit — this zero-auth server prefixes every
// unexpected throw, unlike the Live Host whose AppErrors speak for themselves
const safe = (fn: Parameters<typeof kitSafe>[0]) => kitSafe(fn, { prefix: "Unexpected error: " });
/** every tool here is read-only and repo-local */
const READ_ONLY = READ;

// ── Graph analyses (notation-agnostic where possible) ────────────────────────

/** what "flow" means in this graph's notation — undefined = no flow semantics */
function flowKindsOf(graph: ModelGraph): string[] | undefined {
  const kinds = byId(graph.notation)?.graphHints?.flowEdgeKinds;
  return kinds && kinds.length > 0 ? kinds : undefined;
}

/** node -> outgoing flow-edge targets, per the notation's graphHints */
function flowTargets(graph: ModelGraph, kinds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!kinds.includes(e.kind)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }
  return out;
}

/** all simple start→end paths through the notation's flow edges, cycle-cut, capped */
function enumeratePaths(graph: ModelGraph, kinds: string[], max: number): { paths: string[][]; truncated: boolean } {
  const out = flowTargets(graph, kinds);
  const label = new Map(graph.nodes.map((n) => [n.id, n.name ? `${n.name} (${n.type})` : `${n.id} (${n.type})`]));
  // entry nodes per the notation's hints (BPMN: top-level startEvents); a
  // notation without entry types falls back to nodes nothing flows into
  const entryTypes = byId(graph.notation)?.graphHints?.entryNodeTypes ?? [];
  const hasIncoming = new Set([...out.values()].flat());
  const starts =
    entryTypes.length > 0
      ? graph.nodes.filter((n) => entryTypes.includes(n.type) && !n.extra?.parent)
      : graph.nodes.filter((n) => !hasIncoming.has(n.id) && (out.get(n.id)?.length ?? 0) > 0);
  const paths: string[][] = [];
  let truncated = false;
  const walk = (node: string, seen: Set<string>, path: string[]): void => {
    if (paths.length >= max) {
      truncated = true;
      return;
    }
    const next = out.get(node) ?? [];
    if (next.length === 0) {
      paths.push(path);
      return;
    }
    for (const target of next) {
      if (seen.has(target)) continue; // cycle cut
      walk(target, new Set(seen).add(target), [...path, label.get(target) ?? target]);
    }
  };
  for (const s of starts) walk(s.id, new Set([s.id]), [label.get(s.id) ?? s.id]);
  return { paths, truncated };
}

/** cycles over the notation's flow edges (DFS back-edge detection) */
function findCycles(graph: ModelGraph, kinds: string[]): string[][] {
  const out = flowTargets(graph, kinds);
  const label = new Map(graph.nodes.map((n) => [n.id, n.name ?? n.id]));
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    const at = stack.indexOf(node);
    if (at >= 0) {
      const cycle = stack.slice(at);
      const key = [...cycle].sort().join("|");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push([...cycle, node].map((id) => label.get(id) ?? id));
      }
      return;
    }
    for (const next of out.get(node) ?? []) visit(next, [...stack, node]);
  };
  for (const n of graph.nodes) visit(n.id, []);
  return cycles;
}

/** Opt-in tracker access for list_todos — absent = the tool does not register. */
export interface TodosConfig {
  /** owner/name of the tracker repo (GitHub) */
  repo: string;
  /** token with issues:read on that repo */
  token: string;
  /** REST base override (default https://api.github.com) */
  apiUrl?: string;
}

/** The list_todos gate, used by BOTH entry points (server.ts, http.ts — the
 * composition roots read env, this module doesn't): undefined unless BOTH
 * BPM_TODOS_REPO and BPM_TODOS_TOKEN are set — the server stays zero-auth by
 * default, the tool simply does not exist without the opt-in. */
export function todosConfigFromEnv(env: Record<string, string | undefined>): TodosConfig | undefined {
  return env.BPM_TODOS_REPO && env.BPM_TODOS_TOKEN
    ? { repo: env.BPM_TODOS_REPO, token: env.BPM_TODOS_TOKEN, apiUrl: env.GITHUB_API_URL }
    : undefined;
}

/** A per-capability tool contribution for the read-only server — the same
 *  composition hook the Live Host exposes (LiveToolContribution), applied
 *  AFTER the core registration. Contributions must stay read-only like every
 *  tool here. */
export type McpToolContribution = (server: McpServer, root: string) => void;

/** Build a fully configured, read-only MCP server over the repo at `root`. */
export function createMcpServer(
  root: string = DEFAULT_ROOT,
  todos?: TodosConfig,
  contributions: readonly McpToolContribution[] = [],
): McpServer {
  // re-read the contract per call so the server reflects a live-edited checkout
  const config = (): ContentConfig | undefined => loadContentConfig(root);
  const processes = async (): Promise<DiscoveredProcess[]> => {
    const cfg = config();
    return cfg ? discoverProcesses(root, cfg) : [];
  };
  const findProcess = async (id: string): Promise<DiscoveredProcess | null> =>
    (await processes()).find((p) => p.id === id) ?? null;
  /** any-notation lookup; a stem shared across notations resolves bpmn-first
   *  (back-compat: process ids keep meaning what they always meant) */
  const findModel = async (id: string, notation?: string): Promise<DiscoveredModel | null> => {
    const cfg = config();
    if (!cfg) return null;
    const matches = (await discoverModels(root, cfg)).filter(
      (m) => m.id === id && (!notation || m.notation === notation),
    );
    return matches.find((m) => m.notation === "bpmn") ?? matches[0] ?? null;
  };
  const unknownModel = async (id: string, notation?: string) => {
    const cfg = config();
    const models = (cfg ? await discoverModels(root, cfg) : []).filter((m) => !notation || m.notation === notation);
    const listed = models.map((m) => `${m.id} (${m.notation})`).join(", ") || "(none)";
    const what = notation ? (byId(notation)?.noun.singular ?? notation) : "model";
    return fail(`Unknown ${what} '${id}'. Available: ${listed}.`);
  };
  /** parse a discovered process's .bpmn into a ModelGraph, or a failure result */
  const graphOf = (proc: DiscoveredProcess): ModelGraph | ToolResult => {
    const raw = readText(join(root, proc.path));
    if (raw === null) return fail(`No such model file: ${proc.path}.`);
    const graph = extractModelGraph(proc.path, raw);
    if (!graph) return fail(`No extractor for '${proc.path}'.`);
    return graph;
  };
  const isGraph = (g: ModelGraph | ToolResult): g is ModelGraph => !("content" in g);
  /** the registry nouns for user-facing copy ("wardley map" / "team topologies") */
  const nounOf = (notation: string): string => byId(notation)?.noun.singular ?? notation;
  const pluralOf = (notation: string): string => byId(notation)?.noun.plural ?? notation;
  const notAContentRepo = () =>
    fail(
      `No bpmiq.yml at the content root — not a BPM content repo. Expected a root bpmiq.yml naming a processes folder.`,
    );
  const unknownProcess = async (id: string) =>
    fail(`Unknown process '${id}'. Available: ${(await processes()).map((p) => p.id).join(", ") || "(none)"}.`);

  const server = new McpServer({ name: "bpm-architecture", version: "0.2.0" });

  server.registerTool(
    "list_models",
    {
      description:
        "List EVERY model file of the repository, grouped by notation (bpmn, dmn, wardley, " +
        "team-topology, …) — the registry-wide superset of list_processes. Each row: id " +
        "(file stem), path, and — for notations with a registered deriver — the model's own " +
        "name, summary and stats. Use to see which notations a repo contains before reaching " +
        "for the notation-specific tools.",
      annotations: READ_ONLY,
    },
    safe(async () => {
      const cfg = config();
      if (!cfg) return notAContentRepo();
      const models = await discoverModels(root, cfg);
      if (models.length === 0) return ok("No model files found under the configured models folder.");
      const grouped: Record<string, Array<Record<string, unknown>>> = {};
      for (const m of models) {
        // extract + deriveView are the notation's registered capabilities —
        // a notation without them, an unreadable file OR a transiently broken
        // one (this server reflects a live-edited checkout) still lists as
        // the bare row; one bad file must never kill the whole listing
        let view;
        try {
          const raw = readText(join(root, m.path));
          const graph = raw === null ? undefined : extractModelGraph(m.path, raw);
          view = graph ? deriveView(graph) : undefined;
        } catch {
          view = undefined;
        }
        (grouped[m.notation] ??= []).push({
          id: m.id,
          path: m.path,
          ...(view?.name ? { name: view.name } : {}),
          ...(view ? { summary: view.summary, stats: view.stats } : {}),
        });
      }
      return ok({ models: grouped });
    }),
  );

  server.registerTool(
    "list_processes",
    {
      description:
        "List all modeled business processes — every .bpmn file under the repo's bpmiq.yml " +
        "processes folder. Each row: id (file name without extension), derived name, the file " +
        "path, and a count of steps/events/gateways/roles. Use to get a portfolio overview or " +
        "to find a process id before calling get_process, get_model, who_owns or enumerate_paths.",
      annotations: READ_ONLY,
    },
    safe(async () => {
      if (!config()) return notAContentRepo();
      const procs = await processes();
      if (procs.length === 0) return ok("No processes found — no .bpmn files under the configured processes folder.");
      return ok(
        procs.map((p) => {
          const graph = graphOf(p);
          if (!isGraph(graph)) return { id: p.id, path: p.path, error: "could not parse BPMN" };
          const d = deriveProcess(graph);
          return { id: p.id, name: d.name ?? p.id, path: p.path, ...d.stats };
        }),
      );
    }),
  );

  server.registerTool(
    "get_process",
    {
      description:
        "Get one process in full: the process view DERIVED from its BPMN — name, roles (BPMN " +
        "lanes = owning teams), steps (activities with their role), events, gateways, the " +
        "sequence/message flow, and the sub-processes it calls (callActivity → calledElement). " +
        "Use for walkthroughs and any deep question about a single process.",
      inputSchema: {
        id: z.string().describe("Process id = the .bpmn file name without extension, e.g. order-to-cash"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => {
      if (!config()) return notAContentRepo();
      const proc = await findProcess(id);
      if (!proc) return unknownProcess(id);
      const graph = graphOf(proc);
      if (!isGraph(graph)) return graph;
      return ok({ id: proc.id, path: proc.path, ...deriveProcess(graph) });
    }),
  );

  server.registerTool(
    "get_model",
    {
      description:
        "Parse ANY model file into its generic graph: nodes (id, type, name), edges and meta — " +
        "BPMN flows and lanes, DMN requirements, Wardley components/dependencies, … " +
        "Use to see the raw structure, or to ground any 'how does X work' answer in the actual model.",
      inputSchema: {
        id: z.string().describe("Model id = file stem (from list_models), e.g. order-to-cash"),
        notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id, notation }) => {
      if (!config()) return notAContentRepo();
      const m = await findModel(id, notation);
      if (!m) return unknownModel(id, notation);
      const graph = graphOf(m);
      return isGraph(graph) ? ok({ id: m.id, file: m.path, ...graph }) : graph;
    }),
  );

  server.registerTool(
    "get_view",
    {
      description:
        "The derived view of ANY model — its own name, a one-line summary, stats, and the rich " +
        "notation payload in `detail` where one exists (process view, decision tables, …). The " +
        "notation-agnostic sibling of get_process: works for every notation with extract+derive " +
        `capabilities (${NOTATIONS.filter((n) => hasDeriver(n.id))
          .map((n) => n.id)
          .join(", ")}).`,
      inputSchema: {
        id: z.string().describe("Model id = file stem (from list_models), e.g. tea-shop"),
        notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id, notation }) => {
      if (!config()) return notAContentRepo();
      const m = await findModel(id, notation);
      if (!m) return unknownModel(id, notation);
      const graph = graphOf(m);
      if (!isGraph(graph)) return graph;
      const view = deriveView(graph);
      if (!view)
        return fail(`a ${nounOf(m.notation)} has no registered deriver — get_view needs the derive capability.`);
      return ok({ id: m.id, path: m.path, ...view });
    }),
  );

  server.registerTool(
    "enumerate_paths",
    {
      description:
        "Enumerate the possible start→end paths through a model's flow (cycle-safe, capped) — " +
        "BPMN sequence flows, Wardley dependencies, … per the notation's graph hints. Each path " +
        "is the ordered list of element names. Use for walkthroughs ('what are the ways an order " +
        "can go?'), test-case derivation, and spotting unexpected shortcuts or dead branches.",
      inputSchema: {
        id: z.string().describe("Model id = file stem, e.g. order-to-cash"),
        notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
        max: z.number().int().min(1).max(100).optional().describe("Maximum number of paths to return (default 20)"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id, notation, max }) => {
      if (!config()) return notAContentRepo();
      const m = await findModel(id, notation);
      if (!m) return unknownModel(id, notation);
      const graph = graphOf(m);
      if (!isGraph(graph)) return graph;
      const kinds = flowKindsOf(graph);
      if (!kinds) return ok(`${pluralOf(m.notation)} have no flow semantics (no graphHints) — nothing to enumerate.`);
      const { paths, truncated } = enumeratePaths(graph, kinds, max ?? 20);
      return ok({
        id: m.id,
        pathCount: paths.length,
        truncated,
        paths,
        ...(paths.length === 0
          ? {
              note: "no start→end chains over the notation's flow edges — isolated or cyclic-only elements are not paths",
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "find_cycles",
    {
      description:
        "Detect cycles (loops) in a model's flow — BPMN rework/retry loops, circular Wardley " +
        "dependencies, circular DMN requirements — per the notation's graph hints. Returns each " +
        "cycle as the ordered list of element names. Use when analyzing complexity, rework cost, " +
        "or 'why does this case never finish'.",
      inputSchema: {
        id: z.string().describe("Model id = file stem, e.g. order-to-cash"),
        notation: z.string().optional().describe("registry notation id — disambiguates a stem shared across notations"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id, notation }) => {
      if (!config()) return notAContentRepo();
      const m = await findModel(id, notation);
      if (!m) return unknownModel(id, notation);
      const graph = graphOf(m);
      if (!isGraph(graph)) return graph;
      const kinds = flowKindsOf(graph);
      if (!kinds) return ok(`${pluralOf(m.notation)} have no flow semantics (no graphHints) — nothing to check.`);
      const cycles = findCycles(graph, kinds);
      return ok(cycles.length === 0 ? `No cycles in ${m.id}'s flow.` : { id: m.id, cycles });
    }),
  );

  server.registerTool(
    "who_owns",
    {
      description:
        "Resolve ownership of a process from its BPMN lanes — the roles/teams that own its steps " +
        "(each lane, with the steps it contains) plus the pools (participants). Use for 'who owns " +
        "X', 'who does what in X', or handoff questions. Note: on the slim contract ownership is " +
        "whatever the model's lanes say; a process with no lanes has no modeled owner.",
      inputSchema: { id: z.string().describe("Process id, e.g. order-to-cash") },
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => {
      if (!config()) return notAContentRepo();
      const proc = await findProcess(id);
      if (!proc) return unknownProcess(id);
      const graph = graphOf(proc);
      if (!isGraph(graph)) return graph;
      const d = deriveProcess(graph);
      if (d.roles.length === 0 && d.pools.length === 0) {
        return ok(`Process '${proc.id}' has no lanes or pools — no owning team is modeled in the BPMN.`);
      }
      const byId = new Map(graph.nodes.map((n) => [n.id, n.name ?? n.id]));
      return ok({
        id: proc.id,
        pools: d.pools,
        roles: d.roles.map((r) => ({ role: r.name, steps: r.stepIds.map((s) => byId.get(s) ?? s) })),
      });
    }),
  );

  server.registerTool(
    "which_processes_use",
    {
      description:
        "Impact analysis across the portfolio: find processes whose id, derived name, role/lane " +
        "names, step names, or sub-process calls (calledElement) match a query — case-insensitive " +
        "substring. Use for 'what calls invoice-handling', 'which processes have a Billing lane', " +
        "'what touches the credit check'.",
      inputSchema: {
        query: z.string().describe("Case-insensitive substring, e.g. 'invoice-handling', 'Billing', 'credit'"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query }) => {
      if (!config()) return notAContentRepo();
      const q = query.toLowerCase();
      const procs = await processes();
      const hits = [];
      for (const proc of procs) {
        const graph = graphOf(proc);
        if (!isGraph(graph)) continue;
        const d = deriveProcess(graph);
        const matches: { field: string; value: string }[] = [];
        const check = (field: string, value: unknown) => {
          if (typeof value === "string" && value.toLowerCase().includes(q)) matches.push({ field, value });
        };
        check("id", proc.id);
        check("name", d.name);
        for (const r of d.roles) check("role", r.name);
        for (const s of d.steps) check("step", s.name);
        for (const c of d.calls) check("calls", c.calledElement);
        if (matches.length > 0) hits.push({ id: proc.id, name: d.name ?? proc.id, matches });
      }
      if (hits.length === 0) {
        return ok(
          `No process references '${query}' in its id, name, roles, steps or sub-process calls (checked ${procs.length} process(es)).`,
        );
      }
      return ok(hits);
    }),
  );

  server.registerTool(
    "which_models_use",
    {
      description:
        "Reference-level impact analysis across EVERY notation: all models whose typed " +
        "cross-model references (callActivity calls, businessRuleTask decides, …) point at the " +
        "given model id (file stem, exact match) — the repo-wide reference index behind it also " +
        "flags dangling references. The registry-wide sibling of which_processes_use; use for " +
        "'what breaks if I change or delete this model?'.",
      inputSchema: {
        id: z.string().describe("Target model id = file stem (from list_models), e.g. 'credit-check'"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => {
      const cfg = config();
      if (!cfg) return notAContentRepo();
      const index = await buildRepoIndex(root, cfg);
      const hits = index.refs
        .filter((r) => r.to.id === id)
        .map((r) => ({
          from: r.from.path,
          notation: r.from.notation,
          ...(r.from.element ? { element: r.from.element } : {}),
          rel: r.rel,
          resolved: r.resolved !== undefined,
        }));
      if (hits.length === 0) {
        return ok(`No model references '${id}' (checked ${index.refs.length} reference(s) across the repo).`);
      }
      return ok({ target: id, referencedBy: hits });
    }),
  );

  // ── Todos (STRICTLY opt-in — the zero-auth default stays untouched) ───────
  // Model-anchored todos live as issues in the content repo's OWN tracker (see
  // apps/live-host). Listing them needs a credential, which this read-only
  // zero-auth server must never require — the tool only EXISTS when the entry
  // point passed a TodosConfig (todosConfigFromEnv: BPM_TODOS_REPO + BPM_TODOS_TOKEN).
  if (todos) {
    const { repo: todosRepo, token: todosToken } = todos;
    const api = (todos.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    server.registerTool(
      "list_todos",
      {
        description:
          "List the OPEN model-anchored todos of this content repo — work items filed from the " +
          "live model into the repo's issue tracker (label 'todo'). Each row carries the tracker " +
          "id and URL, title, assignees, createdAt and the parsed anchor (process, model file, " +
          "anchored BPMN elements). Optional filter on one process. Use for 'what is open on " +
          "process X' or to cross-check a model answer against known open discrepancies.",
        inputSchema: {
          process: z.string().optional().describe("Only todos anchored to this process id, e.g. order-to-cash"),
        },
        // still read-only, but the ONE tool that leaves the checkout (tracker API)
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      safe(async ({ process: processId }) => {
        const res = await fetch(
          `${api}/repos/${todosRepo}/issues?state=open&labels=${encodeURIComponent(todoLabelQuery(processId))}&per_page=100`,
          {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${todosToken}`,
              "user-agent": "bpmiq-mcp",
            },
          },
        );
        if (!res.ok) return fail(`Tracker query on ${todosRepo} failed: ${res.status} ${await res.text()}`);
        const rows = (await res.json()) as GitHubIssueRow[];
        const todos = rows
          .filter((row) => !isPullRequestRow(row))
          .map((row) => ({
            id: String(row.number),
            url: row.html_url,
            title: row.title,
            anchor: parseAnchor(row.body ?? ""),
            assignees: (row.assignees ?? []).map((a) => a.login),
            createdAt: row.created_at,
          }));
        if (todos.length === 0) {
          return ok(`No open todos${processId ? ` for process '${processId}'` : ""} in ${todosRepo}.`);
        }
        return ok(todos);
      }),
    );
  }

  // per-capability contributions LAST — they see the fully registered core
  for (const contribute of contributions) contribute(server, root);

  return server;
}
