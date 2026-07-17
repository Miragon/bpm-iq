/** processIdFromName — the shared title→file-stem slug rule (backend create +
 *  web preview must agree, so the cases here pin the behavior). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { processIdFromName } from "../index.ts";

test("processIdFromName: kebab-cases titles", () => {
  assert.equal(processIdFromName("Order to Cash"), "order-to-cash");
  assert.equal(processIdFromName("  Order   to   Cash  "), "order-to-cash");
  assert.equal(processIdFromName("order-to-cash"), "order-to-cash");
});

test("processIdFromName: transliterates accents and ß", () => {
  assert.equal(processIdFromName("Auftragsprüfung"), "auftragsprufung");
  assert.equal(processIdFromName("Straßen-Ablauf"), "strassen-ablauf");
  assert.equal(processIdFromName("Café Réservation"), "cafe-reservation");
});

test("processIdFromName: collapses punctuation, keeps digits, trims dashes", () => {
  assert.equal(processIdFromName("2nd Level (Support)!"), "2nd-level-support");
  assert.equal(processIdFromName("a__b..c"), "a-b-c");
  assert.equal(processIdFromName("---"), "");
  assert.equal(processIdFromName("!!!"), "");
  assert.equal(processIdFromName(""), "");
});
