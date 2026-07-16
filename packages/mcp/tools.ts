/**
 * bpm-mcp-server — tool definitions, shared by both transports:
 *   server.ts  → stdio (local: Claude Code picks it up via .mcp.json)
 *   http.ts    → Streamable HTTP (remote: fly.io, any MCP client via URL)
 *
 * Read-only by construction: only readFileSync/readdirSync, no write path.
 * All tools carry readOnlyHint so clients may auto-approve them. The one
 * opt-in exception to "repo-local" is list_todos (registered ONLY when
 * BPM_TODOS_REPO + BPM_TODOS_TOKEN are set): a read-only GET against the
 * content repo's issue tracker — the zero-auth default stays untouched.
 *
 * Content root: pass --root <dir> (server.ts) or BPM_CONTENT_ROOT — any BPM
 * content repo works, the bundled process-documentation is only the default.
 *
 * Model analyses run on the generic ModelGraph from @bpmiq/notations/extract —
 * a new notation with an extractor is automatically analyzable here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAnchor } from "@bpmiq/contracts/todo-anchor";
import { extractModelGraph, type ModelGraph } from "@bpmiq/notations/extract";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import YAML from "yaml";
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
const parseYaml = (text: string): any => {
  try {
    return YAML.parse(text);
  } catch {
    return null;
  }
};
const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function listFiles(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...listFiles(join(dir, e.name), rel));
    else files.push(rel);
  }
  return files;
}

// ── Tool result helpers ───────────────────────────────────────────────────────
const ok = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const safe =
  (fn: (args: any) => unknown) =>
  async (args: unknown): Promise<ToolResult> => {
    try {
      return (await fn(args ?? {})) as ToolResult;
    } catch (err) {
      return fail(`Unexpected error: ${(err as Error).message}`);
    }
  };
/** every tool here is read-only and repo-local */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

// ── Graph analyses (notation-agnostic where possible) ────────────────────────

/** all simple start→end paths through sequence flows, cycle-cut, capped */
function enumeratePaths(graph: ModelGraph, max: number): { paths: string[][]; truncated: boolean } {
  const out = new Map<string, string[]>(); // node -> outgoing sequence-flow targets
  for (const e of graph.edges) {
    if (e.kind !== "sequenceFlow") continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }
  const label = new Map(graph.nodes.map((n) => [n.id, n.name ? `${n.name} (${n.type})` : `${n.id} (${n.type})`]));
  const starts = graph.nodes.filter((n) => n.type === "startEvent" && !n.extra?.parent);
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

/** cycles over sequence flows (DFS back-edge detection) */
function findCycles(graph: ModelGraph): string[][] {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "sequenceFlow") continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }
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

