/**
 * Writes the content repo the A/B benchmark runs against: a root bpmiq.yml and the seeded S, M and L models. Serve it
 * with a local live host (no login, the semantic tools on):
 *
 *   node packages/bpmn-edit/bench/agent/prepare.ts <dir>
 *   LIVE_AUTH=none LIVE_MCP_BPMN_EDIT=1 LIVE_HOST_CONTENT_DIR=<dir> GITHUB_REPO=bench/models \
 *     LIVE_DATA_DIR=<dir>/.live PORT=8311 LIVE_PUBLIC_URL=http://localhost:8311 pnpm live-host
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { generateModel } from "../generate.ts";

export const BENCH_MODELS = [
  { size: "S", seed: 1 },
  { size: "M", seed: 1 },
  { size: "L", seed: 1 },
] as const;

export async function prepare(directory: string): Promise<string[]> {
  mkdirSync(join(directory, "processes"), { recursive: true });
  writeFileSync(join(directory, "bpmiq.yml"), "models: processes\n");
  const ids: string[] = [];
  for (const { size, seed } of BENCH_MODELS) {
    const { id, xml } = await generateModel(size, seed);
    writeFileSync(join(directory, "processes", `${id}.bpmn`), xml);
    ids.push(id);
  }
  return ids;
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? "bench-content");
  const ids = await prepare(directory);
  console.log(`content repo written to ${directory}: ${ids.join(", ")}`);
  console.log(
    `serve it: LIVE_AUTH=none LIVE_MCP_BPMN_EDIT=1 LIVE_HOST_CONTENT_DIR=${directory} GITHUB_REPO=bench/models ` +
      `LIVE_DATA_DIR=${directory}/.live PORT=8311 LIVE_PUBLIC_URL=http://localhost:8311 pnpm live-host`,
  );
}
