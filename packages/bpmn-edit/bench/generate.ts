/**
 * A seeded generator of benchmark models (ADR 0008 gate): processes of a given size in the style of the example
 * content repo — one pool, 2-4 lanes (roles), sequences, exclusive and parallel blocks, loops, call activities,
 * business rule tasks with a decision link and error paths. The same seed always yields the same model, so the
 * S/M/L corpus is reproducible without committing customer material.
 *
 * The raw diagram is a naive grid; `layout` (mode 'layout') then lays it out, so every model starts from a clean,
 * complete BPMNDI like a hand-made one.
 */
import { layout } from "../src/layout/layout.ts";

export type Size = "S" | "M" | "L";

/** target flow node counts per size */
export const TARGET_NODES: Readonly<Record<Size, number>> = { S: 12, M: 45, L: 120 };

const VERBS = ["Check", "Validate", "Approve", "Prepare", "Send", "Record", "Review", "Calculate", "Create", "Update"];
const OBJECTS = [
  "order",
  "invoice",
  "contract",
  "request",
  "offer",
  "claim",
  "delivery",
  "payment",
  "account",
  "report",
];
const ROLES = ["Sales", "Back Office", "Finance", "Legal", "Logistics", "Customer Service"];
const RESULTS = ["approved", "complete", "valid", "in stock", "accepted", "urgent"];

/** mulberry32: a small, fast, seedable PRNG */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind =
  | "startEvent"
  | "endEvent"
  | "task"
  | "userTask"
  | "serviceTask"
  | "businessRuleTask"
  | "callActivity"
  | "exclusiveGateway"
  | "parallelGateway"
  | "boundaryEvent";

interface Node {
  readonly id: string;
  readonly kind: Kind;
  readonly name: string;
  readonly lane: number;
  readonly attrs?: string;
  readonly attachedTo?: string;
  readonly body?: string;
}

interface Flow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly name?: string;
  readonly condition?: string;
}

class Builder {
  readonly nodes: Node[] = [];
  readonly flows: Flow[] = [];
  private readonly next: () => number;
  private count = 0;
  readonly lanes: number;

