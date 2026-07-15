/**
 * M0 spike (Hocuspocus) — automated exit-criterion test, same four assertions as
 * the OCT variant for a like-for-like comparison:
 *
 *   1. two guests connect to the document room and receive the on-disk content
 *   2. guest A appends a marker → round-trip time until guest B sees it
 *   3. the Live Host writes the change through to disk (its debounce window)
 *   4. guest B reverts → everything syncs back, working tree clean
 *
 * Usage: pnpm test:sync   (server must be running: pnpm start)
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openLiveSession } from "@bpmiq/live-client";
import WebSocket from "ws";
import type * as Y from "yjs";

const URL = process.env.LIVE_URL ?? "ws://localhost:8301";
const TOKEN = process.env.LIVE_TOKEN ?? "demo";
// room = <owner>/<repo>/<path>; local host content lives in process-documentation
const DOC_NAME = "Miragon/bpm-iq/processes/order-to-cash/order-to-cash.bpmn";
const REL_PATH = DOC_NAME.split("/").slice(2).join("/");
const HOST_CONTENT =
  process.env.LIVE_HOST_CONTENT_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "process-documentation");
const DISK_PATH = resolve(HOST_CONTENT, REL_PATH);
const MARKER = `<!-- live-spike-${Math.floor(performance.now())} -->`;

interface Guest {
  name: string;
  ytext: Y.Text;
}

async function createGuest(name: string): Promise<Guest> {
  const session = openLiveSession({ url: URL, room: DOC_NAME, token: TOKEN, WebSocketPolyfill: WebSocket });
  try {
    await session.whenSynced(10_000);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
  return { name, ytext: session.content };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<number> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`TIMEOUT waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return performance.now() - start;
}

const diskBefore = await readFile(DISK_PATH, "utf8");
const results: string[] = [];

const [alice, bob] = await Promise.all([createGuest("alice"), createGuest("bob")]);

const tA = await waitFor("alice initial content", () => alice.ytext.toString() === diskBefore, 10_000);
const tB = await waitFor("bob initial content", () => bob.ytext.toString() === diskBefore, 10_000);
results.push(`PASS  initial sync matches disk — alice ${tA.toFixed(0)}ms, bob ${tB.toFixed(0)}ms`);

const t0 = performance.now();
alice.ytext.insert(alice.ytext.length, `\n${MARKER}`);
await waitFor("bob receives alice's edit", () => bob.ytext.toString().includes(MARKER));
results.push(`PASS  co-edit round trip alice→server→bob: ${(performance.now() - t0).toFixed(0)}ms`);

const tDisk = await waitFor(
  "write-through to disk",
  () => {
    try {
      return readFileSync(DISK_PATH, "utf8").includes(MARKER);
    } catch {
      return false;
    }
  },
  15_000,
);
results.push(`PASS  live host persisted to the working tree after ${tDisk.toFixed(0)}ms (hocuspocus debounce)`);

const idx = bob.ytext.toString().indexOf(`\n${MARKER}`);
bob.ytext.delete(idx, MARKER.length + 1);
await waitFor("alice sees revert", () => !alice.ytext.toString().includes(MARKER));
await waitFor(
  "disk clean again",
  () => {
    try {
      return !readFileSync(DISK_PATH, "utf8").includes(MARKER);
    } catch {
      return false;
    }
  },
  15_000,
);
results.push("PASS  reverse-direction edit synced and persisted — working tree clean");

console.log("\n=== M0 exit criterion (Hocuspocus) ===");
for (const r of results) console.log(r);
console.log("\nTwo guests co-edited order-to-cash.bpmn through the Live Host. ✔");
process.exit(0);
