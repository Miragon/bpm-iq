/**
 * The task catalogue of the A/B benchmark (ADR 0008 gate): 9 edit templates instantiated on an S, M and L model and 3
 * scaffold tasks — 30 tasks. Every task carries a prompt in the words of a process owner (names, never ids), an
 * automatic oracle over the final model, and the ids it may change, so every other difference counts as collateral.
 *
 * Anchors are picked deterministically from the model's outline, so the same corpus always yields the same tasks.
 */
import type { Operation } from "../../src/operations/types.ts";
import { outline } from "../../src/outline/outline.ts";
import type { ElementOutline, FlowOutline, ProcessOutline } from "../../src/outline/types.ts";

export interface Verdict {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface Task {
  readonly id: string;
  readonly kind: "edit" | "scaffold";
  readonly size: "S" | "M" | "L" | "-";
  /** the process the task works on (file stem); a scaffold task names the process to create */
  readonly process: string;
  readonly prompt: string;
  /** ids of existing elements the task may change or remove — every other element must survive unchanged */
  readonly mayChange: readonly string[];
  /** the oracle: the final process outline (the created one for a scaffold task) */
  check(after: ProcessOutline): Verdict;
  /** a reference solution as edit operations — the dry run proves with it that the oracle is satisfiable */
  readonly reference: readonly Operation[];
}

const OPTIONS = { depth: 2, bounds: false, full: true } as const;

export async function processOf(xml: string): Promise<ProcessOutline> {
  const [process] = (await outline(xml, OPTIONS, "task")).processes;
  if (!process) throw new Error("no process in the model");
  return process;
}

function verdict(checks: readonly [boolean, string][]): Verdict {
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
  return { ok: failures.length === 0, failures };
}

const byName = (p: ProcessOutline, name: string) =>
  p.elements.filter((e) => (e.name ?? "").trim().toLowerCase() === name.toLowerCase());
const one = (p: ProcessOutline, name: string) => byName(p, name)[0];
const out = (p: ProcessOutline, id: string) => p.flows.filter((f) => f.from === id);
const into = (p: ProcessOutline, id: string) => p.flows.filter((f) => f.to === id);
const laneName = (p: ProcessOutline, lane?: string) => p.lanes?.find((l) => l.id === lane)?.name;
const isActivity = (e: ElementOutline) => /task$|^callActivity$/i.test(e.type);
const nameOf = (p: ProcessOutline, id: string) => p.elements.find((e) => e.id === id)?.name ?? id;

/** activities at process level with exactly one flow in and out, in document order */
function simpleActivities(p: ProcessOutline): ElementOutline[] {
  return p.elements.filter(
    (e) =>
      isActivity(e) &&
      !e.parent &&
      e.name &&
      byName(p, e.name).length === 1 &&
      out(p, e.id).length === 1 &&
      into(p, e.id).length === 1,
  );
}

function pick<T>(list: readonly T[], index: number, what: string): T {
  const found = list[Math.min(index, list.length - 1)];
  if (found === undefined) throw new Error(`the model has no ${what}`);
  return found;
}

/** the 9 edit templates on one model */
export async function editTasks(size: "S" | "M" | "L", processId: string, xml: string): Promise<Task[]> {
  const p = await processOf(xml);
  const simple = simpleActivities(p);
  const mid = Math.floor(simple.length / 2);
  const tag = (name: string) => `${name}-${size}`;
  const tasks: Task[] = [];

  // 1 insert a step after an activity, in its role
  {
    const x = pick(simple, 0, "simple activity");
    const next = pick(out(p, x.id), 0, "outgoing flow").to;
    const role = laneName(p, x.lane) ?? "the same role";
    tasks.push({
      reference: [
        {
          op: "insertAfter",
          after: x.id,
          element: { type: "userTask", id: "Task_archive", name: "Archive documents" },
        },
      ],
      id: tag("insert-step"),
      kind: "edit",
      size,
      process: processId,
      prompt: `In the process "${p.name}", add a new step "Archive documents" right after "${x.name}". It is done by ${role}, and the process continues after it as before.`,
      mayChange: [x.id],
      check: (a) => {
        const n = one(a, "Archive documents");
        return verdict([
          [!!n, "no element 'Archive documents'"],
          [!!n && isActivity(n), "'Archive documents' is no activity"],
          [!!n && into(a, n.id).some((f) => f.from === x.id), `no flow ${x.name} → Archive documents`],
          [!!n && out(a, n.id).some((f) => f.to === next), `no flow Archive documents → ${nameOf(p, next)}`],
          [!out(a, x.id).some((f) => f.to === next), `${x.name} still flows directly to ${nameOf(p, next)}`],
          [!!n && n.lane === x.lane, `'Archive documents' is not in the lane ${role}`],
        ]);
      },
    });
  }

  // 2 a third outcome at a decision, with a new step and a new end event
  {
    const gateways = p.elements.filter(
      (e) => e.type === "exclusiveGateway" && e.name && out(p, e.id).length >= 2 && !e.parent,
    );
    const g = pick(gateways, 0, "named exclusive gateway");
    const lanes = p.lanes ?? [];
    const role = lanes.at(-1);
    tasks.push({
      reference: [
        {
          op: "insertAfter",
          after: g.id,
          branch: true,
          name: "escalate",
          element: {
            type: "userTask",
            id: "Task_escalate",
            name: "Escalate case",
            ...(role ? { lane: role.id } : {}),
            row: "bottom",
          },
        },
        {
          op: "insertAfter",
          after: "Task_escalate",
          element: { type: "endEvent", id: "End_escalated", name: "Case escalated" },
        },
      ],
      id: tag("add-branch"),
      kind: "edit",
      size,
      process: processId,
      prompt: `At the decision "${g.name}", add a further outcome "escalate": it leads to a new step "Escalate case"${role ? ` done by ${role.name}` : ""}, after which the process ends with a new end event "Case escalated".`,
      mayChange: [g.id],
      check: (a) => {
        const t = one(a, "Escalate case");
        const e = one(a, "Case escalated");
        return verdict([
          [!!t && isActivity(t), "no activity 'Escalate case'"],
          [!!e && e.type === "endEvent", "no end event 'Case escalated'"],
          [
            !!t && out(a, g.id).some((f) => f.to === t.id && /escalat/i.test(f.name ?? "")),
            `no flow "escalate" from ${g.name} to Escalate case`,
          ],
          [!!t && !!e && out(a, t.id).some((f) => f.to === e.id), "no flow Escalate case → Case escalated"],
          [!!t && (!role || t.lane === role.id), `'Escalate case' is not in ${role?.name ?? ""}`],
          [out(a, g.id).length === out(p, g.id).length + 1, `${g.name} lost or gained other outcomes`],
        ]);
      },
    });
  }

  // 3 rename
  {
    const x = pick(simple, mid, "simple activity");
    tasks.push({
      reference: [{ op: "rename", id: x.id, name: "Verify customer data" }],
      id: tag("rename"),
      kind: "edit",
      size,
      process: processId,
      prompt: `Rename the step "${x.name}" to "Verify customer data".`,
      mayChange: [x.id],
      check: (a) => {
        const r = a.elements.find((e) => e.id === x.id);
        return verdict([
          [r?.name === "Verify customer data", `${x.id} is not named 'Verify customer data'`],
          [byName(a, x.name ?? "").length === 0, `'${x.name}' still exists`],
        ]);
      },
    });
  }

  // 4 remove with reconnect
  {
    const x = pick(simple, Math.max(1, mid - 1), "simple activity");
    const prev = pick(into(p, x.id), 0, "incoming").from;
    const next = pick(out(p, x.id), 0, "outgoing").to;
    tasks.push({
      reference: [{ op: "remove", id: x.id, reconnect: true }],
      id: tag("remove-step"),
      kind: "edit",
      size,
      process: processId,
      prompt: `The step "${x.name}" is no longer needed. Remove it; "${nameOf(p, prev)}" should continue directly with "${nameOf(p, next)}".`,
      mayChange: [x.id, prev],
      check: (a) =>
        verdict([
          [!a.elements.some((e) => e.id === x.id) && byName(a, x.name ?? "").length === 0, `${x.name} still exists`],
          [a.flows.some((f) => f.from === prev && f.to === next), `no flow ${nameOf(p, prev)} → ${nameOf(p, next)}`],
        ]),
    });
  }

  // 5 error path
  {
    const x = pick(simple, mid + 1, "simple activity");
    tasks.push({
      reference: [
        {
          op: "addErrorBoundary",
          attachTo: x.id,
          id: "Event_data_invalid",
          name: "Data invalid",
          errorCode: "DATA_INVALID",
          end: { id: "End_data_rejected", name: "Data rejected" },
        },
      ],
      id: tag("error-path"),
      kind: "edit",
      size,
      process: processId,
      prompt: `"${x.name}" can fail with the error code DATA_INVALID. In that case the process ends with a new end event "Data rejected".`,
      mayChange: [x.id],
      check: (a) => {
        const b = a.elements.find(
          (e) => e.type === "boundaryEvent" && e.attachedTo === x.id && /DATA_INVALID/.test(e.trigger ?? ""),
        );

        const e = one(a, "Data rejected");
        return verdict([
          [!!b, `no error boundary event with DATA_INVALID on ${x.name}`],
          [!!e && e.type === "endEvent", "no end event 'Data rejected'"],
          [!!b && !!e && out(a, b.id).some((f) => f.to === e.id), "no flow from the boundary event to 'Data rejected'"],
        ]);
      },
    });
  }

  // 6 change the role
  {
    const x = pick(simple, mid + 2, "simple activity");
    const lanes = p.lanes ?? [];
    const target = lanes.find((l) => l.id !== x.lane);
    // without a second lane there is no role to change to: the template does not apply
    if (target)
      tasks.push({
        reference: [{ op: "moveToLane", id: x.id, lane: target.id }],
        id: tag("move-lane"),
        kind: "edit",
        size,
        process: processId,
        prompt: `From now on, "${x.name}" is done by ${target.name}.`,
        mayChange: [x.id],
        check: (a) => {
          const r = a.elements.find((e) => e.id === x.id) ?? one(a, x.name ?? "");
          return verdict([
            [r?.lane === target.id, `${x.name} is not in ${target.name}`],
            [!!r && out(a, r.id).length === 1 && into(a, r.id).length === 1, `${x.name} lost its flows`],
          ]);
        },
      });
  }

  // 7 link a decision
  {
    const rules = p.elements.filter((e) => e.type === "businessRuleTask" && !e.parent && e.name);
    const x = rules[0] ?? pick(simple, 0, "activity");
    const isRule = x.type === "businessRuleTask";
    tasks.push({
      reference: [
        ...(isRule ? [] : [{ op: "changeType", id: x.id, type: "businessRuleTask" } as Operation]),
        { op: "setCalledDecision", id: x.id, decision: "credit-rules" },
      ],
      id: tag("link-decision"),
      kind: "edit",
      size,
      process: processId,
      prompt: isRule
        ? `"${x.name}" should use the decision "credit-rules" from now on.`
        : `"${x.name}" becomes a business rule task that uses the decision "credit-rules".`,
      mayChange: [x.id],
      check: (a) => {
        const r = a.elements.find((e) => e.id === x.id) ?? one(a, x.name ?? "");
        return verdict([
          [r?.type === "businessRuleTask", `${x.name} is no business rule task`],
          [r?.calledDecision === "credit-rules", `${x.name} does not call credit-rules`],
        ]);
      },
    });
  }

  // 8 a condition on an outcome
  {
    const flows = p.flows.filter((f) => f.name && p.elements.find((e) => e.id === f.from)?.type === "exclusiveGateway");
    const f = pick(flows, flows.length - 1, "named gateway outcome");
    const condition = "${amount > 1000}";
    tasks.push({
      reference: [{ op: "setCondition", flow: f.id, condition }],
      id: tag("condition"),
      kind: "edit",
      size,
      process: processId,
      prompt: `The outcome "${f.name}" of "${nameOf(p, f.from)}" should only be taken when ${condition}.`,
      mayChange: [f.from],
      check: (a) => {
        const r = a.flows.find((c) => c.from === f.from && c.to === f.to && c.name === f.name);
        return verdict([
          [!!r, "the outcome is gone"],
          [
            (r?.condition ?? "").replace(/\s/g, "") === condition.replace(/\s/g, ""),
            `the condition is '${r?.condition ?? ""}'`,
          ],
        ]);
      },
    });
  }

  // 9 a parallel step
  {
    const x = pick(simple, simple.length - 1, "simple activity");
    const prev = pick(into(p, x.id), 0, "incoming").from;
    const next = pick(out(p, x.id), 0, "outgoing").to;
    tasks.push({
      reference: [
        {
          op: "insertBetween",
          flow: pick(into(p, x.id), 0, "incoming").id,
          element: { type: "parallelGateway", id: "Gateway_fork", name: "" },
        },
        { op: "insertAfter", after: x.id, element: { type: "parallelGateway", id: "Gateway_joined", name: "" } },
        {
          op: "insertAfter",
          after: "Gateway_fork",
          branch: true,
          element: { type: "userTask", id: "Task_notify", name: "Notify customer", lane: x.lane, row: "below" },
        },
        { op: "connect", from: "Task_notify", to: "Gateway_joined" },
      ],
      id: tag("parallel-step"),
      kind: "edit",
      size,
      process: processId,
      prompt: `While "${x.name}" is done, "Notify customer" should happen at the same time, by the same role. The process continues only when both are finished.`,
      mayChange: [x.id, prev],
      check: (a) => {
        const n = one(a, "Notify customer");
        const split = n ? into(a, n.id).map((f) => a.elements.find((e) => e.id === f.from)) : [];
        const join = n ? out(a, n.id).map((f) => a.elements.find((e) => e.id === f.to)) : [];
        const s = split[0];
        const j = join[0];
        return verdict([
          [!!n && isActivity(n), "no activity 'Notify customer'"],
          [s?.type === "parallelGateway", "'Notify customer' does not start at a parallel gateway"],
          [!!s && out(a, s.id).some((f) => f.to === x.id), `the parallel split does not also lead to ${x.name}`],
          [j?.type === "parallelGateway", "'Notify customer' does not end at a parallel gateway"],
          [!!j && out(a, x.id).some((f) => f.to === j.id), `${x.name} does not join the same gateway`],
          [!!j && out(a, j.id).some((f) => f.to === next), `the join does not continue with ${nameOf(p, next)}`],
          [!!n && n.lane === x.lane, "'Notify customer' is not in the role of " + x.name],
        ]);
      },
    });
  }
  return tasks;
}

interface Scenario {
  readonly name: string;
  readonly roles: readonly string[];
  readonly story: string;
  readonly steps: readonly { name: string; role: string }[];
  readonly gateway: string;
  readonly ends: readonly string[];
  readonly start: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "Travel request",
    roles: ["Employee", "Manager", "Travel Office"],
    start: "Trip planned",
    story:
      'It starts when a trip is planned ("Trip planned"). The Employee submits the travel request ("Submit travel request"). The Manager approves it ("Approve travel request") and decides "Travel approved?": if not, the process ends with "Travel request rejected". If yes, the Travel Office books the travel ("Book travel") and the process ends with "Travel booked".',
    steps: [
      { name: "Submit travel request", role: "Employee" },
      { name: "Approve travel request", role: "Manager" },
      { name: "Book travel", role: "Travel Office" },
    ],
    gateway: "Travel approved?",
    ends: ["Travel request rejected", "Travel booked"],
  },
  {
    name: "Supplier onboarding",
    roles: ["Purchasing", "Compliance", "Accounting"],
    start: "Supplier proposed",
    story:
      'It starts with "Supplier proposed". Purchasing collects the supplier data ("Collect supplier data"). Compliance checks the supplier ("Check supplier compliance") and decides "Supplier compliant?": if not, it ends with "Supplier declined". If yes, Accounting creates the supplier account ("Create supplier account") and it ends with "Supplier onboarded".',
    steps: [
      { name: "Collect supplier data", role: "Purchasing" },
      { name: "Check supplier compliance", role: "Compliance" },
      { name: "Create supplier account", role: "Accounting" },
    ],
    gateway: "Supplier compliant?",
    ends: ["Supplier declined", "Supplier onboarded"],
  },
  {
    name: "Warranty claim",
    roles: ["Customer Service", "Technician", "Logistics"],
    start: "Claim received",
    story:
      'It starts with "Claim received". Customer Service registers the claim ("Register claim"). A Technician inspects the product ("Inspect product") and decides "Claim justified?": if not, it ends with "Claim rejected". If yes, Logistics ships a replacement ("Ship replacement") and it ends with "Replacement shipped".',
    steps: [
      { name: "Register claim", role: "Customer Service" },
      { name: "Inspect product", role: "Technician" },
      { name: "Ship replacement", role: "Logistics" },
    ],
    gateway: "Claim justified?",
    ends: ["Claim rejected", "Replacement shipped"],
  },
];

