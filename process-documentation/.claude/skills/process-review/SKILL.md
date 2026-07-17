---
name: process-review
description: Quality gate for process models — runs the deterministic validator (BPMN structure + BPMNDI coverage + callActivity link integrity), then checks BPMN modeling conventions and diagram clarity by judgment. Use when the user asks to review, validate, lint, or check a process, before merging model changes, or for a portfolio health report.
---

# Process Review

Review one process (a `.bpmn` file) or the whole repository. Report findings;
only fix them when the user asks.

## Step 0 — Run the deterministic validator first

```
node packages/validator/src/validate.ts --root . [<process-id>]
```

(from the monorepo root; `--root <checkout>` for another repo). It covers the
mechanical invariants: XML well-formedness, namespace declarations, flow
structure (one start event, no unreachable nodes or dead ends, valid
sequenceFlow/message-flow references, boundary attachments), **BPMNDI coverage**
(every flow node, lane, pool and edge has a shape — or the visual editor breaks),
lane assignment, and **callActivity link integrity** (each `calledElement`
resolves to a process in the repo). Include its output verbatim in your report,
then spend your own effort ONLY on what the script cannot judge:

## A. Judgment checks — BPMN conventions

- A1: tasks named **verb + object** ("Check credit limit"); events **object +
  past participle** ("Order received"); exclusive gateways named as closed
  **questions** ("Approved?") with named outgoing flows.
- A2: one end event per distinct outcome, named after it — check count and names
  yourself; the validator only enforces flow structure around end events.
- A3: lane (role) names are meaningful team/role labels, consistent across the
  portfolio (the same team spelled the same way everywhere).
- A4: every splitting gateway has a matching join of the same type, unless the
  branches deliberately end in separate end events.
- A5: a gateway that encodes a business rule is preceded by a task that produces
  the data the branch needs (the decision is obtainable at that point in the flow).

## B. Judgment checks — clarity

- B1: happy path flows left to right, exceptions branch downward; no avoidable
  crossings.
- B2: activity count per pool/sub-process stays within ~7±2 — extract a
  sub-process (`callActivity` → separate `.bpmn`) when it grows past that.
- B3: sub-process boundaries are meaningful (a called process is a coherent unit
  of work, not an arbitrary split).

## C. Portfolio mode (whole-repository review)

Run the validator repo-wide (no process id) and aggregate: files with structural
or DI errors, dangling `callActivity` calls (warnings), duplicate process ids
(the validator/discovery keep the first and log the rest), and orphan
sub-processes that nothing calls.

## Output format

```
## Review: <process-id>            severity: ERROR | WARN | INFO
### validator
<verbatim output>
### judgment findings
| # | Check | Severity | Finding | Where |
...
Summary: N errors, M warnings. Verdict: ready / needs work.
```

Be specific: name the element id, the file, and what to change. If everything
passes, say so plainly — do not invent findings to seem thorough.
