// ADR 0008: a platform-free design core, optional Camunda 7 / Camunda 8 adapters. The core reads every spelling,
// writes the file's own, never writes a platform extension into a design model and never drops a foreign one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { layout } from "../../src/layout/layout.ts";
import { measure } from "../../src/metrics/metrics.ts";
import { applyOperations } from "../../src/operations/apply.ts";
import type { Operation } from "../../src/operations/types.ts";
import { outline } from "../../src/outline/outline.ts";
import type { ElementOutline, ProcessOutline } from "../../src/outline/types.ts";
import { detectPlatform } from "../../src/platform/detect.ts";
import { fixture, REPOSITORY_ROOT } from "../support/fixtures.ts";

/** the example content repo's model, unchanged: it names Camunda 7 and links its decision unprefixed */
const EXAMPLE = readFileSync(join(REPOSITORY_ROOT, "process-documentation", "processes", "order-to-cash.bpmn"), "utf8");
/** the same model as pure BPMN: no platform */
const DESIGN = fixture("design/order-to-cash-design.bpmn");
const C7 = fixture("c7/order-to-cash-c7.bpmn");
const C8 = fixture("c8/PlaceOrder.bpmn");
const OPTIONS = { depth: 2, bounds: true, full: true };

async function processOf(xml: string): Promise<ProcessOutline> {
  const [process] = (await outline(xml, OPTIONS, "result")).processes;
  assert.ok(process);
  return process;
}

function element(process: ProcessOutline, id: string): ElementOutline {
  const found = process.elements.find((candidate) => candidate.id === id);
  assert.ok(found, `no element ${id}`);
  return found;
}