  constructor(seed: number, lanes: number) {
    this.next = random(seed);
    this.lanes = lanes;
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)] as T;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  lane(): number {
    return Math.floor(this.next() * this.lanes);
  }

  node(kind: Kind, name: string, lane: number, extra: Partial<Node> = {}): string {
    this.count++;
    const prefix =
      kind === "exclusiveGateway" || kind === "parallelGateway" ? "Gateway" : kind.endsWith("Event") ? "Event" : "Task";
    const id = `${prefix}_${this.count}`;
    this.nodes.push({ id, kind, name, lane, ...extra });
    return id;
  }

  flow(from: string, to: string, extra: Partial<Flow> = {}): void {
    this.flows.push({ id: `Flow_${this.flows.length + 1}`, from, to, ...extra });
  }

  taskName(): string {
    return `${this.pick(VERBS)} ${this.pick(OBJECTS)}`;
  }

  get size(): number {
    return this.nodes.filter((node) => node.kind !== "boundaryEvent").length;
  }

  /** one block after `from`, returning its exit node */
  block(from: string, lane: number, depth: number): string {
    const roll = this.next();
    if (depth < 2 && roll < 0.18) return this.exclusive(from, lane, depth);
    if (depth < 2 && roll < 0.28) return this.parallel(from, lane, depth);
    if (depth < 1 && roll < 0.34) return this.loop(from, lane, depth);
    if (roll < 0.42) return this.link(from, lane);
    const task = this.node(this.pick(["userTask", "serviceTask", "task"] as const), this.taskName(), lane);
    this.flow(from, task);
    if (this.chance(0.08)) {
      const boundary = this.node("boundaryEvent", `${this.pick(OBJECTS)} failed`, lane, {
        attachedTo: task,
        body: `<bpmn:errorEventDefinition />`,
      });
      const end = this.node("endEvent", `${this.pick(OBJECTS)} rejected`, lane);
      this.flow(boundary, end);
    }
    return task;
  }

  link(from: string, lane: number): string {
    const decision = this.chance(0.5);
    const stem = `${this.pick(OBJECTS)}-${decision ? "rules" : "handling"}`;
    const id = decision
      ? this.node("businessRuleTask", `Decide ${this.pick(OBJECTS)}`, lane, { attrs: ` calledDecision="${stem}"` })
      : this.node("callActivity", `Handle ${this.pick(OBJECTS)}`, lane, { attrs: ` calledElement="${stem}"` });
    this.flow(from, id);
    return id;
  }

  sequence(from: string, lane: number, depth: number, length: number): string {
    let at = from;
    for (let index = 0; index < length; index++) {
      at = this.block(at, this.chance(0.3) ? this.lane() : lane, depth);
    }
    return at;
  }

  exclusive(from: string, lane: number, depth: number): string {
    const result = this.pick(RESULTS);
    const split = this.node(
      "exclusiveGateway",
      `${this.pick(OBJECTS)} ${result}?`.replace(/^./, (c) => c.toUpperCase()),
      lane,
    );
    this.flow(from, split);
    const join = this.node("exclusiveGateway", "", lane);
    const branches = this.chance(0.25) ? 3 : 2;
    for (let index = 0; index < branches; index++) {
      const first = this.node("userTask", this.taskName(), this.chance(0.5) ? lane : this.lane());
      this.flow(split, first, {
        name: index === 0 ? "yes" : index === 1 ? "no" : "unclear",
        condition: `\${${result.replace(/\s/g, "")} == ${index === 0}}`,
      });
      const exit = this.sequence(first, lane, depth + 1, Math.floor(this.next() * 2));
      this.flow(exit, join);
    }
    return join;
  }

  parallel(from: string, lane: number, depth: number): string {
    const split = this.node("parallelGateway", "", lane);
    this.flow(from, split);
    const join = this.node("parallelGateway", "", lane);
    for (let index = 0; index < 2; index++) {
      const first = this.node("serviceTask", this.taskName(), this.lane());
      this.flow(split, first);
      this.flow(this.sequence(first, lane, depth + 1, Math.floor(this.next() * 2)), join);
    }
    return join;
  }

  loop(from: string, lane: number, depth: number): string {
    const merge = this.node("exclusiveGateway", "", lane);
    this.flow(from, merge);
    const body = this.sequence(merge, lane, depth + 1, 1 + Math.floor(this.next() * 2));
    const result = this.pick(RESULTS);
    const check = this.node(
      "exclusiveGateway",
      `${this.pick(OBJECTS)} ${result}?`.replace(/^./, (c) => c.toUpperCase()),
      lane,
    );
    this.flow(body, check);
    this.flow(check, merge, { name: "no", condition: `\${!${result.replace(/\s/g, "")}}` });
    return check;
  }
}

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const SIZE_OF: Readonly<Record<string, { width: number; height: number }>> = {
  startEvent: { width: 36, height: 36 },
  endEvent: { width: 36, height: 36 },
  boundaryEvent: { width: 36, height: 36 },
  exclusiveGateway: { width: 50, height: 50 },
  parallelGateway: { width: 50, height: 50 },
};

