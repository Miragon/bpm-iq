---
name: process-feedback
description: Files and triages reports that a process model no longer matches reality — the inbound channel of "let your processes talk". Use when someone says "that's not how we do it anymore", "this step is outdated", or "we skip that check now" (in any conversation, about any process), when the user pastes a PROCESS FEEDBACK block produced by an exported process skill, or when they ask to file, list, triage, accept, or reject process feedback. Owns the feedback/<id>/ inbox convention and drives accepted corrections through a model edit.
---

# Process Feedback

Models drift. Someone always knows the model is wrong before the model does — this
skill is how they correct it. It owns one convention: `feedback/<id>/` (at the repo
root) is a git-native inbox, one Markdown file per discrepancy report. Reports are
never deleted; accepted or rejected, they stay in the repo as the audit trail of how
reality corrected the model.

## Report file convention

`feedback/<id>/YYYY-MM-DD-<slug>.md` — `<id>` = the process (its `.bpmn` file stem),
date = when reported, slug = kebab-case gist of the claim.

```markdown
---
status: open                    # open | accepted | rejected
reported: 2026-07-06
source: exported skill order-to-cash   # or: conversation (<who, in what context>)
element: Task_send_reminder     # the BPMN element id the claim is about
---

# Payment reminders go out automatically, not manually

**Claimed reality:** Since Q2 the payment gateway sends dunning e-mails itself;
nobody performs "Send payment reminder" by hand.
**Reporter:** J. Smith (sales-ops@example.com)
```

`element` may be `unknown` — locating it in the BPMN is part of triage.

## Intake — two paths

**1. Conversation.** Whenever someone contradicts the model while working in this
repo — during a `process-navigator` answer, a `process-review`, a walkthrough — do
not argue and do not silently edit the model. Offer to file the claim as a feedback
report and capture it verbatim: what they say happens, where, since when, from whom.

**2. Exported skills.** Skills exported via `export-process-skill` run outside this
repo and cannot edit it; they emit a paste-ready block when a user contradicts the
snapshot:

```
PROCESS FEEDBACK — order-to-cash
Element: Task_send_reminder
Model says: reminders are sent manually by the Billing role
Reality per reporter: the payment gateway sends them automatically since Q2
Reporter / date: J. Smith, sales-ops@example.com / 2026-07-03
```

When the user pastes one, map it into a report file: the header carries the process
id, `Element:` → the `element` field, `Model says:` + `Reality per reporter:` → the
body, `Reporter / date:` → `reported`. If the id matches no `.bpmn` in the repo,
list candidates and ask instead of guessing.

## Triage (on request)

For one process or the whole repository: take every report with `status: open` and
assess it against the current model.

1. **Locate** the element in the BPMN (`get_model` / read the `.bpmn`).
2. **Assess**: does the claim actually contradict the model? Is it specific enough
   to act on?
3. **Recommend** accept or reject, with reasoning:

```
## Feedback triage: <process-id>
| Report | Element | Claim (gist) | Recommendation | Why |
```

Recommendations are recommendations — accept/reject is the human's call.

## On ACCEPT (only with explicit human confirmation)

1. Apply the correction: edit the `.bpmn` per the modeling conventions (keep
   semantics and BPMNDI in sync).
2. Set the report's `status: accepted` and append a `## Decision` section: who
   confirmed, what changed.
3. Validate: `node packages/validator/src/validate.ts --root . <id>`.
4. If the process was exported (`dist/skills/<id>/` exists), say so — the deployed
   snapshot now lags; re-export with `export-process-skill`.

## On REJECT

Set `status: rejected` and append a `## Decision` section with the reasoning
("describes a local workaround, not the process"). Keep the file — a rejected report
still documents that someone believed this, which is signal for the next review.

## Rules

- Never change a model on a report alone: file first, triage second, edit only after
  human confirmation.
- One report per discrepancy — split multi-claim input into separate files.
- Feedback files are append-only: change `status` and append decisions, never
  rewrite the original claim.