/** Build a fully configured, read-only MCP server over the repo at `root`. */
export function createMcpServer(root: string = DEFAULT_ROOT, todos?: TodosConfig): McpServer {
  const PROCESSES = join(root, "processes");
  const LANDSCAPE = join(root, "landscape");
  const TEAM_TOPOLOGY = join(LANDSCAPE, "team-topology.tt");
  const GLOSSARY = join(LANDSCAPE, "glossary.yaml");

  const processIds = () => {
    let entries;
    try {
      entries = readdirSync(PROCESSES, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && existsSync(join(PROCESSES, e.name, "process.yaml")))
      .map((e) => e.name)
      .sort();
  };
  const loadProcess = (id: string) => {
    const text = readText(join(PROCESSES, id, "process.yaml"));
    return text === null ? null : parseYaml(text);
  };
  /** resolve a model file within one process dir — traversal-safe */
  const modelPath = (id: string, rel: string): string | null => {
    const dir = resolve(PROCESSES, id);
    const abs = resolve(dir, rel);
    return abs.startsWith(dir + "/") ? abs : null;
  };
  /** every model file a process declares (models, subprocesses, decisions) */
  const declaredModels = (meta: any): string[] =>
    [
      ...Object.values((meta?.models ?? {}) as Record<string, string>),
      ...(meta?.subprocesses ?? []).map((sp: { file?: string }) => sp?.file),
      ...(meta?.decisions ?? []).map((d: { file?: string }) => d?.file),
    ].filter(Boolean) as string[];
  const graphFor = (id: string, rel: string): ModelGraph | ToolResult => {
    const abs = modelPath(id, rel);
    if (!abs) return fail(`Illegal model path '${rel}' — must stay inside processes/${id}/.`);
    const raw = readText(abs);
    if (raw === null) return fail(`No such model file: processes/${id}/${rel}.`);
    const graph = extractModelGraph(rel, raw);
    if (!graph)
      return fail(`No extractor for '${rel}' — known notations: bpmn, dmn, wardley, team-topology, value-chain.`);
    return graph;
  };
  const isGraph = (g: ModelGraph | ToolResult): g is ModelGraph => !("content" in g);

  const server = new McpServer({ name: "bpm-architecture", version: "0.2.0" });

  server.registerTool(
    "list_processes",
    {
      description:
        "List all modeled business processes (processes/*/process.yaml): id, name, classification " +
        "(core | support | management), status (draft | to-be | as-is | deprecated), version, " +
        "owning team, and last_reviewed date. Use to get a portfolio overview or to find a " +
        "process id before calling get_process, get_model or who_owns.",
      annotations: READ_ONLY,
    },
    safe(() => {
      const ids = processIds();
      if (ids.length === 0) {
        return fail(`No processes found — expected processes/<id>/process.yaml under ${PROCESSES}.`);
      }
      return ok(
        ids.map((id) => {
          const meta = loadProcess(id);
          if (!meta) return { id, error: "process.yaml missing or invalid YAML" };
          return {
            id,
            name: meta.name ?? null,
            classification: meta.classification ?? null,
            status: meta.status ?? null,
            version: meta.version ?? null,
            owner: meta.owner?.team ?? null,
            last_reviewed: meta.last_reviewed ?? null,
          };
        }),
      );
    }),
  );

  server.registerTool(
    "get_process",
    {
      description:
        "Get one process in full: the complete process.yaml metadata (purpose, trigger, outcome, " +
        "ownership, value_chain/supports links, wardley.components, kpis, operations, systems, " +
        "risks, controls, automation, mining, decisions, approval, history), the list of model " +
        "and doc files in its directory, and the docs/overview.md text if present. Use for " +
        "walkthroughs and any deep question about a single process.",
      inputSchema: { id: z.string().describe("Process id = directory name under processes/, e.g. order-to-cash") },
      annotations: READ_ONLY,
    },
    safe(({ id }) => {
      const dir = join(PROCESSES, id);
      const raw = readText(join(dir, "process.yaml"));
      if (raw === null) {
        return fail(`Unknown process '${id}'. Available: ${processIds().join(", ") || "(none)"}.`);
      }
      const metadata = parseYaml(raw);
      if (metadata === null) return fail(`processes/${id}/process.yaml exists but is not valid YAML.`);
      const overview = readText(join(dir, "docs", "overview.md"));
      return ok({
        id,
        path: `processes/${id}/process.yaml`,
        metadata,
        files: listFiles(dir).filter((f) => f !== "process.yaml"),
        overview: overview ?? "(no docs/overview.md in this process)",
      });
    }),
  );

  server.registerTool(
    "get_model",
    {
      description:
        "Parse ONE model file of a process into a generic graph: nodes (id, type, name), edges " +
        "(sequence/message flows, information requirements, dependencies) and notation-specific " +
        "meta (lanes, pools, DMN hit policies + rule counts). Works for every registered notation " +
        "(BPMN, DMN, Wardley .owm, team topology .tt, value chain .vc.json). Default: the " +
        "process's primary BPMN model. Use to see the actual flow, decision structure, or to " +
        "ground any 'how does X work' answer in the real model instead of metadata.",
      inputSchema: {
        id: z.string().describe("Process id, e.g. order-to-cash"),
        file: z
          .string()
          .optional()
          .describe("Model file relative to the process dir (default: models.bpmn), e.g. decisions/credit-check.dmn"),
      },
      annotations: READ_ONLY,
    },
    safe(({ id, file }) => {
      const meta = loadProcess(id);
      if (!meta) return fail(`Unknown process '${id}'. Available: ${processIds().join(", ") || "(none)"}.`);
      const rel: string | undefined = file ?? meta.models?.bpmn;
      if (!rel)
        return fail(
          `Process '${id}' declares no primary BPMN model; pass file= one of: ${declaredModels(meta).join(", ")}.`,
        );
      const graph = graphFor(id, rel);
      return isGraph(graph) ? ok({ id, file: rel, ...graph }) : graph;
    }),
  );

  server.registerTool(
    "enumerate_paths",
    {
      description:
        "Enumerate the possible start→end paths through a process's BPMN flow (cycle-safe, " +
        "capped). Each path is the ordered list of element names. Use for walkthroughs " +
        "('what are the ways an order can go?'), test-case derivation, and spotting unexpected " +
        "shortcuts or dead branches.",
      inputSchema: {
        id: z.string().describe("Process id, e.g. order-to-cash"),
        max: z.number().int().min(1).max(100).optional().describe("Maximum number of paths to return (default 20)"),
      },
      annotations: READ_ONLY,
    },
    safe(({ id, max }) => {
      const meta = loadProcess(id);
      if (!meta) return fail(`Unknown process '${id}'. Available: ${processIds().join(", ") || "(none)"}.`);
      if (!meta.models?.bpmn) return fail(`Process '${id}' declares no primary BPMN model.`);
      const graph = graphFor(id, meta.models.bpmn);
      if (!isGraph(graph)) return graph;
      const { paths, truncated } = enumeratePaths(graph, max ?? 20);
      return ok({ id, pathCount: paths.length, truncated, paths });
    }),
  );

  server.registerTool(
    "find_cycles",
    {
      description:
        "Detect cycles (loops) in a process's BPMN sequence flow — rework loops, retry loops, " +
        "or accidental infinite loops. Returns each cycle as the ordered list of element names. " +
        "Use when analyzing process complexity, rework cost, or 'why does this case never finish'.",
      inputSchema: { id: z.string().describe("Process id, e.g. order-to-cash") },
      annotations: READ_ONLY,
    },
    safe(({ id }) => {
      const meta = loadProcess(id);
      if (!meta) return fail(`Unknown process '${id}'. Available: ${processIds().join(", ") || "(none)"}.`);
      if (!meta.models?.bpmn) return fail(`Process '${id}' declares no primary BPMN model.`);
      const graph = graphFor(id, meta.models.bpmn);
      if (!isGraph(graph)) return graph;
      const cycles = findCycles(graph);
      return ok(cycles.length === 0 ? `No cycles in ${id}'s sequence flow.` : { id, cycles });
    }),
  );

  server.registerTool(
    "query_kpis",
    {
      description:
        "Query KPIs across the whole portfolio: every process's kpis[] with name, target, unit, " +
        "measured_from/measured_to elements and recorded actuals (dated measurements). Optional " +
        "case-insensitive filter on KPI name or process id. Use for 'how do we measure X', " +
        "'which KPIs miss their target', or KPI inventories.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring on KPI name or process id (default: all)"),
      },
      annotations: READ_ONLY,
    },
    safe(({ query }) => {
      const q = (query ?? "").toLowerCase();
      const rows = [];
      for (const id of processIds()) {
        const meta = loadProcess(id);
        for (const kpi of meta?.kpis ?? []) {
          if (q && !`${id} ${kpi?.name ?? ""}`.toLowerCase().includes(q)) continue;
          rows.push({ process: id, ...kpi });
        }
      }
      if (rows.length === 0)
        return ok(`No KPIs${query ? ` matching '${query}'` : ""} found (checked ${processIds().length} process(es)).`);
      return ok(rows);
    }),
  );

  server.registerTool(
    "get_landscape",
    {
      description:
        "Parse one strategic landscape model into a graph: 'wardley' (components with " +
        "visibility/evolution stage + dependencies), 'team-topology' (teams + interaction " +
        "modes), or 'value-chain' (steps + connections). Use for strategy questions: what to " +
        "automate/outsource (wardley evolution), Conway mismatches (topology vs process " +
        "handoffs), coverage gaps (value chain).",
      inputSchema: {
        view: z.enum(["wardley", "team-topology", "value-chain"]).describe("Which landscape model to load"),
      },
      annotations: READ_ONLY,
    },
    safe(({ view }) => {
      const file = {
        wardley: "wardley-map.owm",
        "team-topology": "team-topology.tt",
        "value-chain": "value-chain.vc.json",
      }[view as string];
      const raw = readText(join(LANDSCAPE, file!));
      if (raw === null) return fail(`landscape/${file} not found in this repository.`);
      const graph = extractModelGraph(file!, raw);
      return graph ? ok(graph) : fail(`Could not parse landscape/${file}.`);
    }),
  );

  server.registerTool(
    "who_owns",
    {
      description:
        "Resolve ownership of a process: owner.team (with role) and participants[] (with interaction " +
        "mode) from process.yaml, resolved against landscape/team-topology.tt into real teams " +
        "(label, type, description). Use for 'who owns X', 'who do I call about X', or handoff " +
        "and escalation questions.",
      inputSchema: { id: z.string().describe("Process id = directory name under processes/, e.g. order-to-cash") },
      annotations: READ_ONLY,
    },
    safe(({ id }) => {
      const meta = loadProcess(id);
      if (!meta) {
        return fail(`Unknown process '${id}'. Available: ${processIds().join(", ") || "(none)"}.`);
      }
      const topo = parseJson(readText(TEAM_TOPOLOGY) ?? "");
      const resolveTeam = (teamId?: string) => {
        if (!teamId) return { team: null, note: "no team set in process.yaml" };
        if (!topo?.nodes) {
          return { team: teamId, note: "landscape/team-topology.tt missing or invalid — id not resolved" };
        }
        const node = topo.nodes.find((n: { id: string }) => n.id === teamId);
        return node
          ? { team: teamId, label: node.label, type: node.type, description: node.description ?? null }
          : { team: teamId, note: "not found in landscape/team-topology.tt (broken link — run process-review)" };
      };
      return ok({
        id,
        owner: { ...resolveTeam(meta.owner?.team), role: meta.owner?.role ?? null },
        participants: (meta.participants ?? []).map((p: { team?: string; interaction?: string }) => ({
          ...resolveTeam(p?.team),
          interaction: p?.interaction ?? null,
        })),
      });
    }),
  );

  server.registerTool(
    "which_processes_use",
    {
      description:
        "Impact analysis across the portfolio: find processes whose systems[].name, " +
        "wardley.components[], owner.team / participants[].team, value chain links " +
        "(value_chain.steps[], supports[]), related_processes[], subprocesses[], decisions[] " +
        "or kpis[] match a query — case-insensitive substring. Use for 'what depends on the " +
        "ERP', 'which processes touch team-payments-platform', 'what uses the credit-check " +
        "decision', 'what realizes step-billing'.",
      inputSchema: {
        query: z
          .string()
          .describe("Case-insensitive substring, e.g. 'ERP', 'team-payments-platform', 'step-billing', 'credit-check'"),
      },
      annotations: READ_ONLY,
    },
    safe(({ query }) => {
      const q = query.toLowerCase();
      const hits = [];
      for (const id of processIds()) {
        const meta = loadProcess(id);
        if (!meta) continue;
        const matches: { field: string; value: string }[] = [];
        const check = (field: string, value: unknown) => {
          if (typeof value === "string" && value.toLowerCase().includes(q)) matches.push({ field, value });
        };
        for (const s of meta.systems ?? []) check("systems[].name", s?.name);
        for (const c of meta.wardley?.components ?? []) check("wardley.components[]", c);
        check("owner.team", meta.owner?.team);
        for (const p of meta.participants ?? []) check("participants[].team", p?.team);
        for (const s of meta.value_chain?.steps ?? []) check("value_chain.steps[]", s);
        for (const s of meta.supports ?? []) check("supports[]", s);
        for (const r of meta.related_processes ?? []) check("related_processes[].id", r?.id);
        for (const sp of meta.subprocesses ?? []) check("subprocesses[].id", sp?.id);
        for (const d of meta.decisions ?? []) check("decisions[].id", d?.id);
        for (const k of meta.kpis ?? []) check("kpis[].name", k?.name);
        if (matches.length > 0) {
          hits.push({ id, name: meta.name ?? null, classification: meta.classification ?? null, matches });
        }
      }
      if (hits.length === 0) {
        return ok(
          `No process references '${query}' in systems, wardley components, teams, value chain ` +
            `links, related processes, subprocesses, decisions or KPIs (checked ${processIds().length} process(es)).`,
        );
      }
      return ok(hits);
    }),
  );

  server.registerTool(
    "search_glossary",
    {
      description:
        "Look up a term in landscape/glossary.yaml — the organization's ubiquitous language. " +
        "Matches term, synonyms, and definition (case-insensitive substring) and returns term, " +
        "definition, and synonyms. Use when a word in a question may be org-specific jargon or a " +
        "synonym in another language (e.g. 'dunning', 'Mahnung', 'DSO').",
      inputSchema: { term: z.string().describe("Word or phrase to look up, e.g. 'dunning' or 'DSO'") },
      annotations: READ_ONLY,
    },
    safe(({ term }) => {
      const text = readText(GLOSSARY);
      if (text === null) return fail("landscape/glossary.yaml not found — this repository has no glossary yet.");
      const entries = parseYaml(text)?.terms;
      if (!Array.isArray(entries)) return fail("landscape/glossary.yaml is invalid or has no terms[] list.");
      const q = term.toLowerCase();
      const matches = entries
        .filter((e) =>
          [e?.term, e?.definition, ...(e?.synonyms ?? [])].some(
            (v) => typeof v === "string" && v.toLowerCase().includes(q),
          ),
        )
        .map((e) => ({ term: e.term, definition: e.definition, synonyms: e.synonyms ?? [] }));
      if (matches.length === 0) {
        return ok(`No glossary entry matches '${term}' (${entries.length} terms defined in landscape/glossary.yaml).`);
      }
      return ok(matches);
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
        const labels = processId ? `todo,process:${processId}` : "todo";
        const res = await fetch(
          `${api}/repos/${todosRepo}/issues?state=open&labels=${encodeURIComponent(labels)}&per_page=100`,
          {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${todosToken}`,
              "user-agent": "bpmiq-mcp",
            },
          },
        );
        if (!res.ok) return fail(`Tracker query on ${todosRepo} failed: ${res.status} ${await res.text()}`);
        const rows = (await res.json()) as Array<{
          number: number;
          html_url: string;
          title: string;
          body: string | null;
          assignees?: Array<{ login: string }>;
          created_at: string;
          /** present on PULL REQUESTS — GitHub returns them in the issues list */
          pull_request?: unknown;
        }>;
        const todos = rows
          .filter((row) => row.pull_request === undefined)
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

  return server;
}