/** the scenario built from the blank template of create_process (StartEvent_1 → EndEvent_1) */
function scaffoldReference(s: Scenario): Operation[] {
  const lane = (role: string) => `Lane_${s.roles.indexOf(role) + 1}`;
  const [first, second, third] = s.steps;
  const [rejected, done] = s.ends;
  if (!first || !second || !third || !rejected || !done) throw new Error(`incomplete scenario ${s.name}`);
  return [
    ...s.roles.map((role, index): Operation => ({ op: "addLane", id: `Lane_${index + 1}`, name: role })),
    { op: "rename", id: "StartEvent_1", name: s.start },
    { op: "rename", id: "EndEvent_1", name: done },
    {
      op: "insertAfter",
      after: "StartEvent_1",
      element: { type: "userTask", id: "Task_1", name: first.name, lane: lane(first.role) },
    },
    {
      op: "insertAfter",
      after: "Task_1",
      element: { type: "userTask", id: "Task_2", name: second.name, lane: lane(second.role) },
    },
    {
      op: "insertAfter",
      after: "Task_2",
      element: { type: "exclusiveGateway", id: "Gateway_1", name: s.gateway, lane: lane(second.role) },
    },
    {
      op: "insertAfter",
      after: "Gateway_1",
      element: { type: "userTask", id: "Task_3", name: third.name, lane: lane(third.role) },
    },
    {
      op: "insertAfter",
      after: "Gateway_1",
      branch: true,
      name: "no",
      element: { type: "endEvent", id: "EndEvent_2", name: rejected, lane: lane(second.role), row: "below" },
    },
  ];
}

