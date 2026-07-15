# Automation: From Descriptive to Executable

The models under `processes/` are **descriptive**: they document how work flows so humans and
agents can read, question, and improve it. When the `strategy-alignment` skill flags a step
with "automate this", the process gains a second artifact: an **executable** model on a
workflow engine. This page describes when to make that move and how to do it without
corrupting the documentation.

## When to automate

The Wardley map answers this (see [method.md](method.md)):

- **Automate manual work on commodity components.** The capability is standardized and stable;
  a human executing it adds cost and variance, not judgment.
- **Never automate genesis or custom components.** The capability is still evolving —
  an executable model freezes behavior, and freezing an evolving capability just moves the
  change cost into engine redeployments. Standardize first (get the component to product /
  commodity, or buy it), then automate.

Quantify before committing, from `operations` in `process.yaml`:
`operations.volume.cases_per_period` × the step's frequency × `operations.cost.per_case` is the
ceiling of what the automation can save. A step touched 20 times a month is not worth an
engine; the same step at 1400 cases per month is.

## The path: two models, one directory

**Never overwrite the descriptive model.** The as-is BPMN stays the documentation of record —
it is what humans, `process-navigator`, and exported skills read. The executable variant lives
_next to it_ as `<id>.executable.bpmn` and is read by an engine. They serve different masters:
one optimizes for comprehension (lanes, 7 ± 2 activities, named outcomes), the other for
execution (job types, correlation keys, retries). Merging them produces a model that serves
neither.

Declare the variant in `process.yaml`:

```yaml
automation:
  status: candidate # candidate | in-development | live
  engine: camunda-8 # camunda-7 | camunda-8 | other (once decided)
  model: order-to-cash.executable.bpmn # next to the descriptive model
  note: Dunning loop first; see strategy-alignment findings.
```

`status: candidate` needs only a `note`; add `engine` and `model` when development starts.
Like the to-be convention (`<id>.to-be.bpmn`), the variant stays in the same process directory
so the dependency graph keeps one root and `scripts/validate.ts` can check that the file exists.

## Tooling

Already part of the setup — no new platform required:

- The **Miragon BPMN Modeler** (VS Code) edits Camunda 7 and Camunda 8 execution attributes
  directly on the diagram, loads element templates from `.camunda/element-templates/`
  (reusable service-task/connector configurations — create the directory with the first
  template), and deploys diagrams to a Camunda engine from within VS Code.
- **DMN is already executable.** Decision models in `processes/<id>/decisions/` deploy
  unchanged to the same engine; `decisions[].used_by` names the BPMN element where the
  decision applies, which in the executable variant becomes a business rule task.

## Keeping the two models in sync

The executable model **implements** the approved as-is (or to-be) flow. It may add technical
detail — concrete timer durations, message correlation, error handling — but must not change
the business semantics. Semantic divergence (a path that exists in one model but not the
other, a decision taken at a different point) is a `process-review` finding, same severity as
a model diverging from reality.

- One `version` in `process.yaml` covers both models: bump it and add a `history` entry when
  either changes semantically.
- The `approval` block still governs the business process — what runs on the engine must be a
  released version, not a fork that only the engine knows about.

## Worked example: the order-to-cash dunning loop

`processes/order-to-cash/process.yaml` has `automation.status: candidate`, and the `note` names
dunning: `Task_send_reminder` in `subprocesses/invoice-handling.bpmn` is manual work (it is
listed under `mining.no_digital_trace`) on **Payment Processing** — a commodity on the Wardley
map, "outsourced commodity" per the `systems` entry. The volume check: 1400 cases/month
(`operations.volume`) × ~11% of invoices hitting the reminder loop (`exceptions`) ≈ 150 manual
reminders per month — and the loop can repeat per invoice — at ≈ 18 EUR per case overall
(`operations.cost`).

An executable `order-to-cash.executable.bpmn` would keep the invoice-handling flow and add:

- a concrete timer duration on `Boundary_terms_expired`, computed from the invoice's payment
  terms (the descriptive model deliberately says only _Payment terms expired_),
- message correlation on `Task_await_payment` keyed by the order number — the `mining.case_id`
  — so incoming payment events find their process instance,
- a service task binding for `Task_send_reminder` (element template for the mail/notification
  connector), which gives the reminder a digital trace: on go-live, remove it from
  `mining.no_digital_trace` and add the new event to `mining.events`.

`automation.status` moves to `in-development` when the executable model exists and to `live`
when it handles real cases — at which point the ~11% reminder rate becomes a number the engine
reports instead of an estimate.
