---
name: capture-process
description: Conversational process capture — interviews a process owner who cannot write BPMN, elicits trigger, outcome, happy path, decisions, handoffs, and exceptions one question at a time, plays the understood process back in plain language for correction, then hands the confirmed data to the new-process skill for scaffolding. Use when someone wants to talk through, describe, or explain how their process works, wants a process documented from an interview, says "let me tell you how we do X", or says they don't know BPMN.
---

# Capture Process

Turn a conversation with a process owner into structured input for `new-process`.
The interviewee knows the work; you know the modeling conventions. Never ask them
to think in BPMN or gateways — translate silently. The output is a BPMN model; the
process view (roles, steps, calls) is derived from it, so capture exactly what the
BPMN needs: trigger, steps, who does each, decisions, handoffs, sub-processes,
outcomes.

## Interview protocol

Work through the phases in order. Do not scaffold anything until phase 4 is confirmed.

### 1. Pin trigger and outcome

What starts the process, and what state is guaranteed at the end? These become the
**start event** and **end event(s)**. If the answer is vague ("it just kind of
starts"), offer concrete candidates ("an email arrives? a ticket is created?")
until it is pinned. Ask what the process delivers and for whom — this becomes the
process name (model it as the pool name).

### 2. Walk the happy path, one step at a time

"What happens first?" Then, for each step, probe before moving on:

- **Who does it?** — a role or team, not a person (→ **lanes**).
- **What kind of step?** — a person doing it (`userTask`), a system doing it
  (`serviceTask`), sending/receiving a message (`sendTask`/`receiveTask`).
- **What can go wrong here?** — collect for phase 3's exceptions; don't chase every
  branch now, or the happy path unravels.

Name each step internally as verb + object (*Check credit limit*) but keep speaking
the interviewee's words. Around 7 steps at this level is right; if a step explodes
into sub-steps, note it as a **sub-process candidate** (its own `.bpmn`, called via
`callActivity`) and pull back up.

### 3. Probe decisions, handoffs, exceptions

- **Decisions**: at every fork, get the **question** (a closed question — *Credit
  approved?*) and the **possible answers** (the labeled outgoing flows). If the rule
  is "experience" or "gut feeling", record that honestly.
- **Handoffs**: at every point a different team takes over, note the lane change —
  a flow crossing lanes is a handoff.
- **Exceptions**: revisit everything from phase 2's "what can go wrong" — how is
  each handled (boundary event / exception flow), how often?

### 4. Play back — "here is what I heard"

Present the entire understood process as a plain numbered list in the interviewee's
own vocabulary: trigger, steps with who, decisions with their answers, handoffs,
exceptions, outcome. Ask them to correct it: what is wrong, missing, over-simplified?
Fold in corrections and play back the changed parts. **Iterate until the owner
explicitly confirms.** Anything they hesitate on stays in the capture — marked, not
dropped.

### 5. Hand over to `new-process`

Only after confirmation, invoke `new-process` with the collected data: id candidate,
name, trigger, outcome(s), the step sequence with each step's role (→ lanes), the
decision points with their answers, the handoffs, and the sub-process candidates.
Mark every element the owner did not confirm with a BPMN `<textAnnotation>`
"(unconfirmed)" so the gap survives into the model. Suggest `process-review` once
the BPMN has substance, and a follow-up session with the owner in front of the
rendered diagram.

## Conduct

- **Pacing**: one question at a time. Never post a wall of questions. Let stories
  run; extract the structure afterwards.
- **Vocabulary**: reuse the interviewee's words for steps, documents, and roles.
- **Honesty**: never fill silence with invented steps. If the interviewee does not
  know what happens between two steps, that gap is the finding — mark it, do not
  bridge it with a plausible-sounding activity.
