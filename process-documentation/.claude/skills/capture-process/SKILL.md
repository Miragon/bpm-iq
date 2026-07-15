---
name: capture-process
description: Conversational process capture — interviews a process owner who cannot write BPMN or YAML, elicits trigger, outcome, happy path, decisions, handoffs, KPIs, and exceptions one question at a time, plays the understood process back in plain language for correction, then hands the confirmed data to the new-process skill for scaffolding. Use when someone wants to talk through, describe, or explain how their process works, wants a process documented from an interview, says "let me tell you how we do X", or says they don't know BPMN.
---

# Capture Process

Turn a conversation with a process owner into structured input for `new-process`. The
interviewee knows the work; you know the schema (`docs/process-metadata.md`) and the modeling
conventions (`docs/modeling-conventions.md`). Never ask them to think in BPMN, gateways, or
YAML — translate silently.

## Interview protocol

Work through the phases in order. Do not scaffold anything until phase 5 is confirmed.

### 1. Pin trigger and outcome

Before any steps: what starts the process, and what state is guaranteed at the end? These
become `trigger` and `outcome` in `process.yaml`. If the answer is vague ("it just kind of
starts"), offer concrete candidates ("an email arrives? a ticket is created?") until it is
pinned. Also ask what the process delivers and for whom — this settles `purpose` and hints at
`classification` (creates customer value → `core` with `value_chain.steps`; enables other
processes → `support` with `supports`).

### 2. Walk the happy path, one step at a time

"What happens first?" Then, for each step, probe before moving on:

- **Who does it?** — a role or team, not a person (→ lanes, `owner.team`, `participants[]`)
- **Which system?** — where the work happens or is recorded (→ `systems[]`)
- **How do you know it's done?** — a system event here is a mining hook
  (→ `mining.events[]`); "someone just knows" goes to `mining.no_digital_trace`
- **What can go wrong here?** — collect for phase 4; do not chase every branch now, or the
  happy path unravels

Name each step internally as verb + object (*Check credit limit*) but keep speaking the
interviewee's words. Around 7 steps at this level is right; if a step explodes into sub-steps,
note it as a level-3 sub-process candidate and pull back up.

### 3. Probe decisions and handoffs

For every point where the path forks, get three things: the **question** being asked (a closed
question — *Credit approved?*), the **possible answers** (the labeled outgoing flows), and the
**rule behind it** ("how do you decide?"). If the rule is expressible as conditions over inputs
(limits, thresholds, tables people look things up in), flag it as a DMN candidate — it becomes
`decisions[]` with `used_by` pointing at the gateway. If the answer is "experience" or "gut
feeling", record that honestly; it is a finding, not a failure.

For every point where a different team takes over, ask how the handoff works: do the teams work
on it together (`collaboration`), does one consume the other's service through a defined
interface (`x-as-a-service`), or is one temporarily helping the other (`facilitating`)? This
fills `participants[].interaction` and must not contradict `landscape/team-topology.tt` — if it
does, that tension is worth naming to the interviewee.

### 4. Probe operations: KPIs, volumes, exceptions

- **How is success measured?** Name, target, and direction (→ `kpis[]`). "We don't measure it"
  is a valid answer — record the absence, do not invent a metric.
- **How often does this run?** Cases per period, roughly (→ `operations.volume`). An honest
  "about 50 a month, I think" beats silence — capture it with the caveat.
- **What are the known failure modes?** Revisit everything collected in phase 2's "what can go
  wrong": how is each handled, how often does it happen (→ `exceptions[]` with `handling` and
  `frequency`)?

### 5. Play back — "here is what I heard"

Present the entire understood process as a plain numbered list in the interviewee's own
vocabulary: trigger, steps with who/system, decisions with their answers, handoffs, exceptions,
outcome. Then ask them to correct it: what is wrong, what is missing, what did you
over-simplify? Fold in corrections and play back the changed parts again. **Iterate until the
owner explicitly confirms.** Anything they hesitate on or cannot confirm stays in the capture —
marked, not dropped.

### 6. Hand over to `new-process`

Only after confirmation, invoke the `new-process` skill and hand it the collected data: id
candidate, name, purpose, trigger, outcome, classification, owner team, participants with
interaction modes, the step sequence, decision candidates, KPIs, volumes, systems, exceptions,
and glossary candidates. If landscape anchoring did not come up naturally, ask now — which
value chain step does this serve (or, for a support process, what does it enable), and which
capabilities does it lean on? `new-process` resolves these answers against the `landscape/`
models with you; a core process cannot scaffold without its `value_chain.steps`. Constraints
on the scaffold:

- `status: draft` — an interview is not a review; `last_reviewed` is the capture date, and the
  process stays `draft` until the owner has seen the actual model.
- Every element the owner did not confirm in phase 5 gets an explicit **"(unconfirmed)"**
  marker in `docs/overview.md`, so the gap survives into the repository instead of hardening
  into fact.
- Suggest `process-review` once the BPMN has substance, and a follow-up session with the owner
  in front of the rendered diagram.

## Conduct

- **Pacing**: one question at a time. Never post a wall of questions — an interrogation form
  kills recall. Let stories run; extract the structure afterwards.
- **Vocabulary**: reuse the interviewee's words for steps, documents, and roles. When a term is
  new or ambiguous, ask what it means and propose an entry for `landscape/glossary.yaml`
  (term, definition, synonyms) rather than substituting your own word.
- **Honesty**: never fill silence with invented steps. If the interviewee does not know what
  happens between two steps, that gap is the finding — mark it "(unconfirmed)", do not bridge
  it with a plausible-sounding activity. The played-back process must contain only what was
  actually said.
