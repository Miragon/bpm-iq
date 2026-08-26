/**
 * The wire-envelope peek (domain/sync-message.ts, #115) — only SYNC payloads
 * may count against the doc-size guard; awareness (live cursors) is constant
 * traffic that never grows the doc. Envelopes are hand-encoded here with the
 * same lib0 varint scheme Hocuspocus uses (7 data bits, high bit continues).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { growsDocument } from "../src/domain/sync-message.ts";

function varUint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) return [...bytes, byte];
    bytes.push(byte | 0x80);
  }
}

/** varString(documentName) + varUint(messageType) + payload */
function envelope(documentName: string, messageType: number, payload: number[] = [1, 2, 3]): Uint8Array {
  const name = [...new TextEncoder().encode(documentName)];
  return new Uint8Array([...varUint(name.length), ...name, ...varUint(messageType), ...payload]);
}

const ROOM = "acme/models/processes/order/order.bpmn";

test("sync and syncReply grow the document", () => {
  assert.equal(growsDocument(envelope(ROOM, 0)), true, "Sync");
  assert.equal(growsDocument(envelope(ROOM, 4)), true, "SyncReply");
});

test("awareness and other ephemeral types never do", () => {
  assert.equal(growsDocument(envelope(ROOM, 1)), false, "Awareness");
  assert.equal(growsDocument(envelope(ROOM, 3)), false, "QueryAwareness");
  assert.equal(growsDocument(envelope(ROOM, 5)), false, "Stateless");
  assert.equal(growsDocument(envelope(ROOM, 8)), false, "SyncStatus");
  assert.equal(growsDocument(envelope(ROOM, 9)), false, "Ping");
});

test("room names with multibyte chars and the \\0 cache-key suffix still parse", () => {
  assert.equal(growsDocument(envelope("bü-repo/ördner/ß.bpmn", 1)), false);
  // Hocuspocus appends "\0<address>" INSIDE the name string on some paths
  assert.equal(growsDocument(envelope(`${ROOM}\0peer-7`, 1)), false);
});

test("a multi-byte varint message type parses (types ≥ 128 hypothetically)", () => {
  assert.equal(growsDocument(envelope(ROOM, 300)), false);
});

test("malformed input counts conservatively as document growth", () => {
  assert.equal(growsDocument(new Uint8Array([])), true, "empty");
  assert.equal(growsDocument(new Uint8Array([0x85])), true, "dangling continuation bit");
  // name length says 100 bytes but the message ends — truncated
  assert.equal(growsDocument(new Uint8Array([100, 1, 2, 3])), true);
  // varint longer than anything lib0 emits (9 continuation bytes)
  assert.equal(growsDocument(new Uint8Array(Array(10).fill(0xff))), true);
  // 50 zero bytes decode as name "" + type Sync — the guard keeps seeing
  // the byte flood the old collab test sends (backwards compatible)
  assert.equal(growsDocument(new Uint8Array(50)), true);
});
