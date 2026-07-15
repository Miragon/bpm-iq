---
name: import-process
description: Imports existing process documentation — draw.io or Visio XML, pasted Word/Confluence text, flowchart images the agent reads, PowerPoint exports — into the repository structure. Extracts activities, decisions, roles, and systems; maps them against the team topology and glossary; generates a convention-conform processes/<id>/ directory with BPMN (complete diagram layout) and a draft process.yaml; records provenance and runs validation. Use when the user wants to import, convert, migrate, or digitize an existing process document, diagram, or wiki page — "we already have this in Confluence / Visio / PowerPoint", "turn this flowchart into a process model".
---

# Import Process

Turn a legacy process artifact into a repository-conform **draft**. The output is a claim
about how the process works, extracted from a document — it becomes authoritative only after
the process owner confirms it (ideally via a `capture-process` playback). Never present an
import as more than that.

## Input

One source artifact: a draw.io/Visio XML file, pasted Word or Confluence text, a flowchart
image or screenshot, or a PowerPoint export. Plus, if not inferable: the process id
(kebab-case) and its `classification`.

## Steps

1. **Parse or read the artifact.**
   - *draw.io / Visio XML*: shapes with style hints (rhombus → gateway, ellipse → start/end
     event, rectangle → task) and edges with their labels. `.vsdx` is a zip of XML pages —
     extract before parsing.
   - *Word / Confluence text*: numbered steps become activities; "if / otherwise" sentences
     become gateways with their answers; "X does Y" names the role.
   - *Images*: transcribe every shape, label, and connector first; interpret second. State
     what is illegible instead of guessing.
   - *PowerPoint*: treat slide order as flow order only where arrows confirm it.

2. **Extract the flow**: trigger, outcome(s), activities, decision points with their answers,
   roles/lanes, systems, and exceptions. Keep a running list of everything ambiguous or
   unreadable — it feeds step 5.

3. **Map against the landscape** (do not skip):
   - Roles and lanes → node ids/labels in `landscape/team-topology.tt`. Legacy documents name
     people; lanes name roles or teams (convention rule 7) — replace *Alice* with her role and
     note the substitution.
   - Vocabulary → `landscape/glossary.yaml`: when the source uses a synonym (*Auftrag*,
     *dunning notice*), model with the canonical `term`; the synonym stays in the glossary only.
   - A role, value chain step, Wardley component, or term with no landscape match: **ask**
     whether to (a) extend the landscape model or (b) map to an existing element — extending
     the landscape is a strategic act, same rule as `new-process` step 5. Never extend silently.

4. **Generate `processes/<id>/`** from `templates/process/` (scaffold and DI-id renames as in
   `new-process` steps 2–3):
   - BPMN per `docs/modeling-conventions.md`: tasks verb + object, events object + past
     participle, gateways as closed questions with labeled flows, happy path left → right,
     exceptions downward. Include **complete BPMNDI** — every shape and edge — reusing the
     layout patterns from `templates/process/process.bpmn`. More than 7 ± 2 activities →
     extract level-3 models into `subprocesses/`.
   - `process.yaml`: `status: draft`, `version: 0.1.0`, `last_reviewed:` = import date (the
     scaffold date, not a confirmed review), `classification` asked or inferred — `core`
     requires `value_chain.steps`, `support` requires `supports`. First `history` entry:
     `Imported from <source document>`. Fill only what the source backs; do not fabricate
     KPIs, `operations`, or `mining` blocks.

5. **Record provenance in `docs/overview.md`**: fill the template from the source, then add a
   *Provenance* section with the source document (name and location), import date, and the
   elements that could not be mapped — unknown roles, terms missing from the glossary,
   dangling flows, illegible shapes. Mark gaps with explicit `<todo>` markers.

6. **Add an `INDEX.md` row** in `processes/INDEX.md`, matching the existing columns.

7. **Validate and report**: run `node scripts/validate.ts <id>`, report its findings, then
   list what a human must confirm — inferred classification, owner team, gateway logic,
   exception handling, and every item from the unmapped list. Recommend a `capture-process`
   playback with the process owner as the confirmation path, and `process-review` once the
   draft has been corrected.

## Rules

- **The import is a draft.** Never set `status` beyond `draft`, never add an `approval` block,
  never claim `last_reviewed` as a confirmed review. Authority comes from the owner's
  confirmation, not from the import.
- **Transcribe, don't invent.** A plausible-sounding fabrication is worse than a visible
  `<todo>` — agents will answer from it.
- **Document ≠ process.** One artifact may hold several trigger-to-outcome flows, or none;
  split or merge by trigger → outcome, not by document boundaries.
- The source document stays outside the repo — reference it in the provenance section. The
  model of record is the BPMN plus `process.yaml`.
