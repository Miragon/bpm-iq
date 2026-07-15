# Migrating an Existing Documentation Corpus

Most organizations do not start empty: there is a wiki space, a folder of Visio diagrams, a
shared drive of Word files. This playbook moves that corpus into the repository without
turning it into a second graveyard. The unit of progress is a **confirmed `as-is` process**,
not an imported file.

## 1. Inventory

List the corpus in one place: document, format, location, last meaningful update, and — most
important — _who asked about it in the last year_. Do not read everything deeply yet; the
inventory decides what gets read at all.

**Prioritize by demand, not by folder order.** Start with the ~5 processes people actually
ask about — check support channels, onboarding questions, the "how do we…" messages. Those
imports pay for themselves immediately; the rest can wait for a pull.

**Do not migrate dead documents.** A document nobody asked about in a year is an artifact,
not a managed process. Record the skip decision in the inventory and move on — an imported
draft nobody will ever confirm only clutters `processes/INDEX.md` and `validate.ts` output.
If the underlying process still matters, someone will ask, and it re-enters at step 3.

## 2. Classify and map

For each item that survives the inventory, decide `classification` (`core` | `support` |
`management`, see `docs/process-metadata.md`) and where it attaches: core processes map to
step ids in `landscape/value-chain.vc.json` (`value_chain.steps`), support processes name
what they enable (`supports`). Two signals fall out of this pass:

- a document that maps to no value chain step either reveals an incomplete value chain
  (extend it deliberately — that is a strategic decision, not a migration chore) or describes
  activity rather than a process → back to "do not migrate";
- a value chain step with no candidate document is a coverage gap — note it; the
  `strategy-alignment` skill reports these later.

## 3. Batch-import as drafts

Run the `import-process` skill per document. Each import lands as `processes/<id>/` with
`status: draft`, provenance and unmapped elements recorded in the process's
`docs/overview.md`, and a row in `processes/INDEX.md`. Two points of batch discipline:

- run `node scripts/validate.ts` after each batch — do not accumulate twenty broken drafts;
- when several documents describe the same trigger → outcome, import **once** and list all
  sources in the provenance section.

## 4. Owner review and confirmation

A draft is a claim extracted from a document, possibly years stale. Play each draft back to
the process owner via the `capture-process` skill, correct the model, and set
`last_reviewed` only after the owner confirms model = reality. If no owner can be found, the
process has no owner — that is a finding for management, and the draft stays parked as
`draft` until it has one.

## 5. Flip to as-is

After confirmation: set `status: as-is`, add the `approval` block (`approved_by`, `date`,
`version` equal to the top-level `version`), and append a `history` entry.
`scripts/validate.ts` enforces the approval block for `as-is` and the version match — the
flip is mechanical once the review is real.

## 6. Re-export

Where consumers need a process outside this repo, run `export-process-skill` and record the
deployment in `published`. On later changes, `validate.ts` flags stale exports
(`source_version` in the exported `context.yaml` vs. the process `version`) — re-export
instead of hand-editing `dist/`.

---

Measure the migration in confirmed processes per week, not documents imported. Twenty
unconfirmed drafts are corpus-shaped debt; five confirmed `as-is` processes that answer real
questions are the point.
