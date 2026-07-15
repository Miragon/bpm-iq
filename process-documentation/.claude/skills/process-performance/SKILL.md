---
name: process-performance
description: Closes the loop between process models and reality using event-log data — computes case frequencies, activity durations, and handoff waiting times from a CSV export, checks observed variants against the modeled happy path and exceptions, compares measured cycle times to KPI targets, and records dated actuals in process.yaml. Use when the user asks how a process actually performs, brings an event log or ERP export to analyze, wants a conformance check ("does the model match reality?"), asks where time is lost in a process, or wants KPI actuals updated with measured numbers.
---

# Process Performance

A model is a claim about reality; the event log is the evidence. This skill takes one process
and one event-log export and reports where they agree and where they don't.

**Inputs**: a process id (`processes/<id>/`) and an event-log export — CSV with at least a case
id column, an activity/event name column, and a timestamp column. Identify the three columns
from the header; ask if ambiguous. Read `process.yaml` (`mining`, `kpis`, `operations`,
`exceptions`) and the BPMN model referenced by `models.bpmn`.

## Log handling — non-negotiable

- **Never commit the event log.** It contains case-level business data (privacy) and does not
  belong in a model repository (size). Analyze it where it lies, or copy it to the scratchpad.
  If the export was dropped inside the repo working tree, flag that first.
- Only **aggregates** enter `process.yaml`: `kpis[].actuals` entries, frequencies, volumes.
  No case ids, no raw rows — not even in findings examples.
- Plain Python (`csv`, `datetime`, `statistics`) is enough: group rows by case id, sort by
  timestamp, compute medians and p90. No pandas, no mining tooling required.

## Mapping — `process.yaml` → `mining`

- `mining.case_id` names the business key the log's case column should carry
  (e.g. *Order number* from *ERP*). Sanity-check the log against it.
- `mining.events[]` maps BPMN activity ids to log event names (`activity` ↔ `event`).
  Only mapped activities are observable — every comparison below works on this projection.
- `mining.no_digital_trace` lists activities with no system event. **Never** report these as
  unexecuted; their time is invisible, folded into the surrounding inter-event gap. Say so
  when it distorts a duration.
- Log events with no `mining.events` mapping: report as candidate mapping additions (if they
  match a modeled activity) or as undocumented work (if they don't).

## Analyses

### 1. Performance

Case count and time window; variant frequencies (distinct activity sequences per case, most
frequent first); per-activity elapsed time (median, p90). With one timestamp per event, elapsed
time since the previous event = waiting **plus** processing — state this caveat. Handoff
waiting time: elapsed time on event pairs whose activities sit in different BPMN lanes — the
handoffs the team topology says are expensive. Exclude cases that end mid-window (no mapped
end-anchor event) from duration statistics, or state the truncation bias.

### 2. Conformance — model vs. observed variants

Project the modeled paths onto the mapped activities, then classify each observed variant:

- **Happy path** — matches the projected default flow.
- **Modeled exception** — matches an `exceptions[]` entry (e.g. a reminder loop shows as a
  repeated event). Compare observed share against the documented `frequency`.
- **Unmodeled variant** — a **candidate exception** if frequent (rule of thumb: ≥ 5% of cases
  or more frequent than a documented exception); likely data noise if it appears in a handful
  of cases only.
- Mapped activities that **never occur** in the log are **candidate removals** — or evidence
  the mapping/system integration is broken. Say which reading the data supports.

### 3. KPIs — target vs. actual

For each `kpis[]` entry whose `measured_from`/`measured_to` anchors resolve to mapped events
(a start/end event resolves to the case's first/last mapped event), compute the median case
time between the anchors and compare to `target` respecting `direction`. Then append a
date-stamped entry to that KPI's `actuals` (`date`: end of the log window, `value`: a string
in the target's unit, e.g. `"6.2 business days"`) — this is the **only edit this skill makes**;
run `scripts/validate.ts` afterwards. If the log does not come from the KPI's `source`, note
the discrepancy instead of silently mixing measurement systems. KPIs whose anchors have no
digital trace: skip and say why. Also compare log volume against
`operations.volume.cases_per_period`.

### 4. Model-update proposals

**Proposals only — edits happen after human confirmation.** For each finding, spell out the
concrete change: the `exceptions[]` entry to add (with observed frequency, `as_of` the log
window), the activity to remove or re-map, the `mining.events` mapping to add, the
`operations.volume` update. When the log confirms the model (happy path dominant, exceptions
at documented rates), present that as **evidence for a `last_reviewed` bump** — the bump
itself is the human's call, per `docs/modeling-conventions.md`. Structural rework goes through
`process-review`; prioritization of what to fix first through `strategy-alignment`.

## Output format

Findings ranked by impact (case share × time or money at stake, using `operations`):

```
## Performance: <process-id>        log: <n> cases, <from> → <to>
| # | Finding | Evidence (aggregate) | Impact | Proposed change |
...
KPI actuals: <kpi> target <t> → measured <v> (recorded in kpis[].actuals)
Verdict: model matches reality / needs updates (list). last_reviewed bump: recommended / not yet.
```

Ground every number in the log and every reference in a model element id. If the log cannot
answer a question (unmapped anchors, truncated cases), say which and skip it rather than
guessing.
