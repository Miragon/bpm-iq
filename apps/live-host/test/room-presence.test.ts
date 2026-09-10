/**
 * Room presence (src/application/room-presence.ts) — peersOfDocument against
 * a REAL Hocuspocus Document (the awareness + connection bookkeeping the
 * server composes over), roomPresence over raw peers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Document } from "@hocuspocus/server";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { AgentPresence } from "../src/application/agent-presence.ts";
import { peersOfDocument, roomPresence } from "../src/application/room-presence.ts";

const ROOM = "acme/models/processes/order.bpmn";

/** a peer's state lands in the document's awareness the way a ws message
 *  would: encoded from the peer's own Awareness (its clientID), applied to
 *  the document's. Returns the peer's clientID. */
function announce(doc: Document, state: Record<string, unknown>): number {
  const peer = new Awareness(new Y.Doc());
  peer.setLocalState(state);
  applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), { source: "local" });
  const id = peer.clientID;
  peer.destroy();
  return id;
}

/** the connection bookkeeping Hocuspocus keeps per ws connection */
function connect(doc: Document, login: string, clientIds: number[]): void {
  // context as onAuthenticate admits it; address + send because the document
  // broadcasts its (flushed) awareness updates to every registered connection
  const connection = { context: { user: { login, provider: "github" } }, messageAddress: doc.name, send: () => {} };
  doc.connections.set(connection as never, { clients: new Set(clientIds) });
}

test("peersOfDocument: every peer state, stamped with the login of the connection that announced it", () => {
  const doc = new Document(ROOM);
  const petra = announce(doc, {
    user: { name: "Petra", color: "#fa8100" },
    canvas: { cursor: null, selection: ["A"] },
  });
  const kai = announce(doc, { user: { name: "Kai", color: "#0aa2c0" } });
  connect(doc, "petra", [petra]);
  connect(doc, "kai", [kai]);
  // a server-published agent lease has no connection behind it
  const agents = new AgentPresence({ awarenessOf: (r) => (r === ROOM ? doc.awareness : undefined) });
  agents.touch(ROOM, { login: "kai", name: "Kai" });

  const peers = peersOfDocument(doc).sort((a, b) => a.clientId - b.clientId);
  assert.equal(peers.length, 3);
  const byId = new Map(peers.map((p) => [p.clientId, p]));
  assert.equal(byId.get(petra)?.login, "petra");
  assert.equal(byId.get(kai)?.login, "kai");
  const agent = peers.find((p) => p.clientId !== petra && p.clientId !== kai)!;
  assert.equal(agent.login, undefined, "no ws connection — no server-side identity");
  assert.equal((agent.state as { user: { kind: string } }).user.kind, "agent");

  agents.destroy();
  // Hocuspocus' Document.destroy() leaves the y-protocols check interval
  // running — the suite must end its own awareness or the runner never exits
  doc.awareness.destroy();
  doc.destroy();
});

test("roomPresence: sanitized peers, `you` on the caller's own HUMAN presence only, un-announced skipped", () => {
  const peers = roomPresence(
    {
      peersOf: () => [
        {
          clientId: 1,
          login: "petra",
          state: { user: { name: "Petra", color: "#fa8100" }, canvas: { cursor: { x: 1, y: 2 }, selection: ["A", 7] } },
        },
        { clientId: 2, login: "petra", state: { user: { name: "AI · Petra", color: "#000", kind: "agent" } } },
        { clientId: 3, login: "kai", state: { user: { name: "Kai", color: "#000", kind: "robot" }, canvas: "nope" } },
        { clientId: 4, login: "mia", state: { selection: { anchor: 1 } } },
        { clientId: 5, state: null },
      ],
    },
    ROOM,
    "petra",
  );
  assert.deepEqual(peers, [
    { name: "Petra", kind: "human", you: true, selection: ["A"], cursor: { x: 1, y: 2 } },
    { name: "AI · Petra", kind: "agent", you: false, selection: [], cursor: null },
    { name: "Kai", kind: "human", you: false, selection: [], cursor: null },
  ]);
  assert.deepEqual(roomPresence({}, ROOM, "petra"), [], "no port = nobody");
});
