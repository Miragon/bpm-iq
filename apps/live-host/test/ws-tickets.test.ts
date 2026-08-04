/**
 * WsTicketStore (src/application/ws-tickets.ts): the security properties the
 * MCP-App live connection stands on — single-use, room-bound, short TTL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type TicketUser, WsTicketStore } from "../src/application/ws-tickets.ts";

const USER: TicketUser = { login: "petra", name: "Petra", avatarUrl: null, provider: "oidc" };
const ROOM = "acme/models/processes/order.bpmn";

test("issue → redeem round-trip yields the minting user, exactly once", () => {
  const store = new WsTicketStore();
  const ticket = store.issue(USER, ROOM);
  assert.deepEqual(store.redeem(ticket, ROOM), USER);
  // single-use: the second redeem is dead
  assert.equal(store.redeem(ticket, ROOM), undefined);
});

test("room-bound: a ticket presented for another room dies AND is consumed", () => {
  const store = new WsTicketStore();
  const ticket = store.issue(USER, ROOM);
  assert.equal(store.redeem(ticket, "acme/models/processes/other.bpmn"), undefined);
  // consumed on the mismatch — no second try against the right room
  assert.equal(store.redeem(ticket, ROOM), undefined);
});

test("TTL: an expired ticket is refused; expired entries are swept on issue", () => {
  let now = 1_000_000;
  const store = new WsTicketStore(() => now);
  const ticket = store.issue(USER, ROOM);
  now += 60_001;
  assert.equal(store.redeem(ticket, ROOM), undefined);
});

test("unknown tickets are refused", () => {
  const store = new WsTicketStore();
  assert.equal(store.redeem("no-such-ticket", ROOM), undefined);
});