const root = (platform: string, namespaces: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ${namespaces}${platform}><bpmn:process id="p"/></bpmn:definitions>`;

test("detectPlatform: the execution platform decides, else the engine namespace actually used, else design", () => {
  const modeler = 'xmlns:modeler="http://camunda.org/schema/modeler/1.0"';
  assert.equal(detectPlatform(root(' modeler:executionPlatform="Camunda Cloud"', modeler)), "c8");
  assert.equal(detectPlatform(root(' modeler:executionPlatform="Camunda Platform"', modeler)), "c7");
  // a declared but unused namespace is no platform
  assert.equal(detectPlatform(root("", 'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"')), "design");
  assert.equal(detectPlatform(DESIGN), "design");
  assert.equal(detectPlatform(EXAMPLE), "c7");
  assert.equal(detectPlatform(C7), "c7");
  assert.equal(detectPlatform(C8), "c8");
  // an unknown fork platform name stays design until an adapter exists
  assert.equal(detectPlatform(root(' modeler:executionPlatform="Operaton"', modeler)), "design");
});

test("design: a new user task joins its anchor lane, follows the flow id style and gets no platform extension", async () => {
  const outcome = await applyOperations(
    DESIGN,
    [
      {
        op: "insertAfter",
        after: "Task_fulfill_order",
        element: { type: "userTask", id: "Task_ship_goods", name: "Ship goods" },
      },
    ],
    "order-to-cash.bpmn",
  );
  const process = await processOf(outcome.xml);

  assert.equal(outcome.platform, "design");
  assert.equal(element(process, "Task_ship_goods").lane, "Lane_order_management");
  assert.ok(process.flows.some((flow) => flow.id === "Flow_ship_goods_to_invoice_handling"));
  assert.doesNotMatch(outcome.xml, /zeebe|camunda:/);
  assert.match(outcome.xml, /<bpmn:flowNodeRef>Task_ship_goods<\/bpmn:flowNodeRef>/);
});

test("design: an implementation detail is refused with the platform and the ADR named", async () => {
  for (const op of [
    { op: "setInput", id: "Task_fulfill_order", target: "a", source: "=b" },
    { op: "setHeader", id: "Task_fulfill_order", key: "k", value: "v" },
    {
      op: "insertAfter",
      after: "Task_fulfill_order",
      element: { type: "serviceTask", id: "Task_x", name: "X", template: { id: "T", version: 1 } },
    },
  ] satisfies Operation[]) {
    await assert.rejects(applyOperations(DESIGN, [op], "order-to-cash.bpmn"), /design model.*ADR 0008/);
  }
});

test("decision links are written in the spelling of the platform and read in every spelling", async () => {
  const add: Operation[] = [
    {
      op: "insertAfter",
      after: "Task_check_credit",
      element: { type: "businessRuleTask", id: "Task_score", name: "Score risk", calledDecision: "risk-score" },
    },
  ];
  const design = await applyOperations(DESIGN, add, "design");
  const c7 = await applyOperations(C7, add, "c7");

  assert.match(design.xml, /<bpmn:businessRuleTask id="Task_score" name="Score risk" calledDecision="risk-score">/);
  assert.match(c7.xml, /<bpmn:businessRuleTask id="Task_score" name="Score risk" camunda:decisionRef="risk-score">/);
  for (const xml of [design.xml, c7.xml]) {
    assert.equal(element(await processOf(xml), "Task_score").calledDecision, "risk-score");
  }

  const c8 = await applyOperations(
    C8,
    [
      {
        op: "insertAfter",
        after: "startEvent_orderToBePlaced",
        element: {
          type: "businessRuleTask",
          id: "businessRuleTask_score",
          name: "Score",
          calledDecision: "risk-score",
        },
      },
    ],
    "c8",
  );
  assert.match(c8.xml, /<zeebe:calledDecision decisionId="risk-score" \/>/);
  assert.ok(c8.diagnostics.some((line) => /resultVariable/.test(line)));
  assert.equal(element(await processOf(c8.xml), "businessRuleTask_score").calledDecision, "risk-score");
});

test("call links: the standard attribute in design and Camunda 7, zeebe:calledElement in Camunda 8", async () => {
  const design = await applyOperations(
    DESIGN,
    [{ op: "setCalledElement", id: "CallActivity_invoice_handling", process: "billing" }],
    "design",
  );
  assert.match(
    design.xml,
    /<bpmn:callActivity id="CallActivity_invoice_handling" name="Invoice Handling" calledElement="billing">/,
  );

  const c8 = await applyOperations(
    C8,
    [
      {
        op: "insertAfter",
        after: "startEvent_orderToBePlaced",
        element: { type: "callActivity", id: "callActivity_reserve", name: "Reserve", calledElement: "reserve-pet" },
      },
    ],
    "c8",
  );
  assert.match(c8.xml, /<zeebe:calledElement processId="reserve-pet" propagateAllChildVariables="false" \/>/);
  assert.equal(element(await processOf(c8.xml), "callActivity_reserve").calledElement, "reserve-pet");
});

test("an edit of the example model changes nothing but the edit: root tag, decision spelling and links stay", async () => {
  const outcome = await applyOperations(
    EXAMPLE,
    [
      {
        op: "insertAfter",
        after: "Task_fulfill_order",
        element: { type: "userTask", id: "Task_ship_goods", name: "Ship goods" },
      },
      {
        op: "insertAfter",
        after: "Task_check_credit",
        element: { type: "businessRuleTask", id: "Task_score", name: "Score risk", calledDecision: "risk-score" },
      },
    ],
    "order-to-cash.bpmn",
  );
  const rootOf = (xml: string): string | undefined => /<bpmn:definitions[^>]*>/.exec(xml)?.[0];

  assert.equal(rootOf(outcome.xml), rootOf(EXAMPLE));
  assert.match(outcome.xml, / name="Check credit limit" calledDecision="credit-limit-check">/);
  // the file links decisions unprefixed, so the new link does too
  assert.match(outcome.xml, / name="Score risk" calledDecision="risk-score">/);
  assert.doesNotMatch(outcome.xml, /bpmiq:|camunda:decisionRef|zeebe/);
  assert.equal(element(await processOf(outcome.xml), "Task_ship_goods").lane, "Lane_order_management");
});

test("moveToLane changes the role and moves the shape into the band of the lane", async () => {
  const outcome = await applyOperations(
    DESIGN,
    [{ op: "moveToLane", id: "Task_fulfill_order", lane: "Lane_billing" }],
    "order-to-cash.bpmn",
  );
  const process = await processOf(outcome.xml);
  const task = element(process, "Task_fulfill_order");
  const lanes = await outline(outcome.xml, OPTIONS, "r");
  const billing = lanes.processes[0]?.elements.find((candidate) => candidate.id === "CallActivity_invoice_handling");

  assert.equal(task.lane, "Lane_billing");
  // the billing lane is the band the call activity sits in: the moved task now shares its row band
  assert.ok(task.bounds && billing?.bounds);
  assert.ok(Math.abs(task.bounds.y + task.bounds.height / 2 - (billing.bounds.y + billing.bounds.height / 2)) < 100);
  const metrics = await measure(outcome.xml, "x");
  assert.deepEqual(
    metrics.map((plane) => [plane.outsideFrames, plane.shapeOverlaps]),
    metrics.map(() => [0, 0]),
  );
  await assert.rejects(
    applyOperations(DESIGN, [{ op: "moveToLane", id: "Task_fulfill_order", lane: "Lane_nope" }], "x"),
    /no lane 'Lane_nope'.*Lane_order_management/,
  );
});

test("remove takes the node out of its lane: no dangling flowNodeRef", async () => {
  const outcome = await applyOperations(DESIGN, [{ op: "remove", id: "Task_fulfill_order", reconnect: true }], "x");

  assert.doesNotMatch(outcome.xml, /Task_fulfill_order/);
});

test("foreign extensions pass through an edit untouched", async () => {
  const foreign = DESIGN.replace(
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:acme="https://acme.example/bpmn"',
  ).replace(
    '<bpmn:userTask id="Task_validate_order" name="Validate order">',
    '<bpmn:userTask id="Task_validate_order" name="Validate order" acme:sla="PT4H">\n      <bpmn:extensionElements>\n        <acme:checklist ref="validation" />\n      </bpmn:extensionElements>',
  );
  const outcome = await applyOperations(
    foreign,
    [{ op: "rename", id: "Task_fulfill_order", name: "Fulfil order" }],
    "x",
  );

  assert.match(outcome.xml, /acme:sla="PT4H"/);
  assert.match(outcome.xml, /<acme:checklist ref="validation" \/>/);
  assert.equal(outcome.platform, "design");
});

test("a sticky follows the flow node nearest to it when the layout moves that node", async () => {
  const sticky = DESIGN.replace(
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:bpmiq="https://bpmiq.io/schema/1.0/bpmiq"',
  ).replace(
    '<bpmn:process id="order-to-cash" name="Order to Cash" isExecutable="false">',
    '<bpmn:process id="order-to-cash" name="Order to Cash" isExecutable="false">\n    <bpmn:extensionElements>\n      <bpmiq:sticky id="Sticky_1" text="Why manual?" x="10000" y="10000" kind="question" width="100" height="100" />\n    </bpmn:extensionElements>',
  );
  // put the sticky right next to the fulfil task
  const task = /<bpmndi:BPMNShape id="Task_fulfill_order_di"[^>]*>\s*<dc:Bounds x="(\d+)" y="(\d+)"/.exec(sticky);
  assert.ok(task?.[1] && task[2]);
  const [tx, ty] = [Number(task[1]), Number(task[2])];
  const placed = sticky.replace('x="10000" y="10000"', `x="${tx}" y="${ty - 110}"`);

  const outcome = await layout(placed, { mode: "layout", scope: { kind: "all" } }, "x");
  const after = /<bpmndi:BPMNShape id="Task_fulfill_order_di"[^>]*>\s*<dc:Bounds x="([\d.]+)" y="([\d.]+)"/.exec(
    outcome.xml,
  );
  const note = /<bpmiq:sticky id="Sticky_1"[^>]*x="(-?\d+)" y="(-?\d+)"/.exec(outcome.xml);
  assert.ok(after?.[1] && after[2] && note?.[1] && note[2]);

  assert.ok(Math.abs(Number(note[1]) - Number(after[1])) <= 1);
  assert.ok(Math.abs(Number(note[2]) - (Number(after[2]) - 110)) <= 1);
});

test("a file without <bpmn:incoming>/<bpmn:outgoing> lists: flows are split by sourceRef, no lists appear", async () => {
  const bare = DESIGN.replace(/\n\s*<bpmn:(incoming|outgoing)>[^<]*<\/bpmn:\1>/g, "");
  assert.doesNotMatch(bare, /<bpmn:outgoing>/);
  const outcome = await applyOperations(
    bare,
    [
      {
        op: "insertAfter",
        after: "Task_fulfill_order",
        element: { type: "task", id: "Task_probe", name: "Probe" },
      },
      { op: "remove", id: "Task_reject_order", reconnect: true },
    ],
    "bare",
  );
  const process = await processOf(outcome.xml);

  assert.ok(process.flows.some((flow) => flow.from === "Task_fulfill_order" && flow.to === "Task_probe"));
  assert.ok(process.flows.some((flow) => flow.from === "Task_probe" && flow.to === "CallActivity_invoice_handling"));
  assert.ok(
    process.flows.some((flow) => flow.from === "Gateway_credit_approved" && flow.to === "EndEvent_order_rejected"),
  );
  assert.doesNotMatch(outcome.xml, /<bpmn:(incoming|outgoing)>/);
});

test("addLane + operations + layout scaffold a validator-clean process from the blank template", async () => {
  const { newBpmnXml } = await import("@bpmiq/notations/templates");
  const { checkBpmnXml } = await import("@bpmiq/validator");
  const blank = newBpmnXml("travel-request", "Travel request");
  const built = await applyOperations(
    blank,
    [
      { op: "addLane", id: "Lane_employee", name: "Employee" },
      { op: "addLane", id: "Lane_manager", name: "Manager" },
      { op: "addLane", id: "Lane_travel_office", name: "Travel Office" },
      { op: "rename", id: "StartEvent_1", name: "Trip planned" },
      { op: "rename", id: "EndEvent_1", name: "Travel booked" },
      {
        op: "insertAfter",
        after: "StartEvent_1",
        element: { type: "userTask", id: "Task_submit", name: "Submit travel request" },
      },
      {
        op: "insertAfter",
        after: "Task_submit",
        element: { type: "userTask", id: "Task_approve", name: "Approve travel request", lane: "Lane_manager" },
      },
      {
        op: "insertAfter",
        after: "Task_approve",
        element: { type: "exclusiveGateway", id: "Gateway_approved", name: "Travel approved?", lane: "Lane_manager" },
      },
      {
        op: "insertAfter",
        after: "Gateway_approved",
        element: { type: "userTask", id: "Task_book", name: "Book travel", lane: "Lane_travel_office" },
      },
      { op: "rename", id: "Gateway_approved", name: "Travel approved?" },
      {
        op: "insertAfter",
        after: "Gateway_approved",
        element: {
          type: "endEvent",
          id: "EndEvent_rejected",
          name: "Travel request rejected",
          row: "below",
          lane: "Lane_manager",
        },
      },
    ],
    "blank",
  );
  const laid = await layout(built.xml, { mode: "layout", scope: { kind: "all" } }, "blank");
  const errors = checkBpmnXml(laid.xml, { file: "travel-request.bpmn" }).findings.filter((f) => f.severity === "ERROR");
  const process = (await outline(laid.xml, { depth: 2, bounds: true, full: true }, "x")).processes[0];
  assert.ok(process);
  const metrics = await measure(laid.xml, "x");

  assert.deepEqual(errors, []);
  assert.deepEqual(
    process.lanes?.map((lane) => lane.name),
    ["Employee", "Manager", "Travel Office"],
  );
  assert.equal(element(process, "Task_submit").lane, "Lane_employee");
  assert.equal(element(process, "Task_book").lane, "Lane_travel_office");
  // the "no" branch stays in the gateway's lane while "yes" leaves for another band: it runs straight, no kink
  const middle = (id: string) => {
    const bounds = element(process, id).bounds;
    assert.ok(bounds);
    return bounds.y + bounds.height / 2;
  };
  assert.equal(middle("EndEvent_rejected"), middle("Gateway_approved"));
  assert.deepEqual(
    metrics.map((plane) => [plane.shapeOverlaps, plane.edgeThroughShape, plane.outsideFrames]),
    metrics.map(() => [0, 0, 0]),
  );
});

test("insertAfter with branch adds an outcome instead of splitting; an end event always branches", async () => {
  const outcome = await applyOperations(
    DESIGN,
    [
      {
        op: "insertAfter",
        after: "Gateway_credit_approved",
        branch: true,
        name: "unclear",
        condition: "${score == null}",
        element: { type: "userTask", id: "Task_clarify", name: "Clarify credit", lane: "Lane_billing", row: "bottom" },
      },
      {
        op: "insertAfter",
        after: "Task_clarify",
        element: { type: "endEvent", id: "End_clarified", name: "Credit clarified" },
      },
    ],
    "branch",
  );
  const process = await processOf(outcome.xml);
  const out = (id: string) => process.flows.filter((flow) => flow.from === id);
  const metrics = await measure(outcome.xml, "x");

  assert.equal(out("Gateway_credit_approved").length, 3);
  assert.deepEqual(
    out("Gateway_credit_approved")
      .filter((flow) => flow.to === "Task_clarify")
      .map((flow) => [flow.name, flow.condition]),
    [["unclear", "${score == null}"]],
  );
  assert.deepEqual(
    out("Task_clarify").map((flow) => flow.to),
    ["End_clarified"],
  );
  assert.equal(element(process, "End_clarified").lane, "Lane_billing");
  assert.deepEqual(
    metrics.map((plane) => [plane.shapeOverlaps, plane.edgeThroughShape, plane.outsideFrames]),
    metrics.map(() => [0, 0, 0]),
  );
});

test("changeType replaces a task kind in place: id, name, flows, lane and shape stay", async () => {
  const outcome = await applyOperations(
    DESIGN,
    [
      { op: "changeType", id: "Task_fulfill_order", type: "serviceTask" },
      { op: "changeType", id: "Task_validate_order", type: "businessRuleTask" },
      { op: "setCalledDecision", id: "Task_validate_order", decision: "order-rules" },
    ],
    "type",
  );
  const before = await processOf(DESIGN);
  const after = await processOf(outcome.xml);
  const fulfil = element(after, "Task_fulfill_order");

  assert.equal(fulfil.type, "serviceTask");
  assert.equal(fulfil.lane, element(before, "Task_fulfill_order").lane);
  assert.deepEqual(after.flows, before.flows);
  assert.equal(element(after, "Task_validate_order").calledDecision, "order-rules");
  assert.match(outcome.xml, /<bpmndi:BPMNShape id="Task_fulfill_order_di" bpmnElement="Task_fulfill_order">/);
  await assert.rejects(
    applyOperations(DESIGN, [{ op: "changeType", id: "Task_fulfill_order", type: "exclusiveGateway" }], "x"),
    /can become: task, serviceTask/,
  );
});

test("a second boundary event on a host sits beside the first, not on it", async () => {
  const outcome = await applyOperations(
    DESIGN,
    [
      {
        op: "addErrorBoundary",
        attachTo: "Task_fulfill_order",
        id: "Event_a",
        name: "A failed",
        errorCode: "A",
        end: { id: "End_a", name: "A ended" },
      },
      {
        op: "addErrorBoundary",
        attachTo: "Task_fulfill_order",
        id: "Event_b",
        name: "B failed",
        errorCode: "B",
        end: { id: "End_b", name: "B ended" },
      },
    ],
    "boundaries",
  );
  const metrics = await measure(outcome.xml, "x");
  const process = await processOf(outcome.xml);

  assert.deepEqual(
    [element(process, "Event_a").trigger, element(process, "Event_b").trigger],
    ["error: A", "error: B"],
  );
  assert.deepEqual(
    metrics.map((plane) => plane.shapeOverlaps),
    metrics.map(() => 0),
  );
});

test("follow-ups from the agent runs: numbered flow ids continue the file's numbering; name sticks on a split flow", async () => {
  // the design fixture uses descriptive flow ids; number them like a generated model
  const bench = DESIGN.replace(/Flow_validate\b/g, "Flow_1")
    .replace(/Flow_to_credit\b/g, "Flow_2")
    .replace(/Flow_to_gateway\b/g, "Flow_3")
    .replace(/Flow_yes\b/g, "Flow_4")
    .replace(/Flow_no\b/g, "Flow_5")
    .replace(/Flow_to_invoice\b/g, "Flow_6")
    .replace(/Flow_to_fulfilled\b/g, "Flow_7")
    .replace(/Flow_to_rejected\b/g, "Flow_8")
    .replace(/Flow_inquiry_to_handle\b/g, "Flow_9")
    .replace(/Flow_handle_to_resolved\b/g, "Flow_10");
  const outcome = await applyOperations(
    bench,
    [
      {
        op: "insertAfter",
        after: "Gateway_credit_approved",
        via: "Flow_4",
        name: "approved",
        element: { type: "task", id: "Task_note", name: "Note approval" },
      },
    ],
    "numbered",
  );
  const process = await processOf(outcome.xml);

  assert.ok(process.flows.some((flow) => flow.id === "Flow_11" && flow.from === "Task_note"));
  assert.equal(process.flows.find((flow) => flow.id === "Flow_4")?.name, "approved");
});

test("inserting into a flow that changes lanes keeps the reading order: the sequence makes room like the space tool", async () => {
  // Flow_no runs from the gateway (Order Management) straight down to Task_reject_order (Billing), drawn below it
  const outcome = await applyOperations(
    DESIGN,
    [
      {
        op: "insertBetween",
        flow: "Flow_no",
        element: { type: "userTask", id: "Task_review", name: "Review rejection", lane: "Lane_billing" },
      },
    ],
    "reading-order",
  );
  const process = (await outline(outcome.xml, OPTIONS, "x")).processes[0];
  assert.ok(process);
  const centreX = (id: string) => {
    const bounds = element(process, id).bounds;
    assert.ok(bounds);
    return bounds.x + bounds.width / 2;
  };
  // like a book: left to right, or straight down — never back to the left
  for (const [from, to] of [
    ["Gateway_credit_approved", "Task_review"],
    ["Task_review", "Task_reject_order"],
    ["Task_reject_order", "EndEvent_order_rejected"],
  ] as const) {
    assert.ok(centreX(to) >= centreX(from) - 1, `${from} → ${to} runs to the left`);
  }
  assert.equal(element(process, "Task_review").lane, "Lane_billing");
  const metrics = await measure(outcome.xml, "x");
  assert.deepEqual(
    metrics.map((plane) => [plane.shapeOverlaps, plane.outsideFrames]),
    metrics.map(() => [0, 0]),
  );
});
