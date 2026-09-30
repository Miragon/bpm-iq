/**
 * The A/B benchmark of ADR 0008: the same tasks on the same models, solved by an agent with today's XML tools (arm A)
 * or with the semantic tools (arm B), against a local live host's /mcp. One JSONL record per run: oracle verdict,
 * validator result, tokens and cost, wall time, tool calls, failed saves, collateral changes, layout defects.
 *
 *   node packages/bpmn-edit/bench/agent/run.ts --dry-run [--mcp http://localhost:8311/mcp --repo bench/models]
 *   node packages/bpmn-edit/bench/agent/run.ts --out results.jsonl [--reps 5] [--arms A,B] [--tasks <regex>]
 *        [--model claude-opus-5] [--effort high] [--max-turns 40] [--no-fallbacks]
 *
 * --dry-run spends nothing: per task it proves the oracle FAILS on the untouched model and PASSES on the reference
 * solution applied through the real edit_process tool, with no validator error and no collateral change. A live run
 * costs API tokens: it needs ANTHROPIC_API_KEY (or an `ant auth login` profile) and the user's go.
 */
import { appendFileSync } from "node:fs";

import type Anthropic from "@anthropic-ai/sdk";
import { checkBpmnXml } from "@bpmiq/validator";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { measure } from "../../src/metrics/metrics.ts";
import { generateModel } from "../generate.ts";
import { BENCH_MODELS } from "./prepare.ts";
import { collateral, editTasks, processOf, scaffoldTasks, type Task } from "./tasks.ts";

const ARM_TOOLS: Readonly<Record<"A" | "B", readonly string[]>> = {
  // today: read and write the whole XML
  A: ["list_processes", "get_process", "get_bpmn_xml", "save_bpmn_xml", "validate_bpmn", "create_process"],
  // ADR 0008: semantic operations; the XML tools stay as a fallback and their use is recorded
  B: [
    "list_processes",
    "get_process",
    "get_process_outline",
    "edit_process",
    "layout_process",
    "create_process",
    "get_bpmn_xml",
    "save_bpmn_xml",
  ],
};

/** $ per million tokens (skill model table, 2026-06): input, output; cache write 1.25x, cache read 0.1x of input */
const PRICES: Readonly<Record<string, readonly [number, number]>> = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5-1": [10, 50],
};

const SYSTEM = [
  "You maintain BPMN process models in the repository {repo} through the tools you are given.",
  "Carry out the request completely and keep everything else in the model as it is.",
  "Models follow these conventions: tasks verb + object, events object + past participle, gateways as questions,",
  "lanes are roles, every flow node belongs to a lane, and every model has a complete diagram (BPMNDI).",
  "When you are done, answer with one line saying what you changed.",
].join(" ");

interface Options {
  readonly mcp: string;
  readonly repo: string;
  readonly out: string;
  readonly reps: number;
  readonly arms: readonly ("A" | "B")[];
  readonly tasks: RegExp;
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxTurns: number;
  readonly fallbacks: boolean;
  readonly dryRun: boolean;
}

function options(argv: readonly string[]): Options {
  const value = (flag: string, fallback: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : (argv[index + 1] ?? fallback);
  };
  return {
    mcp: value("--mcp", "http://localhost:8311/mcp"),
    repo: value("--repo", "bench/models"),
    out: value("--out", "bench-results.jsonl"),
    reps: Number(value("--reps", "5")),
    arms: value("--arms", "A,B").split(",") as ("A" | "B")[],
    tasks: new RegExp(value("--tasks", ".")),
    model: value("--model", "claude-opus-5"),
    effort: value("--effort", "high") as Options["effort"],
    maxTurns: Number(value("--max-turns", "40")),
    fallbacks: !argv.includes("--no-fallbacks"),
    dryRun: argv.includes("--dry-run"),
  };
}

