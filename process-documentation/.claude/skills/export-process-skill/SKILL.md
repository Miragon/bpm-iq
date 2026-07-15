---
name: export-process-skill
description: Exports a business process — including its BPMN models, sub-processes, docs, and resolved landscape dependencies (owning team, value chain steps, Wardley components) — as a self-contained, portable agent skill under dist/skills/. Use when the user wants a process "as a skill", wants processes to be usable by other agents or projects, or says "let this process talk".
---

# Export Process as Skill

Package one process into a skill any agent can load — in another repo's `.claude/skills/`, in
Claude Code, or on claude.ai. The exported skill lets the consuming agent answer questions
about the process, guide people through it, and reason about its dependencies **without access
to this repository**. That is the point: the process itself becomes the interface.

## Input

A process id (directory under `processes/`). If ambiguous, list available processes.

## Step 1 — Resolve the full dependency closure

Read `processes/<id>/process.yaml` and resolve every reference. Nothing may remain a dangling
pointer in the export:

| Reference | Resolve from | Into |
|---|---|---|
| `owner.team`, `participants[].team` | `landscape/team-topology.tt` | team label, type, description, interaction modes |
| `value_chain.steps[]` | `landscape/value-chain.vc.json` | step names + upstream/downstream neighbor steps |
| `wardley.components[]` | `landscape/wardley-map.owm` | evolution + stage name, sourcing decorators like `(buy)`/`(outsource)`, and direct dependencies in both directions (`A -> B` lines; label anchors as anchors). OWM syntax: in `component <Name> [a, b]` the pair is **[visibility, evolution]** — evolution is the *second* value. Stages: <0.25 genesis, <0.5 custom-built, <0.75 product, ≥0.75 commodity |
| `models.bpmn`, `subprocesses[].file`, `decisions[].file` | the files | copied verbatim (decisions land in `resources/decisions/`) |
| `docs[]` (incl. `docs/tasks/*.md`) | the files | copied, then relative links rewritten to the package layout (`<id>.bpmn` → `process.bpmn`, `process.yaml` → `context.yaml`; links leaving the package become plain text plus a "source repository" note) |
| glossary terms | `landscape/glossary.yaml` | the slice of terms whose `term` or synonyms appear in the process's models, metadata, or docs → `resources/glossary.yaml`; feed the synonyms into the SKILL.md description's domain vocabulary |
| `approval`, `history` | `process.yaml` | copied into `context.yaml` so consumers can answer "who approved this?" and "what changed?" |
| `related_processes[]` | their `process.yaml` **if modeled**; otherwise fall back to the `id`/`relationship`/`note` from the source `process.yaml`, marked `not modeled in the source repository` | id, name/relationship, one-line purpose or note (summary, not full export) |

Hard references — `owner.team`, `participants[].team`, `value_chain.steps[]`,
`wardley.components[]`, and every file path — MUST resolve; if one does not, stop and report it
(suggest `process-review`) instead of exporting a broken skill. `related_processes[]` is a soft
reference: an unmodeled related process is noted, never a blocker.

## Step 2 — Generate the skill package

Create `dist/skills/<id>/` (overwrite an existing export of the same process):

```
dist/skills/<id>/
├── SKILL.md                    # generated from resources/skill-template.md (in this skill's folder)
└── resources/
    ├── process.bpmn            # copy of <id>.bpmn
    ├── subprocesses/           # copies, if any
    ├── decisions/              # DMN copies, if any
    ├── context.yaml            # fully resolved metadata — self-contained, no repo paths
    ├── walkthrough.md          # generated narrative (see below)
    ├── glossary.yaml           # the process-relevant glossary slice, if a glossary exists
    └── docs/                   # copies of the process docs, if any
```

**SKILL.md**: instantiate `resources/skill-template.md` (next to this file); its placeholder
text is normative. The frontmatter `name` is the process id; the `description` must be written
for discovery by the consuming agent: name the trigger, the outcome, and the domain vocabulary
(systems, artifacts) so the skill activates on real user questions. Drop any claim the source
data does not back (no KPIs modeled → don't claim to know KPIs). Keep it under 1024 characters,
third person. Counting rules for the template: *activities* = tasks of any type + call
activities; *decision points* = gateways with more than one outgoing flow; count the main
model only (sub-processes are listed in their own resource row).

**context.yaml**: the `process.yaml` content with every landscape reference *expanded in place* —
keep the id and nest the resolved data next to it (e.g. `team: team-order-management` gains
`label`, `type`, `description`). Add an `exported` block: `from` = the git remote URL, or the
repository directory name if there is no remote; `date` = today; `source_version` = the
process's `version` from `process.yaml` (plus the short git commit hash if available).
A consumer must never need `landscape/` files.

**walkthrough.md**: generate from the BPMN, not from imagination:
1. numbered happy path — each step: performing lane/team, task type (human/automated/message),
   what happens
2. decision points — the gateway question and where each answer leads
3. exceptions & loops — from boundary events, exception flows, and `exceptions` metadata
4. handoffs — every lane transition, with the interaction mode between the teams involved.
   Lane → team mapping: lane names equal team labels in the topology (convention rule 7);
   if a lane diverges, resolve it via `participants` in `process.yaml` and note the mapping

## Step 3 — Validate before reporting

- frontmatter `name` matches the folder name, kebab-case; `description` < 1024 chars
- every file referenced in the generated SKILL.md exists inside the package
- no path in the package points outside `dist/skills/<id>/`, and every relative link inside
  copied docs resolves within the package (the rename to `process.bpmn`/`context.yaml` breaks
  verbatim links — Step 2 rewrites them; verify none were missed)
- `context.yaml` parses, and every landscape id in it (`team:`, `steps[]`, components) sits next
  to its resolved fields (`label`/`type`/`stage`…) — a bare id with no resolved data beside it
  means Step 1 was skipped for that reference and the export is not self-contained
- re-read the generated SKILL.md once as a cold reader: could an agent with only this folder
  answer "walk me through this process" and "who owns this"? If not, fix it.

## Step 4 — Report

State what was exported, where, and how to use it:
- copy `dist/skills/<id>/` into any project's `.claude/skills/` directory, or
- zip the folder and upload it as a skill on claude.ai.

Then ask where the export will be deployed and record it in the process's `published:` list
(`location`, `date`, `contact`) — that list is how staleness is traced back to consumers.
If `published:` already has entries, list them: "this export is also deployed at X — propagate
the update there."

Remind: exports are snapshots — `scripts/validate.ts` flags a stale `dist/skills/<id>` the
moment the source `version` moves on. After changing the process, re-export — never hand-edit
`dist/skills/`.