/** the XML with a naive grid diagram: one column per node in creation order, one band per lane */
function toXml(id: string, name: string, builder: Builder): string {
  const laneHeight = 250;
  const columns = new Map(builder.nodes.map((node, index) => [node.id, index]));
  const bounds = new Map(
    builder.nodes.map((node) => {
      const size = SIZE_OF[node.kind] ?? { width: 100, height: 80 };
      const host = node.attachedTo ? builder.nodes.find((candidate) => candidate.id === node.attachedTo) : undefined;
      const column = columns.get(host?.id ?? node.id) ?? 0;
      const x = 250 + column * 150 + (host ? 60 : 0);
      const y = 110 + node.lane * laneHeight + (host ? 60 : (laneHeight - size.height) / 2 - 40);
      return [node.id, { x, y, ...size }];
    }),
  );
  const width = 250 + builder.nodes.length * 150;
  const laneIds = Array.from({ length: builder.lanes }, (_, index) => `Lane_${index + 1}`);
  const flowNode = (node: Node): string => {
    const incoming = builder.flows
      .filter((flow) => flow.to === node.id)
      .map((f) => `      <bpmn:incoming>${f.id}</bpmn:incoming>`);
    const outgoing = builder.flows
      .filter((flow) => flow.from === node.id)
      .map((f) => `      <bpmn:outgoing>${f.id}</bpmn:outgoing>`);
    const attached = node.attachedTo ? ` attachedToRef="${node.attachedTo}"` : "";
    const nameAttr = node.name ? ` name="${esc(node.name)}"` : "";
    return [
      `    <bpmn:${node.kind} id="${node.id}"${nameAttr}${attached}${node.attrs ?? ""}>`,
      ...incoming,
      ...outgoing,
      ...(node.body ? [`      ${node.body}`] : []),
      `    </bpmn:${node.kind}>`,
    ].join("\n");
  };
  const flowXml = (flow: Flow): string => {
    const nameAttr = flow.name ? ` name="${esc(flow.name)}"` : "";
    const open = `    <bpmn:sequenceFlow id="${flow.id}"${nameAttr} sourceRef="${flow.from}" targetRef="${flow.to}"`;
    return flow.condition
      ? `${open}>\n      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(flow.condition)}</bpmn:conditionExpression>\n    </bpmn:sequenceFlow>`
      : `${open} />`;
  };
  const shape = (node: Node): string => {
    const b = bounds.get(node.id)!;
    return `      <bpmndi:BPMNShape id="${node.id}_di" bpmnElement="${node.id}">\n        <dc:Bounds x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" />\n      </bpmndi:BPMNShape>`;
  };
  const edge = (flow: Flow): string => {
    const [s, t] = [bounds.get(flow.from)!, bounds.get(flow.to)!];
    return `      <bpmndi:BPMNEdge id="${flow.id}_di" bpmnElement="${flow.id}">\n        <di:waypoint x="${s.x + s.width}" y="${s.y + s.height / 2}" />\n        <di:waypoint x="${t.x}" y="${t.y + t.height / 2}" />\n      </bpmndi:BPMNEdge>`;
  };
  const roles = [...ROLES].slice(0, builder.lanes);
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_${id}" targetNamespace="http://bpmiq.io/bench">
  <bpmn:collaboration id="Collaboration_${id}">
    <bpmn:participant id="Participant_${id}" name="${esc(name)}" processRef="${id}" />
  </bpmn:collaboration>
  <bpmn:process id="${id}" name="${esc(name)}" isExecutable="false">
    <bpmn:laneSet id="LaneSet_${id}">
${laneIds
  .map(
    (lane, index) =>
      `      <bpmn:lane id="${lane}" name="${roles[index]}">\n${builder.nodes
        .filter((node) => node.lane === index)
        .map((node) => `        <bpmn:flowNodeRef>${node.id}</bpmn:flowNodeRef>`)
        .join("\n")}\n      </bpmn:lane>`,
  )
  .join("\n")}
    </bpmn:laneSet>
${builder.nodes.map(flowNode).join("\n")}
${builder.flows.map(flowXml).join("\n")}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_${id}">
    <bpmndi:BPMNPlane id="BPMNPlane_${id}" bpmnElement="Collaboration_${id}">
      <bpmndi:BPMNShape id="Participant_${id}_di" bpmnElement="Participant_${id}" isHorizontal="true">
        <dc:Bounds x="160" y="80" width="${width}" height="${builder.lanes * laneHeight}" />
      </bpmndi:BPMNShape>
${laneIds
  .map(
    (lane, index) =>
      `      <bpmndi:BPMNShape id="${lane}_di" bpmnElement="${lane}" isHorizontal="true">\n        <dc:Bounds x="190" y="${80 + index * laneHeight}" width="${width - 30}" height="${laneHeight}" />\n      </bpmndi:BPMNShape>`,
  )
  .join("\n")}
${builder.nodes.map(shape).join("\n")}
${builder.flows.map(edge).join("\n")}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

/** A process of about the target size for the seed, laid out; the same seed always gives the same file. */
export async function generateModel(size: Size, seed: number): Promise<{ id: string; xml: string }> {
  const lanes = size === "S" ? 2 : size === "M" ? 3 : 4;
  const builder = new Builder(seed, lanes);
  const id = `bench-${size.toLowerCase()}-${seed}`;
  const start = builder.node(
    "startEvent",
    `${builder.pick(OBJECTS)} received`.replace(/^./, (c) => c.toUpperCase()),
    0,
  );
  let at = start;
  while (builder.size < TARGET_NODES[size] - 1) {
    at = builder.block(at, builder.lane(), 0);
  }
  const end = builder.node(
    "endEvent",
    `${builder.pick(OBJECTS)} completed`.replace(/^./, (c) => c.toUpperCase()),
    0,
  );
  builder.flow(at, end);
  const raw = toXml(id, `Bench ${size} ${seed}`, builder);
  const laidOut = await layout(raw, { mode: "layout", scope: { kind: "all" } }, id);
  return { id, xml: laidOut.xml };
}
