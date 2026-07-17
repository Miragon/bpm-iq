---
name: import-process
description: Imports existing process documentation — draw.io or Visio XML, pasted Word/Confluence text, flowchart images the agent reads, PowerPoint exports — into the repository as a BPMN model. Extracts activities, decisions, and roles; generates a convention-conform .bpmn with a complete diagram layout; records provenance and runs the validator. Use when the user wants to import, convert, migrate, or digitize an existing process document, diagram, or wiki page.
---

# Import Process

Turn a legacy process artifact into a repository-conform **draft** `.bpmn`. The
output is a claim about how the process works, extracted from a document — it
becomes authoritative only after the process owner confirms it (ideally via a
`capture-process` playback). Never present an import as more than that.

## Input

One source artifact: a draw.io/Visio XML file, pasted Word or Confluence text, a
flowchart image or screenshot, or a PowerPoint export. Plus, if not inferable:
the process id (kebab-case).

## Steps

1. **Parse or read the artifact.**
   - *draw.io / Visio XML*: shapes with style hints (rhombus → gateway, ellipse →
     start/end event, rectangle → task) and edges with their labels. `.vsdx` is a
     zip of XML pages — extract before parsing.
   - *Word / Confluence text*: numbered steps become activities; "if / otherwise"
     sentences become gateways with their answers; "X does Y" names the role.
   - *Images*: transcribe every shape, label, and connector first; interpret
     second. State what is illegible instead of guessing.
   - *PowerPoint*: treat slide order as flow order only where arrows confirm it.

2. **Extract the flow**: trigger, outcome(s), activities, decision points with
   their answers, roles (→ lanes), and exceptions. Keep a running list of
   everything ambiguous or unreadable — it feeds step 4.

3. **Generate `<processes-folder>/<id>.bpmn`** (as in `new-process`):
   - BPMN per the modeling conventions: tasks verb + object, events object + past
     participle, gateways as closed questions with labeled flows, happy path left
     → right, exceptions downward. Roles become **lanes** (lane name = role/team,
     not a person's name — replace *Alice* with her role and note the swap).
   - Include a **complete BPMNDI** — a shape for every flow node, lane and pool,
     an edge for every flow.
   - More than ~7±2 activities → extract a step into `subprocesses/<sub>.bpmn`
     and link it via `callActivity calledElement="<sub>"`.
   - Mark anything you could not determine with a BPMN `<textAnnotation>` `<todo>`
     rather than inventing it.

4. **Record provenance and gaps**: state, in your report, the source document
   (name and location), the import date, and every element that could not be
   mapped — unknown roles, dangling flows, illegible shapes.

5. **Validate and report**: run
   `node packages/validator/src/validate.ts --root . <id>`, report its findings,
   then list what a human must confirm — gateway logic, exception handling, and
   every item from the unmapped list. Recommend a `capture-process` playback with
   the process owner as the confirmation path, and `process-review` once the draft
   has been corrected.

## Rules

- **The import is a draft.** Authority comes from the owner's confirmation, not
  from the import.
- **Transcribe, don't invent.** A plausible-sounding fabrication is worse than a
  visible `<todo>` — agents will answer from it.
- **Document ≠ process.** One artifact may hold several trigger-to-outcome flows,
  or none; split or merge by trigger → outcome, not by document boundaries.
- The source document stays outside the repo — reference it in your report. The
  model of record is the `.bpmn`.
