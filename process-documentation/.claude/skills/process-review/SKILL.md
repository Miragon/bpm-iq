---
name: process-review
description: Quality gate for process models — runs the deterministic validator, then checks BPMN modeling conventions, metadata completeness, governance consistency, glossary alignment, and cross-model link integrity (value chain, Wardley map, team topology references). Use when the user asks to review, validate, lint, or check a process, before merging model changes, or for a portfolio health report.
---

# Process Review

Review one process (`processes/<id>/`) or the whole repository. Report findings; only fix them
when the user asks.

## Step 0 — Run the deterministic validator first

```
node scripts/validate.ts [<process-id>]
```

It covers the mechanical invariants: schema conformance (`schemas/process.schema.json`),
placeholder detection, landscape link resolution, file paths, BPMN structure + DI coverage,
lane→team mapping, element-id references (`controls`, `kpis`, `decisions`, `mining`),
classification rules, approval/version match, review-cycle staleness, INDEX sync, and export
freshness. Include its output verbatim in your report — then spend your own effort ONLY on
what the script cannot judge:

## A. Judgment checks — metadata

- A1: `purpose`/`trigger`/`outcome` are specific, not generic filler
- A2: KPIs measure the outcome, not activity for its own sake; `direction` is plausible;
  `actuals` are recent enough to be meaningful (compare `date` vs. today)
- A3: `exceptions[]` describes business failure modes, not IT incidents; `frequency` states
  its as-of date
- A4: `history` entries actually describe the change ("updated model" is not a change note)
- A5: `risks`/`controls` pass the auditor test: is the control observable at the referenced
  BPMN element? Does every high-impact risk have a `mitigated_by` that maps to a control?

## B. Judgment checks — BPMN conventions (docs/modeling-conventions.md)

- B1: tasks named verb + object; events object + past participle; exclusive gateways named as
  closed questions with named outgoing flows
- B2: one end event per distinct outcome, named after it — check count and names yourself; the
  validator only enforces flow structure around end events, it does not count them
- B3: exceptions listed in `process.yaml` are visible in the model (boundary event, exception
  flow, or loop)
- B4: happy path flows left to right, exceptions branch downward; no avoidable crossings
- B5: a gateway backed by a DMN decision (`decisions[].used_by`) should be preceded by a
  `businessRuleTask` or service task that evaluates it — and the decision table's inputs must
  be obtainable at that point in the flow
- B6: every splitting gateway has a matching join of the same type, unless the branches
  deliberately end in separate end events (convention rule 3)

## C. Judgment checks — cross-view consistency

- C1: BPMN lane names vs. `owner`/`participants` teams — every lane maps to an involved team
- C2: `participants[].interaction` does not contradict `landscape/team-topology.tt`
- C3: systems in `process.yaml` that sound like Wardley components but are not on the map (warn)
- C4: domain nouns in task/event names that are neither `term` nor synonym in
  `landscape/glossary.yaml` → WARN and suggest a glossary entry; names using a synonym instead
  of the canonical term → WARN (models speak the canonical language, synonyms live in the glossary)
- C5: `automation.status: live` but the descriptive model and `<id>.executable.bpmn` diverge
  semantically → ERROR (see docs/automation.md)

## D. Portfolio mode (whole-repository review)

After per-process findings, close with a **portfolio health** section — this is the
management-review / audit-readiness report (docs/governance.md).

Aggregate from the Step 0 validator output (run repo-wide, no process id): overdue reviews,
`as-is` processes without a matching-version approval, stale or orphaned exports under
`dist/skills/`, broken `supports[]` targets.

Add the analyses only you can do:

- outdated `published[]` deployments (exports re-generated but consumers not notified)
- open feedback (`processes/*/feedback/*.md` with `status: open`) older than 30 days
- value chain steps with no core process referencing them
- KPIs without `actuals`, and `operations`/`actuals` whose `as_of` dates have gone stale

## Output format

```
## Review: <process-id>            severity: ERROR | WARN | INFO
### validator (scripts/validate.ts)
<verbatim output>
### judgment findings
| # | Check | Severity | Finding | Where |
...
Summary: N errors, M warnings. Verdict: ready / needs work.
```

Be specific: name the element id, the file, and what to change. If everything passes, say so
plainly — do not invent findings to seem thorough.