/** the 3 scaffold tasks; `suffix` keeps the created file unique per run */
export function scaffoldTasks(suffix: string): Task[] {
  return SCENARIOS.map((s, index) => {
    const name = `${s.name} ${suffix}`;
    return {
      id: `scaffold-${index + 1}`,
      kind: "scaffold" as const,
      size: "-" as const,
      process: name,
      prompt: `Create a new process "${name}" with the roles ${s.roles.join(", ")} as lanes. ${s.story}`,
      mayChange: [],
      reference: scaffoldReference(s),
      check: (a: ProcessOutline) => {
        const laneOf = (role: string) => a.lanes?.find((l) => (l.name ?? "").toLowerCase() === role.toLowerCase())?.id;
        const g = one(a, s.gateway);
        const reach = new Set<string>();
        const start = a.elements.find((e) => e.type === "startEvent");
        const walk = (id: string) => {
          if (reach.has(id)) return;
          reach.add(id);
          out(a, id).forEach((f: FlowOutline) => walk(f.to));
        };
        if (start) walk(start.id);
        return verdict([
          ...s.roles.map((role): [boolean, string] => [!!laneOf(role), `no lane ${role}`]),
          [!!start && (start.name ?? "").toLowerCase() === s.start.toLowerCase(), `no start event '${s.start}'`],
          ...s.steps.map((step): [boolean, string] => {
            const e = one(a, step.name);
            return [
              !!e && isActivity(e) && e.lane === laneOf(step.role),
              `'${step.name}' missing or not in ${step.role}`,
            ];
          }),
          [!!g && g.type === "exclusiveGateway", `no exclusive gateway '${s.gateway}'`],
          ...s.ends.map((end): [boolean, string] => {
            const e = one(a, end);
            return [!!e && e.type === "endEvent" && reach.has(e.id), `end event '${end}' missing or unreachable`];
          }),
          [
            a.elements.filter((e) => !e.parent && e.type !== "boundaryEvent").every((e) => e.lane !== undefined),
            "a node is in no lane",
          ],
        ]);
      },
    };
  });
}

/**
 * Collateral changes: elements and flows outside `mayChange` (and not new) that the run altered or dropped. Flows
 * are compared by their endpoints, names and conditions, since arm A may rewrite flow ids.
 */
export function collateral(before: ProcessOutline, after: ProcessOutline, mayChange: readonly string[]): string[] {
  const allowed = new Set(mayChange);
  const found: string[] = [];
  for (const e of before.elements) {
    if (allowed.has(e.id)) continue;
    const a = after.elements.find((c) => c.id === e.id);
    if (!a) {
      found.push(`${e.id} removed`);
      continue;
    }
    for (const key of ["type", "name", "lane", "calledElement", "calledDecision", "attachedTo", "trigger"] as const) {
      if ((e[key] ?? "") !== (a[key] ?? "")) found.push(`${e.id}.${key} changed`);
    }
  }
  for (const f of before.flows) {
    if (allowed.has(f.from) || allowed.has(f.to)) continue;
    const same = after.flows.some(
      (c) =>
        c.from === f.from &&
        c.to === f.to &&
        (c.name ?? "") === (f.name ?? "") &&
        (c.condition ?? "") === (f.condition ?? ""),
    );
    if (!same) found.push(`flow ${f.from}→${f.to} changed or removed`);
  }
  return found;
}
