# Modeling Conventions

Conventions exist so that models are readable by humans _and_ parseable by agents.
The `process-review` skill enforces them; the `new-process` skill applies them when scaffolding.

## Naming

| Element                                 | Convention                          | Example                          |
| --------------------------------------- | ----------------------------------- | -------------------------------- |
| Process id / directory                  | kebab-case, noun phrase             | `order-to-cash`                  |
| Task                                    | Verb + object, imperative           | _Check credit limit_             |
| Event                                   | Object + past participle            | _Order received_, _Invoice sent_ |
| Exclusive gateway (split)               | Closed question                     | _Credit approved?_               |
| Outgoing sequence flows after a gateway | The answers                         | _yes_ / _no_                     |
| Pool                                    | Organization or system              | _ACME Corp_, _Customer_          |
| Lane                                    | Role or team, not a person          | _Order Management_, not _Alice_  |
| Sub-process / call activity             | Same as the referenced process name | _Invoice Handling_               |
| DMN decision                            | The gateway question it answers     | _Credit approved?_               |

**Vocabulary**: element names and metadata use the canonical `term` from
`landscape/glossary.yaml`; synonyms (including German terms people actually say) live only in
the glossary. A new domain noun in a model is a prompt to add a glossary entry.

## BPMN structure rules

1. **One start event per process** — if there are multiple triggers, model separate processes or
   use event-based gateways deliberately.
2. **One end event per distinct outcome**, named after the outcome (_Order fulfilled_,
   _Order rejected_). Never funnel success and failure into one unnamed end event.
3. **Gateways split _and_ join**: every splitting gateway has a matching joining gateway of the
   same type, unless flows end separately by design.
4. **Model the unhappy path.** Any activity that can fail in a business-relevant way gets a
   boundary event or an explicit exception flow. Exceptions listed in `process.yaml` →
   `exceptions` must appear in the model.
5. **Happy path flows left to right**, exceptions branch downward. No crossing sequence flows
   where layout can avoid it.
6. **7 ± 2 activities per diagram level.** More detail → extract a level-3 sub-process into
   `subprocesses/` and reference it via a call activity.
7. **Lanes reflect the team topology.** A lane name must equal a team label from the team
   topology model (or a role within a single team); every lane handoff is an interaction that
   should be justified there.
8. **Call activities resolve via metadata, not BPMN imports.** A `callActivity`'s
   `calledElement` holds the sub-process's process id and is resolved through
   `process.yaml` → `subprocesses[].id` — we deliberately do not use `<bpmn:import>`
   (bpmn.io-based editors ignore it; strict interchange validators may warn).
9. **No implicit semantics in colors or positions** — meaning lives in element types, names, and
   the metadata, never in styling.
10. **Business rules live in DMN, not in prose.** When a gateway's answer follows criteria
    (thresholds, scoring, tables), model them as a decision table in
    `processes/<id>/decisions/<decision-id>.dmn`, declare it in `process.yaml` → `decisions[]`
    with `used_by` pointing at the gateway (or `businessRuleTask`), and keep the gateway itself
    a pure routing question. The BPMN Modeler extension edits `.dmn` natively.
11. **Work instructions anchor to element ids.** Per-task instructions live in
    `docs/tasks/<bpmn-element-id>.md` so agents can serve the right instruction at the right
    step; `scripts/validate.ts` checks the ids resolve.
12. **Executable variants live next to the descriptive model** as `<id>.executable.bpmn`,
    declared in `process.yaml` → `automation:` — never overwrite the descriptive model
    (see docs/automation.md).

## Landscape models

- **Value chain**: steps are noun phrases in customer order (left → right). Each step has a
  stable kebab-case id used by `process.yaml` → `value_chain.steps[]`.
- **Wardley map**: components carry the same names referenced by `process.yaml` →
  `wardley.components`. Re-evaluate evolution stages when reviewing linked processes.
- **Team topology**: team ids are kebab-case and match `owner.team` / `participants.team`.
  Model interaction modes explicitly; a `process.yaml` participant interaction must not
  contradict the topology model.

## Versioning & change

- Bump `version` in `process.yaml` whenever the BPMN model changes semantically.
- Update `last_reviewed` only after a human confirmed the model matches reality.
- Redesigns: keep the `as-is` model, add the `to-be` model in the same directory, and record
  the migration decision in `docs/`.
