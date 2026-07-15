# Governance — the Git-Native Operating Model

Classic BPM governance lives in committees and release forms. Here it lives in the repository:
a **pull request is the change request**, a **merge approval is the release decision**, and
**git history is the audit trail**. Nothing below introduces a second mechanism — it only says
who approves what, and what `scripts/validate.ts` enforces mechanically.

## Roles

| Role                   | Accountability                                 | In the repo                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Process owner**      | Accountable for one process; approves releases | Approves PRs touching `processes/<id>/` — their merge approval _is_ the release. Named via `owner.team` (+ `owner.role`) in `process.yaml`, and in the `approval` block once the model is `as-is`.                       |
| **Process manager**    | Maintains the model and metadata day-to-day    | Edits BPMN, `process.yaml`, docs, and triages `processes/<id>/feedback/`; opens the PRs the owner approves. May be the same person as the owner in small organizations.                                                  |
| **CoE / method owner** | Owns the shared method, not any single process | Approves changes to `landscape/`, `docs/` conventions, `schemas/`, `scripts/`, and `.claude/skills/`. In the example organization this is `team-process-excellence` (the enabling team in `landscape/team-topology.tt`). |

## Decision rights by path

Encoded in [`.github/CODEOWNERS`](../.github/CODEOWNERS) — keep it in sync with `owner.team`.

| Path                                               | Approval needed                   | Why                                                                                                     |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `processes/<id>/`                                  | The process's `owner.team`        | Model, metadata, docs, and feedback of one process                                                      |
| `landscape/`                                       | CoE **+ affected process owners** | Shared models: renaming a team id or value chain step id breaks every `process.yaml` that references it |
| `docs/`, `schemas/`, `scripts/`, `.claude/skills/` | CoE                               | Conventions, the metadata contract, validation, and the skills that apply them                          |

Cross-cutting rule: **run `scripts/validate.ts` before merging any landscape or schema change.**
It resolves every reference (`owner.team`, `value_chain.steps[]`, `wardley.components[]`,
BPMN element ids) and fails the merge conversation early instead of breaking consumers silently.

## Release lifecycle

`status` in `process.yaml` moves `draft` → `to-be` → `as-is` → `deprecated` (see
[method.md](method.md)). Releases are governed by three rules — rules 1 and 3 fail
`validate.ts` (and CI) as errors; rule 2 surfaces as a warning:

1. **`as-is` requires approval.** An `approval` block (`approved_by`, `date`, `version`) is
   mandatory once `status: as-is` — it records who released the model as reality.
2. **Every version bump gets a `history` entry** — what changed and when (ideally by whom via
   the optional `changed_by`). The bump itself follows
   [modeling-conventions.md](modeling-conventions.md): semver, on semantic model change.
3. **Changes reset approval.** `validate.ts` errors when `approval.version != version`: bumping
   the version of an approved model invalidates the old approval, and the owner re-approves by
   updating the block in the same PR they merge. No stale seals of approval.

## Review cadence

- Each process declares `review_cycle_months` (default 12; `order-to-cash` uses 6). When
  `last_reviewed` exceeds the cycle, `validate.ts` warns — staleness is visible, not silent.
- `last_reviewed` is only updated after a **human** confirmed model = reality; passing CI is
  not a review.
- **Portfolio health** comes from running the `process-review` skill in repo-wide mode: overdue
  reviews, `as-is` processes without a valid approval, stale exports under `dist/skills/`
  (`exported.source_version` behind the process version), and `INDEX.md` drift — one report
  instead of a governance board meeting.

## How non-git business users contribute

Most people who _live_ a process will never open a pull request — and they don't have to.
They talk to the process: each exported skill (`dist/skills/<id>`, built by
`export-process-skill`) answers in their language, and when reality disagrees with the model,
the `process-feedback` skill files their correction as a structured entry in
`processes/<id>/feedback/`. The process manager triages the queue, turns accepted items into a
PR (model change + version bump + history entry), and the owner's merge releases it. The
contributor never touches git; the audit trail is complete anyway.
