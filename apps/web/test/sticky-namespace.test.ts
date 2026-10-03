/**
 * The sticky namespace is FROZEN (src/notations/bpmn-sticky/sticky-moddle.ts,
 * sticky-model.ts): its uri and prefix are written into customer .bpmn files,
 * so they never follow a product rename. A file written by today's modeler
 * must keep opening TYPED — the stickies as sticky elements, the workshop flag
 * as the mode property — and must be saved back under the same namespace.
 * Parsed with the real descriptor and the real bpmn-moddle, because a renamed
 * descriptor fails without any error: moddle keeps the unknown elements as
 * generic extension content and the stickies are simply gone from the canvas.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { stickyModdle } from "../src/notations/bpmn-sticky/sticky-moddle.ts";
import {
  isWorkshopMode,
  type ModdleLike,
  processesOf,
  stickiesOf,
  STICKY_TYPE,
} from "../src/notations/bpmn-sticky/sticky-model.ts";

interface Moddle {
  fromXML(xml: string): Promise<{ rootElement: ModdleLike; warnings: unknown[] }>;
  toXML(element: ModdleLike, options?: { format?: boolean }): Promise<{ xml: string }>;
}

// bpmn-moddle is bpmn-js's dependency, not ours — resolved THROUGH bpmn-js, so
// the file is parsed by the very moddle the editor bundles
const viaBpmnJs = createRequire(import.meta.resolve("bpmn-js"));
const { BpmnModdle } = (await import(pathToFileURL(viaBpmnJs.resolve("bpmn-moddle")).href)) as {
  BpmnModdle: new (packages: Record<string, unknown>) => Moddle;
};
// the editor's wiring: bpmn-js hands its moddleExtensions map to BpmnModdle as
// is (src/notations/bpmn-editor.ts) — the key is only a label
const moddle = (): Moddle => new BpmnModdle({ sticky: stickyModdle });

// The frozen spellings, written in two halves ON PURPOSE: a search/replace of
// the product name rewrites the descriptor AND the fixture below in the same
// breath, and every round-trip stays green — this spelling it cannot reach.
const PREFIX = "bpm" + "iq";
const URI = `https://${PREFIX}.io/schema/1.0/${PREFIX}`;

/** a workshop file as a customer's repo holds it — written by the modeler
 *  before any rename */
const LEGACY_WORKSHOP_BPMN = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"`,
  ` xmlns:bpmiq="https://bpmiq.io/schema/1.0/bpmiq"`, // legacy-name-ok: persisted in customer .bpmn files
  ` id="Defs_1" targetNamespace="http://bpmn.io/schema/bpmn" bpmiq:mode="workshop">`, // legacy-name-ok: persisted
  `  <bpmn:process id="order" isExecutable="false">`,
  `    <bpmn:extensionElements>`,
  `      <bpmiq:sticky id="Sticky_a" text="really manual?" x="100" y="20" kind="question" width="140" height="120" />`, // legacy-name-ok: persisted
  `      <bpmiq:sticky id="Sticky_b" text="v1 scope agreed" x="260" y="20" kind="decision" />`, // legacy-name-ok: persisted
  `    </bpmn:extensionElements>`,
  `    <bpmn:startEvent id="Start_1" name="Order placed" />`,
  `  </bpmn:process>`,
  `</bpmn:definitions>`,
].join("\n");

test("the descriptor's uri and prefix are frozen, and STICKY_TYPE carries that prefix", () => {
  assert.equal(stickyModdle.uri, URI);
  assert.equal(stickyModdle.prefix, PREFIX);
  assert.equal(stickyModdle.name, stickyModdle.prefix);
  // moddle names a parsed element "<prefix>:<type name>" — the constant every
  // sticky module compares against must be exactly that
  assert.equal(STICKY_TYPE, `${PREFIX}:Sticky`);
});

test("a workshop file written before any rename opens typed: stickies and the workshop flag", async () => {
  const { rootElement: definitions, warnings } = await moddle().fromXML(LEGACY_WORKSHOP_BPMN);
  assert.deepEqual(warnings, []);
  assert.equal(definitions.mode, "workshop");
  assert.equal(isWorkshopMode(definitions), true);

  const [process] = processesOf(definitions);
  assert.ok(process);
  const stickies = stickiesOf(process);
  assert.deepEqual(
    stickies.map((s) => s.$type),
    [STICKY_TYPE, STICKY_TYPE],
  );
  // numbers, not strings: the attributes went through the descriptor's types —
  // an element moddle does not know keeps every attribute as a raw string
  const { id, text, x, y, width, height, kind } = stickies[0]!;
  assert.deepEqual(
    { id, text, x, y, width, height, kind },
    { id: "Sticky_a", text: "really manual?", x: 100, y: 20, width: 140, height: 120, kind: "question" },
  );
});

test("saving keeps the namespace: declaration, sticky tags and the mode attribute", async () => {
  const editor = moddle();
  const { rootElement: definitions } = await editor.fromXML(LEGACY_WORKSHOP_BPMN);
  const { xml } = await editor.toXML(definitions, { format: true });
  assert.ok(xml.includes(`xmlns:${PREFIX}="${URI}"`), xml);
  assert.ok(xml.includes(`${PREFIX}:mode="workshop"`), xml);
  assert.equal(xml.split(`<${PREFIX}:sticky `).length - 1, 2, xml);
  // and the saved file reads back the same — what the next client opens
  const reread = await moddle().fromXML(xml);
  assert.equal(isWorkshopMode(reread.rootElement), true);
  assert.deepEqual(
    stickiesOf(processesOf(reread.rootElement)[0]!).map((s) => s.id),
    ["Sticky_a", "Sticky_b"],
  );
});
