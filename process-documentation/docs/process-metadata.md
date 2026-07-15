# `process.yaml` — Process Metadata Schema

Every directory under `processes/` contains a `process.yaml`. It is the single source of truth
for everything about a process that is _not_ the flow itself, and it is the dependency graph
that connects the process to the landscape models.

**Rule: every reference must resolve.** `owner.team` must exist in the team topology model,
every `value_chain.steps[]` entry in the value chain model, every `wardley.components[]` entry
in the Wardley map (exact display name), every BPMN element id (in `controls`, `kpis`,
`decisions`, `mining`) in the referenced model, and every file path must exist on disk.
`scripts/validate.ts` checks this mechanically; the `process-review` skill adds the
judgment-based checks on top.

A machine-readable version of this schema lives at
[`schemas/process.schema.json`](../schemas/process.schema.json) — add
`# yaml-language-server: $schema=../../schemas/process.schema.json` as the first line of a
`process.yaml` to get editor validation.

Only the **Identity**, **Purpose**, **Ownership**, and **Structure** sections are required.
Everything else is optional — add a block when (and only when) the organization is ready to
maintain it. An out-of-date block is worse than an absent one.

## Schema

```yaml
# yaml-language-server: $schema=../../schemas/process.schema.json

# Identity (required) ──────────────────────────────────────────────
id: order-to-cash # kebab-case, equals the directory name
name: Order to Cash # human-readable name
classification:
  core # core | support | management
  #   core: creates customer value → value_chain.steps required
  #   support: enables core processes → supports required
  #   management: steers the organization → supports optional
level: 2 # 2 = end-to-end, 3 = sub-process
version: 1.1.0 # bump on semantic model changes (semver) + add history entry
status: as-is # draft | to-be | as-is | deprecated
last_reviewed:
  2026-07-06 # when a human last confirmed model = reality
  # (for status: draft this is the scaffold date)
review_cycle_months: 12 # optional; how often the model must be re-confirmed (default 12)

# Purpose (required) ───────────────────────────────────────────────
purpose: >
  One paragraph: why this process exists and the value it delivers.
trigger: Customer places an order # what starts the process
outcome: Payment received, order fulfilled # the state the process guarantees at the end

# Ownership (required; → landscape/team-topology.tt) ───────────────
owner:
  team: team-order-management # node id in the team topology model
  role: Process Owner # accountable role within that team
participants: # other teams involved (appear as lanes / handoffs)
  - team: team-payments-platform
    interaction: x-as-a-service # collaboration | x-as-a-service | facilitating

# Strategic context ────────────────────────────────────────────────
value_chain: # → landscape/value-chain.vc.json (element ids)
  steps: # REQUIRED for classification: core
    - step-sales
supports: # REQUIRED for classification: support (optional for management):
  - step-fulfillment # value chain step ids and/or process ids this process enables
    # (a support process lists these INSTEAD of value_chain.steps)
wardley: # → landscape/wardley-map.owm (component display names —
  components: #   EXACT match, the OWM format has no ids)
    - Order Management
    - Payment Processing

# Operations ───────────────────────────────────────────────────────
kpis:
  - name: Order cycle time
    target: "< 5 business days"
    direction: lower-is-better # lower-is-better | higher-is-better | target-band
    source: ERP report OTC-01 # where the number is produced (should match a systems[] entry)
    measured_from: StartEvent_order_received # BPMN element ids anchoring the measurement
    measured_to: EndEvent_order_fulfilled
    actuals: # date-stamped snapshots; git history = the time series
      - date: 2026-06-30
        value: "6.2 days"
operations: # volume & cost — what strategy-alignment needs to prioritize
  volume:
    cases_per_period: 1400
    period: month
    as_of: 2026-06-30
    source: ERP report OTC-01
  cost:
    per_case: "≈ 18 EUR" # or `ftes: 3.5` for capacity-based costing
    as_of: 2026-06-30
systems:
  - name: ERP
    role: System of record for orders and invoices
    url: https://erp.example.com # optional deep link for runtime guidance
inputs:
  - Confirmed customer order
outputs:
  - Paid invoice

# Structure (models.bpmn required) ─────────────────────────────────
models:
  bpmn: order-to-cash.bpmn # the level-2 model, relative to this directory
subprocesses:
  - id: invoice-handling
    name: Invoice Handling
    file: subprocesses/invoice-handling.bpmn
decisions: # DMN decision models (the editor opens *.dmn natively)
  - id: credit-check
    name: Credit approved?
    file: decisions/credit-check.dmn
    used_by: Gateway_credit_approved # BPMN element id where the decision is applied
docs:
  - docs/overview.md # per-task work instructions: docs/tasks/<bpmn-element-id>.md

# Relationships ────────────────────────────────────────────────────
related_processes:
  - id: customer-onboarding
    relationship: upstream # upstream | downstream | supporting | escalation
    note: New customers must be onboarded before first order
exceptions:
  - name: Credit check fails
    handling: Order is rejected, customer is notified with alternatives
    frequency: "~4% of orders" # optional, point-in-time — state as_of in the text if known

# Risk & compliance ────────────────────────────────────────────────
risks:
  - name: Revenue loss from uncollectible orders
    impact: high # low | medium | high
    mitigated_by: Credit check before fulfillment
controls:
  - name: Credit check before fulfillment
    type: preventive # preventive | detective
    element: Task_check_credit # BPMN element id where the control lives
    requirement: "Internal credit policy CP-7" # or e.g. "ISO 9001:2015 8.4", "GDPR Art. 30"

# Automation (→ docs/automation.md) ────────────────────────────────
automation:
  status: candidate # candidate | in-development | live
  engine: camunda-8 # camunda-7 | camunda-8 | other (once decided)
  model: order-to-cash.executable.bpmn # executable variant, lives next to this model
  note: Dunning loop first; see strategy-alignment findings.

# Process mining connection (→ process-performance skill) ──────────
mining:
  case_id:
    name: Order number
    system: ERP
  events: # BPMN activity ↔ event-log activity mapping
    - activity: Task_check_credit
      system: ERP
      event: CreditCheckCompleted
  no_digital_trace: # activities with no system event (honest gaps)
    - Task_validate_order

# Governance (→ docs/governance.md) ────────────────────────────────
approval: # REQUIRED when status is as-is: who released this version
  approved_by: Jane Doe (Process Owner, team-order-management)
  date: 2026-07-06
  version: 1.1.0 # must equal `version` above
history: # one entry per version bump: what changed and why
  - version: 1.1.0
    date: 2026-07-06
    change: Added dunning timer to Invoice Handling
    changed_by: team-order-management
published: # where exports of this process are deployed (staleness tracking)
  - location: claude.ai project "Sales Ops"
    date: 2026-07-06
    contact: sales-ops@example.com
```

## Field usage by consumers

| Consumer                                            | Reads                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `scripts/validate.ts` + CI                          | link integrity, required fields, approval/version match, export staleness  |
| `process-navigator` skill                           | everything — answers questions and traces links                            |
| `process-review` skill                              | validate.ts output + naming, cross-view consistency, freshness             |
| `strategy-alignment` skill                          | `classification`, `value_chain`/`supports`, `wardley`, `operations`, teams |
| `process-performance` skill                         | `kpis`, `operations`, `mining` — compares model against event data         |
| `export-process-skill` skill                        | everything — resolves all references into a self-contained skill           |
| `process-review` portfolio mode (governance report) | `approval`, `history`, `review_cycle_months`, `controls`                   |

Keep it honest: an out-of-date `process.yaml` is worse than none, because agents and humans
will answer from it. `last_reviewed`, `as_of`, and `actuals[].date` exist so staleness is
visible instead of silent.
