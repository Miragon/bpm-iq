// Manual end-to-end smoke client for the Live Host's /mcp endpoint.
// Requires a running Live Host with a dev token:
//   LIVE_DEV_TOKEN=smoke-dev-token pnpm live-host
//   SMOKE_TOKEN=smoke-dev-token node apps/live-host/scripts/mcp-smoke.mjs [mcpUrl] [repo]
// Uses the official MCP SDK (resolved via node_modules) over Streamable HTTP.
// Reads + no-op saves only — never create_process/release_process (a release
// would open a REAL GitHub PR).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.argv[2] ?? "http://localhost:8301/mcp";
const REPO = process.argv[3] ?? "Miragon/bpm-iq";
const TOKEN = process.env.SMOKE_TOKEN ?? process.env.LIVE_DEV_TOKEN;
if (!TOKEN) {
  console.error("set SMOKE_TOKEN (or LIVE_DEV_TOKEN) to the Live Host's dev token — /mcp always authenticates");
  process.exit(2);
}

const out = (label, v) => console.log(`\n### ${label}\n` + (typeof v === "string" ? v : JSON.stringify(v, null, 2)));
const parsed = (r) => (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);

const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "live-host-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
out("tools/list", tools.tools.map((t) => t.name).sort());

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} errored: ${JSON.stringify(r.content)}`);
  return parsed(r);
};

// 1) list repos
const repos = await call("list_repos");
out(
  "list_repos",
  repos.repos.map((r) => `${r.fullName} (perm=${r.permission}, procs=${r.processCount})`),
);

// 2) list processes
const procs = await call("list_processes", { repo: REPO });
out(
  "list_processes",
  procs.processes.map((p) => `${p.id} -> ${p.bpmn}`),
);
const first = procs.processes.find((p) => p.id === "order-to-cash") ?? procs.processes[0];

// 3) get derived process view
const view = await call("get_process", { repo: REPO, id: first.id });
out("get_process", {
  name: view.name,
  roles: view.roles?.length,
  steps: view.steps?.length,
  gateways: view.gateways?.length,
  flows: view.flows?.length,
  calls: view.calls,
  baseVersion: view.baseVersion?.slice(0, 16) + "…",
});

// 4) get live BPMN xml + baseVersion
const got = await call("get_bpmn_xml", { repo: REPO, id: first.id });
out("get_bpmn_xml", {
  path: got.path,
  xmlLength: got.xml.length,
  startsWith: got.xml.slice(0, 60),
  baseVersion: got.baseVersion.slice(0, 16) + "…",
});

// 5) validator dry-run (new tool — no write)
const dry = await call("validate_bpmn", { xml: got.xml, repo: REPO, path: got.path });
out("validate_bpmn (dry-run on the live xml)", { ok: dry.ok, findings: dry.findings.length });

// 6) save conflict guard — a stale baseVersion must NOT overwrite (no write)
const conflict = await call("save_bpmn_xml", { repo: REPO, id: first.id, xml: got.xml, baseVersion: "stale.token" });
out("save_bpmn_xml (stale baseVersion → conflict, no write)", {
  ok: conflict.ok,
  conflict: conflict.conflict,
  hasCurrentXml: typeof conflict.currentXml === "string",
});

// 7) save idempotent — identical xml with the correct baseVersion → ok (minimal-diff no-op)
const saved = await call("save_bpmn_xml", { repo: REPO, id: first.id, xml: got.xml, baseVersion: got.baseVersion });
out("save_bpmn_xml (identical xml, correct baseVersion → ok, no-op)", {
  ok: saved.ok,
  path: saved.path,
  warnings: saved.warnings,
});

// 8) validation gate — malformed BPMN must be rejected as an error
const bad = await client.callTool({
  name: "save_bpmn_xml",
  arguments: { repo: REPO, id: first.id, xml: "<not-bpmn/>", baseVersion: got.baseVersion },
});
out("save_bpmn_xml (invalid xml → validation error)", {
  isError: bad.isError,
  text: bad.content?.[0]?.text?.slice(0, 140),
});

// 9) list changes (read)
const changes = await call("list_changes", { repo: REPO });
out(
  "list_changes",
  changes.changes.map((c) => `${c.status} ${c.path}`),
);

await client.close();
console.log("\n✅ smoke complete (read + dry-run + validation + concurrency-guard paths; no create/release)");
