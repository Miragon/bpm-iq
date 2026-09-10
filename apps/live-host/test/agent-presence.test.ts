/**
 * Agent presence (src/application/agent-presence.ts) — the awareness lease an
 * MCP call leaves in a room, against a REAL y-protocols Awareness standing in
 * for a Hocuspocus room's: what a co-editor's client would receive.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AWARENESS_CANVAS_KEY, AWARENESS_USER_KEY, presenceColor, type PresenceUser } from "@bpmiq/contracts/live";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { AgentPresence, agentPresenceUser } from "../src/application/agent-presence.ts";

const ROOM = "acme/models/processes/order.bpmn";
const petra = { login: "petra", name: "Petra Muster" };

/** the room's awareness as a co-editor sees it: the remote states only */
function remoteStates(room: Awareness) {
  return [...room.getStates().entries()]
    .filter(([id]) => id !== room.clientID)
    .map(([, state]) => state as { user: PresenceUser; canvas: { cursor: null; selection: string[] } });
}

function setup(ttlMs?: number) {
  const room = new Awareness(new Y.Doc());
  const changes: Array<{ added: number[]; removed: number[] }> = [];
  room.on("change", ({ added, removed }: { added: number[]; removed: number[] }) => changes.push({ added, removed }));
  let loaded = true;
  const presence = new AgentPresence({ awarenessOf: (r) => (loaded && r === ROOM ? room : undefined), ttlMs });
  /** every test ends here: the room awareness runs y-protocols' check
   *  interval and would keep the test process alive */
  const done = () => {
    presence.destroy();
    room.destroy();
  };
  return { room, changes, presence, done, unload: () => (loaded = false), load: () => (loaded = true) };
}

test("a touch publishes a server-asserted agent state into the room; a co-editor sees it as a peer", () => {
  const { room, changes, presence, done } = setup();
  presence.touch(ROOM, petra);
  const [state] = remoteStates(room);
  assert.ok(state, "the agent is a remote state of the room");
  assert.deepEqual(state.user, {
    name: "AI · Petra Muster",
    color: presenceColor("agent:petra"),
    avatarUrl: null,
    kind: "agent",
  });
  assert.deepEqual(state.canvas, { cursor: null, selection: [] });
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.added.length, 1, "the room broadcasts an ADDED peer");
  assert.equal(presence.size, 1);
  done();
});

test("the agent's own color differs from the person's — two participants on one canvas", () => {
  assert.notEqual(agentPresenceUser(petra).color, presenceColor("petra"));
  assert.equal(agentPresenceUser({ login: "x", name: "" }).name, "AI · x", "login stands in for an empty name");
});

test("a save publishes the changed elements as the selection; a later read keeps them", () => {
  const { room, presence, done } = setup();
  presence.touch(ROOM, petra, () => ({ cursor: null, selection: ["Task_1", "Flow_2"] }));
  assert.deepEqual(remoteStates(room)[0]!.canvas.selection, ["Task_1", "Flow_2"]);
  presence.touch(ROOM, petra); // a read: the outlines of what the agent did stay
  assert.deepEqual(remoteStates(room)[0]!.canvas.selection, ["Task_1", "Flow_2"]);
  assert.equal(remoteStates(room).length, 1, "renewals update ONE peer, never add another");
  // the next save replaces the selection — outlines reflect the LAST save
  presence.touch(ROOM, petra, () => ({ cursor: null, selection: [] }));
  assert.deepEqual(remoteStates(room)[0]!.canvas.selection, []);
  done();
});

test("nobody in the room: the canvas thunk is never evaluated, nothing is published — until someone is", () => {
  const { room, presence, done, unload, load } = setup();
  unload();
  let computed = 0;
  presence.touch(ROOM, petra, () => {
    computed++;
    return { cursor: null, selection: ["Task_1"] };
  });
  assert.equal(computed, 0, "a diff costs a parse — not for an empty room");
  assert.equal(remoteStates(room).length, 0);
  assert.equal(presence.size, 1, "the lease exists regardless");
  load();
  presence.touch(ROOM, petra);
  assert.equal(remoteStates(room).length, 1, "the renewal lands once the room is open");
  done();
});

test("the lease expires TTL after the LAST touch — the room sees a removal", async () => {
  const { room, changes, presence, done } = setup(40);
  presence.touch(ROOM, petra);
  await new Promise((r) => setTimeout(r, 25));
  presence.touch(ROOM, petra); // renewed: the first deadline must not fire
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(remoteStates(room).length, 1, "still present 50ms after the first touch");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(remoteStates(room).length, 0, "gone after the renewed deadline");
  assert.equal(presence.size, 0);
  assert.ok(changes.at(-1)!.removed.length === 1, "the room broadcast the REMOVED peer");
  done();
});

test("one lease per (room, principal): two people's agents are two peers, two rooms are two leases", () => {
  const { room, presence, done } = setup();
  presence.touch(ROOM, petra);
  presence.touch(ROOM, { login: "kai", name: "Kai" });
  presence.touch("acme/models/processes/other.bpmn", petra);
  assert.equal(remoteStates(room).length, 2);
  assert.equal(presence.size, 3);
  presence.destroy();
  assert.equal(remoteStates(room).length, 0, "destroy releases every lease into its room");
  assert.equal(presence.size, 0);
  done();
});

test("the published state uses the contract's awareness keys", () => {
  const { room, presence, done } = setup();
  presence.touch(ROOM, petra);
  const raw = remoteStates(room)[0] as Record<string, unknown>;
  assert.ok(AWARENESS_USER_KEY in raw && AWARENESS_CANVAS_KEY in raw);
  done();
});
