---
name: process-feedback
description: Files and triages reports that a process model no longer matches reality — the inbound channel of "let your processes talk". Use when someone says "that's not how we do it anymore", "this step is outdated", or "we skip that check now" (in any conversation, about any process), when the user pastes a PROCESS FEEDBACK block produced by an exported process skill, or when they ask to file, list, triage, accept, or reject process feedback. Owns the processes/<id>/feedback/ inbox convention and drives accepted corrections through model edit, version bump, history entry, and re-approval.
---

# Process Feedback

Models drift. Someone always knows the model is wrong before the model does — this skill is how
they correct it. It owns one convention: `processes/<id>/feedback/` is a git-native inbox, one
Markdown file per discrepancy report. Reports are never deleted; accepted or rejected, they stay
in the repo as the audit trail of how reality corrected the model.

## Report file convention

`processes/<id>/feedback/YYYY-MM-DD-<slug>.md` — date = when reported, slug = kebab-case gist
of the claim.

```markdown
---
status: open                    # open | accepted | rejected
reported: 2026-07-06
source: exported skill order-to-cash v1.0.0   # or: conversation (<who, in what context>)
element: Task_send_reminder     # BPMN element id, or a process.yaml path (e.g. kpis[0].target)
---

# Payment reminders go out automatically, not manually

**Claimed reality:** Since Q2 the payment gateway sends dunning e-mails itself; nobody
performs "Send payment reminder" by hand.
**Reporter:** J. Smith (sales-ops@example.com)
```

`element` may be `unknown` — locating it is part of triage. A decision-rule claim ("the credit
limit changed") points at a DMN file: find it via `decisions[].used_by`, which names the gateway
where the decision applies.

## Intake — two paths

**1. Conversation.** Whenever someone contradicts the model while working in this repo — during
a `process-navigator` answer, a `process-review`, a walkthrough, anywhere — do not argue and do
not silently edit the model. Offer to file the claim as a feedback report and capture it
verbatim: what they say happens, where, since when, from whom.

**2. Exported skills.** Skills exported via `export-process-skill` run outside this repo
(copied from `dist/skills/<id>/` into other projects or claude.ai) and cannot edit it. The
export template instructs the consuming agent to emit a paste-ready block when a user
contradicts the snapshot:

```
PROCESS FEEDBACK — order-to-cash (source version 1.0.0)
Element: Task_send_reminder
Model says: reminders are sent manually by the Payments & Billing Platform team
Reality per reporter: the payment gateway sends them automatically since Q2
Reporter / date: J. Smith, sales-ops@example.com / 2026-07-03
```

(This is the exact format the export template
`.claude/skills/export-process-skill/resources/skill-template.md` specifies.) When the user
pastes one, map it into a report file: the header carries the process id and source version
(→ `source: exported skill <process> v<version>`), `Element:` → the `element` frontmatter
field, `Model says:` + `Reality per reporter:` → the report body, `Reporter / date:` →
`reported`. If the process id matches no directory under `processes/`, list candidates and ask
instead of guessing.

## Triage (on request)

For one process or the whole repository: take every report with `status: open` and assess it
against the current model.

1. **Locate** the element in the BPMN, `process.yaml`, or DMN. A claim about a metadata field
   (`classification`, `supports`, a KPI target, a system) is handled the same way as a flow claim.
2. **Version-check**: if `source_version` is older than the current `version`, read `history` —
   the discrepancy may already be fixed; if so, recommend reject naming the fixing version.
3. **Assess**: does the claim actually contradict the model? Is it specific enough to act on?
   Cross-check `exceptions`, `mining.events`, and the process docs before judging.
4. **Recommend** accept or reject, with reasoning:

```
## Feedback triage: <process-id>
| Report | Element | Claim (gist) | Recommendation | Why |
```

Recommendations are recommendations — accept/reject is the human's call.

## On ACCEPT (only with explicit human confirmation)

1. Apply the correction: edit the BPMN (per `docs/modeling-conventions.md`) and/or
   `process.yaml`. Check ripples — e.g. an automated *Send payment reminder* also leaves
   `mining.no_digital_trace` and may change `automation.status`.
2. Bump `version` (semver) and add a `history` entry naming the feedback file as the reason.
3. Do **not** update `approval` — `approval.version` now trails `version`, which is exactly the
   signal that re-approval is pending (`scripts/validate.ts` flags the mismatch). The process
   owner re-approves per `docs/governance.md`; only then does the model count as released
   `as-is` again.
4. Set the report's `status: accepted` and append a `## Decision` section: who confirmed, what
   changed, resulting version.
5. Staleness check: if `dist/skills/<id>/` exists or `published[]` has entries, say so — the
   deployed snapshots now lag; re-export with `export-process-skill` after re-approval and
   notify each `published[].contact`.
6. Run `scripts/validate.ts`.

## On REJECT

Set `status: rejected` and append a `## Decision` section with the reasoning ("already fixed in
v1.1.0", "describes a local workaround, not the process"). Keep the file — a rejected report
still documents that someone believed this, which is signal for the next review.

## Rules

- Never change a model on a report alone: file first, triage second, edit only after human
  confirmation.
- One report per discrepancy — split multi-claim input into separate files.
- Feedback files are append-only: change `status` and append decisions, never rewrite the
  original claim.
