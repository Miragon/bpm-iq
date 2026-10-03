/**
 * The content root the environment names (packages/mcp/tools.ts:
 * contentRootFromEnv → DEFAULT_ROOT). Read under two names, the new one
 * winning; the pure resolution is tabled here, and the stdio entry point is
 * spawned to prove DEFAULT_ROOT really carries it (DEFAULT_ROOT is computed at
 * module load, so only a fresh process sees a different environment).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { contentRootFromEnv } from "../tools.ts";

const SERVER = fileURLToPath(new URL("../server.ts", import.meta.url));

test("contentRootFromEnv: the old name alone is read, exactly as before", () => {
  assert.equal(contentRootFromEnv({ BPM_CONTENT_ROOT: "/old" }), "/old"); // legacy-name-ok: env fallback
});

test("contentRootFromEnv: the new name alone is read", () => {
  assert.equal(contentRootFromEnv({ DESIGNIQ_CONTENT_ROOT: "/new" }), "/new");
});

test("contentRootFromEnv: with both names set the new one wins", () => {
  assert.equal(contentRootFromEnv({ DESIGNIQ_CONTENT_ROOT: "/new", BPM_CONTENT_ROOT: "/old" }), "/new"); // legacy-name-ok: env fallback
});

test("contentRootFromEnv: an empty new name does not shadow a set old one", () => {
  assert.equal(contentRootFromEnv({ DESIGNIQ_CONTENT_ROOT: "", BPM_CONTENT_ROOT: "/old" }), "/old"); // legacy-name-ok: env fallback
});

test("contentRootFromEnv: neither name set → undefined (DEFAULT_ROOT falls back to the bundled example)", () => {
  assert.equal(contentRootFromEnv({}), undefined);
});

test("contentRootFromEnv: an empty value alone stays '' under either name — never the bundled example", () => {
  // the old name always behaved like this (`??`, not `||`): '' resolves to the
  // cwd. The new name mirrors it, so swapping one for the other moves nothing.
  assert.equal(contentRootFromEnv({ BPM_CONTENT_ROOT: "" }), ""); // legacy-name-ok: env fallback
  assert.equal(contentRootFromEnv({ DESIGNIQ_CONTENT_ROOT: "" }), "");
  assert.equal(contentRootFromEnv({ DESIGNIQ_CONTENT_ROOT: "", BPM_CONTENT_ROOT: "" }), ""); // legacy-name-ok: env fallback
});

// ── the stdio entry point: a missing root exits 2 and names the root it used ──

/** this process's environment with ONLY the given content-root names set (both scrubbed first) */
function envWith(roots: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...roots };
  for (const name of ["DESIGNIQ_CONTENT_ROOT", "BPM_CONTENT_ROOT"]) if (!(name in roots)) delete env[name]; // legacy-name-ok: env fallback
  return env;
}

function serve(roots: Record<string, string>): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [SERVER], { env: envWith(roots), encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

/** DEFAULT_ROOT as a fresh process computes it under the given names */
function defaultRoot(roots: Record<string, string>): string {
  const tools = new URL("../tools.ts", import.meta.url).href;
  const script = `import(${JSON.stringify(tools)}).then((m) => console.log(JSON.stringify(m.DEFAULT_ROOT)))`;
  const r = spawnSync(process.execPath, ["-e", script], { env: envWith(roots), encoding: "utf8" });
  return JSON.parse(r.stdout) as string;
}

test("DEFAULT_ROOT: an empty value stays '' (the cwd) under either name — never the bundled example", () => {
  // the helper's '' has to survive the fallback to the example at the call site
  assert.equal(defaultRoot({ BPM_CONTENT_ROOT: "" }), ""); // legacy-name-ok: env fallback
  assert.equal(defaultRoot({ DESIGNIQ_CONTENT_ROOT: "" }), "");
  assert.ok(defaultRoot({}).endsWith("process-documentation"), "neither name set → the bundled example");
});

test("server.ts: the content root arrives under the old name, the new name, and the new one wins", () => {
  // two roots that cannot exist — the usage exit prints the one the server resolved
  const dir = mkdtempSync(join(tmpdir(), "designiq-mcp-root-"));
  const oldRoot = join(dir, "old");
  const newRoot = join(dir, "new");

  const viaOld = serve({ BPM_CONTENT_ROOT: oldRoot }); // legacy-name-ok: env fallback
  assert.equal(viaOld.status, 2);
  assert.ok(viaOld.stderr.includes(`content root not found: ${oldRoot}`), viaOld.stderr);

  const viaNew = serve({ DESIGNIQ_CONTENT_ROOT: newRoot });
  assert.equal(viaNew.status, 2);
  assert.ok(viaNew.stderr.includes(`content root not found: ${newRoot}`), viaNew.stderr);

  const both = serve({ DESIGNIQ_CONTENT_ROOT: newRoot, BPM_CONTENT_ROOT: oldRoot }); // legacy-name-ok: env fallback
  assert.equal(both.status, 2);
  assert.ok(both.stderr.includes(`content root not found: ${newRoot}`), both.stderr);

  const emptyNew = serve({ DESIGNIQ_CONTENT_ROOT: "", BPM_CONTENT_ROOT: oldRoot }); // legacy-name-ok: env fallback
  assert.equal(emptyNew.status, 2);
  assert.ok(emptyNew.stderr.includes(`content root not found: ${oldRoot}`), emptyNew.stderr);
});