/** one MCP session against the live host */
async function mcpClient(url: string) {
  const client = new Client({ name: "bpmn-edit-bench", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n");
    return { isError: result.isError === true, text };
  };
  const json = async (name: string, args: Record<string, unknown>) => {
    const { isError, text } = await call(name, args);
    if (isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { client, call, json };
}
type Mcp = Awaited<ReturnType<typeof mcpClient>>;

const xmlOf = async (mcp: Mcp, repo: string, id: string) =>
  (await mcp.json("get_bpmn_xml", { repo, id })) as { content: string; baseVersion: string; path: string };

/** puts the model back to its original text before a run */
async function reset(mcp: Mcp, repo: string, id: string, original: string): Promise<void> {
  const current = await xmlOf(mcp, repo, id);
  if (current.content !== original) {
    await mcp.json("save_bpmn_xml", { repo, id, xml: original, baseVersion: current.baseVersion });
  }
}

/** the created process of a scaffold task, found by its name */
async function createdProcess(mcp: Mcp, repo: string, name: string): Promise<string | undefined> {
  const listed = await mcp.json("list_processes", { repo });
  const rows = (listed["processes"] ?? []) as { id: string; name?: string }[];
  return rows.find((row) => (row.name ?? "").toLowerCase() === name.toLowerCase())?.id;
}

interface Scored {
  oracle: { ok: boolean; failures: readonly string[] };
  validatorErrors: string[];
  collateral: string[];
  hardDefects: number;
}

async function score(task: Task, before: string | undefined, after: string): Promise<Scored> {
  const final = await processOf(after);
  const metrics = await measure(after, task.process);
  return {
    oracle: task.check(final),
    validatorErrors: checkBpmnXml(after, { file: `${task.process}.bpmn` })
      .findings.filter((f) => f.severity === "ERROR")
      .map((f) => f.message),
    collateral: before ? collateral(await processOf(before), final, task.mayChange) : [],
    hardDefects: metrics.reduce((t, m) => t + m.shapeOverlaps + m.edgeThroughShape + m.outsideFrames, 0),
  };
}

// ── dry run: the oracles are sound ──────────────────────────────────────────────────────────────────────────────
async function dryRun(opts: Options, mcp: Mcp, tasks: readonly Task[], originals: Map<string, string>) {
  let problems = 0;
  for (const task of tasks) {
    const report: string[] = [];
    if (task.kind === "edit") {
      const original = originals.get(task.process) ?? "";
      await reset(mcp, opts.repo, task.process, original);
      if (task.check(await processOf(original)).ok) report.push("oracle passes on the UNTOUCHED model");
      const edited = await mcp.call("edit_process", { repo: opts.repo, id: task.process, operations: task.reference });
      if (edited.isError) report.push(`reference failed: ${edited.text}`);
      const after = (await xmlOf(mcp, opts.repo, task.process)).content;
      const s = await score(task, original, after);
      if (!s.oracle.ok) report.push(`oracle fails on the reference: ${s.oracle.failures.join("; ")}`);
      if (s.validatorErrors.length) report.push(`validator: ${s.validatorErrors.join("; ")}`);
      if (s.collateral.length) report.push(`collateral: ${s.collateral.join("; ")}`);
      if (s.hardDefects) report.push(`${s.hardDefects} hard layout defects`);
      await reset(mcp, opts.repo, task.process, original);
    } else {
      const created = await mcp.json("create_process", { repo: opts.repo, name: task.process });
      const id = (created["process"] as { id: string }).id;
      const blank = (await xmlOf(mcp, opts.repo, id)).content;
      if (task.check(await processOf(blank)).ok) report.push("oracle passes on the BLANK model");
      const edited = await mcp.call("edit_process", { repo: opts.repo, id, operations: task.reference });
      if (edited.isError) report.push(`reference failed: ${edited.text}`);
      await mcp.call("layout_process", { repo: opts.repo, id, mode: "layout" });
      const s = await score(task, undefined, (await xmlOf(mcp, opts.repo, id)).content);
      if (!s.oracle.ok) report.push(`oracle fails on the reference: ${s.oracle.failures.join("; ")}`);
      if (s.validatorErrors.length) report.push(`validator: ${s.validatorErrors.join("; ")}`);
      if (s.hardDefects) report.push(`${s.hardDefects} hard layout defects`);
    }
    problems += report.length > 0 ? 1 : 0;
    console.log(
      `${report.length === 0 ? "ok  " : "FAIL"} ${task.id}${report.length ? `\n     - ${report.join("\n     - ")}` : ""}`,
    );
  }
  console.log(`\n${tasks.length - problems}/${tasks.length} tasks sound`);
  if (problems > 0) process.exitCode = 1;
}

// ── live run: one agent loop ────────────────────────────────────────────────────────────────────────────────────
interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

async function agentRun(opts: Options, anthropic: Anthropic, mcp: Mcp, tools: Anthropic.Beta.BetaTool[], task: Task) {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task.prompt }];
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const calls: Record<string, number> = {};
  let toolErrors = 0;
  let failedSaves = 0;
  let firstSaveValid: boolean | undefined;
  let turns = 0;
  let stop = "";
  const models = new Set<string>();
  const started = performance.now();
  while (turns < opts.maxTurns) {
    turns++;
    const response = await anthropic.beta.messages.create({
      model: opts.model,
      max_tokens: 32000,
      system: SYSTEM.replace("{repo}", opts.repo),
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort },
      cache_control: { type: "ephemeral" },
      ...(opts.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    models.add(response.model);
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    stop = response.stop_reason ?? "";
    messages.push({ role: "assistant", content: response.content });
    if (stop === "pause_turn") continue;
    if (stop !== "tool_use") break;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      calls[block.name] = (calls[block.name] ?? 0) + 1;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const { isError, text } = await mcp.call(block.name, input);
      const saving = block.name === "save_bpmn_xml" || block.name === "edit_process" || block.name === "layout_process";
      const refused = isError || /"conflict":\s*true/.test(text);
      if (isError) toolErrors++;
      if (saving && refused) failedSaves++;
      if (saving && firstSaveValid === undefined) firstSaveValid = !refused;
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: text,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  return {
    usage,
    calls,
    toolErrors,
    failedSaves,
    firstSaveValid,
    turns,
    stop,
    models: [...models],
    ms: performance.now() - started,
  };
}

function cost(model: string, usage: Usage): number {
  const [input, output] = PRICES[model] ?? PRICES["claude-opus-5"]!;
  return (
    (usage.input * input + usage.cacheWrite * input * 1.25 + usage.cacheRead * input * 0.1 + usage.output * output) /
    1_000_000
  );
}

async function liveRun(opts: Options, mcp: Mcp, tasks: readonly Task[], originals: Map<string, string>) {
  // loaded only for a live run: the dry run needs neither the SDK nor credentials
  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  const anthropic = new AnthropicClient();
  const listed = await mcp.client.listTools();
  const toolsOf = (arm: "A" | "B"): Anthropic.Beta.BetaTool[] =>
    listed.tools
      .filter((tool) => ARM_TOOLS[arm].includes(tool.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));
  for (const arm of opts.arms) {
    const missing = ARM_TOOLS[arm].filter((name) => !listed.tools.some((tool) => tool.name === name));
    if (missing.length)
      throw new Error(`arm ${arm}: the live host lacks ${missing.join(", ")} (LIVE_MCP_BPMN_EDIT=1?)`);
  }
  for (let rep = 1; rep <= opts.reps; rep++) {
    for (const base of tasks) {
      for (const arm of opts.arms) {
        const task =
          base.kind === "scaffold"
            ? (scaffoldTasks(`${arm}${rep}`).find((candidate) => candidate.id === base.id) ?? base)
            : base;
        const original = originals.get(task.process);
        if (original) await reset(mcp, opts.repo, task.process, original);
        const run = await agentRun(opts, anthropic, mcp, toolsOf(arm), task);
        const id = task.kind === "scaffold" ? await createdProcess(mcp, opts.repo, task.process) : task.process;
        const after = id ? (await xmlOf(mcp, opts.repo, id)).content : undefined;
        const scored = after
          ? await score(task, original, after)
          : { oracle: { ok: false, failures: ["no process"] }, validatorErrors: [], collateral: [], hardDefects: 0 };
        const record = {
          task: task.id,
          kind: task.kind,
          size: task.size,
          arm,
          rep,
          model: opts.model,
          effort: opts.effort,
          success: scored.oracle.ok,
          failures: scored.oracle.failures,
          validatorErrors: scored.validatorErrors.length,
          collateral: scored.collateral.length,
          collateralDetail: scored.collateral,
          hardDefects: scored.hardDefects,
          ...run,
          costUsd: cost(opts.model, run.usage),
          xmlFallback: arm === "B" ? (run.calls["save_bpmn_xml"] ?? 0) > 0 : undefined,
          at: new Date().toISOString(),
        };
        appendFileSync(opts.out, `${JSON.stringify(record)}\n`);
        console.log(
          `${record.success ? "✔" : "✖"} ${arm} ${task.id} rep ${rep}: ${run.turns} turns, ` +
            `${run.usage.input + run.usage.cacheRead + run.usage.cacheWrite}+${run.usage.output} tokens, ` +
            `$${record.costUsd.toFixed(3)}, ${(run.ms / 1000).toFixed(1)} s`,
        );
        if (original) await reset(mcp, opts.repo, task.process, original);
      }
    }
  }
}

const opts = options(process.argv.slice(2));
const mcp = await mcpClient(opts.mcp);
const originals = new Map<string, string>();
const tasks: Task[] = [];
for (const { size, seed } of BENCH_MODELS) {
  // the original is recomputed (the generator is deterministic), never read back: a crashed run cannot shift it
  const { id, xml } = await generateModel(size, seed);
  originals.set(id, xml);
  tasks.push(...(await editTasks(size, id, xml)));
}
tasks.push(...scaffoldTasks(opts.dryRun ? `dry ${Date.now().toString(36)}` : "template"));
const selected = tasks.filter((task) => opts.tasks.test(task.id));
console.log(
  `${selected.length} tasks, arms ${opts.arms.join("/")}, ${opts.dryRun ? "dry run" : `${opts.reps} reps, ${opts.model}`}`,
);
if (opts.dryRun) {
  await dryRun(opts, mcp, selected, originals);
} else {
  await liveRun(opts, mcp, selected, originals);
}
await mcp.client.close();
