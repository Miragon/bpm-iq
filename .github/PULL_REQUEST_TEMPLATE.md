## What changed & why

<!-- One or two sentences. Link the feedback entry (feedback/<id>/) if this PR resolves one. -->

## Checklist

<!-- Delete lines that don't apply. Merge approval = release. -->

- [ ] `pnpm validate` passes with 0 errors
- [ ] BPMN edits keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync — every flow node,
      lane, pool and edge has a `bpmndi:` shape (or the visual editor breaks)
- [ ] Modeling conventions followed (tasks verb+object, events object+past participle,
      gateways as questions, lanes = team/role labels)
- [ ] Any `callActivity` `calledElement` resolves to a process in the repo (its `.bpmn` stem)
- [ ] Affected exports re-run via `export-process-skill` (`dist/skills/<id>`), if any exist
