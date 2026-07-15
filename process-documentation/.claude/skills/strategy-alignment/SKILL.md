---
name: strategy-alignment
description: Cross-view strategic analysis of the process landscape — finds automation and outsourcing candidates via the Wardley map, handoff friction and ownership gaps via the team topology, and coverage gaps via the value chain. Use when the user asks what to automate, outsource, or improve, where processes and strategy or org structure misalign, or when deciding where to invest improvement effort across the process portfolio.
---

# Strategy Alignment

Pure process documentation has no ROI. This skill produces the decisions the four views were
built for. Read all of: `landscape/value-chain.vc.json`, `landscape/wardley-map.owm`,
`landscape/team-topology.tt`, and every `processes/*/process.yaml` (open BPMN models when task
types matter).

## Analyses

### 1. Evolution vs. execution (Wardley × BPMN)

For each process, look up its `wardley.components` and their evolution stage
(<0.25 genesis, <0.5 custom, <0.75 product, ≥0.75 commodity):

- **Automation candidates**: `userTask`/manual work sitting on *commodity* components —
  standardized capability, manual execution. Quantify with the process's KPIs if present.
  Note: `wardley.components` links at process level, not per task — infer which tasks lean on
  which component from task names and the `systems` list, and state that inference in the finding.
- **Premature standardization**: rigid modeled flows on *genesis/custom* components — the
  capability is still evolving; heavy process control adds friction, not quality.
- **Build/buy mismatch**: components at *product* or *commodity* stage that the organization
  runs in-house (check process `systems`/docs), and components carrying a decided-but-unexecuted
  sourcing annotation like `(buy)` or `(outsource)` — surface each as an open sourcing decision.

### 2. Flow vs. org (Team Topologies × BPMN)

- **Handoff cost**: count lane transitions in each level-2 BPMN; a process crossing >2 teams is
  a fast-flow risk. Check whether each handoff has a matching interaction in the topology —
  an unmodeled interaction is invisible coordination cost (Conway mismatch).
- **Interaction-mode sanity**: repeated `collaboration` on the same boundary should evolve to
  `x-as-a-service`; a platform team appearing inside the value-adding flow (not as a service)
  is a smell.
- **Ownership gaps**: processes whose `owner.team` is missing, or teams owning no process while
  sitting in the flow of change.

### 3. Value coverage (Value chain × processes)

Respect `classification`: only `core` processes must anchor in `value_chain.steps`;
`support`/`management` processes anchor via `supports[]` instead.

- **Uncovered steps**: value chain steps with no core process referencing them — unmanaged or
  undocumented value creation.
- **Orphan processes**: `core` processes without `value_chain.steps`, and `support` processes
  whose `supports[]` targets no longer exist — no articulated reason to exist; candidates for
  merge or retirement. A support process is NOT an orphan just because it lacks value chain steps.
- **Overloaded steps**: steps referenced by many processes — fragmentation, consolidation
  candidate.

### 4. Quantification (operations × KPIs)

Rank findings with the numbers where they exist: `operations.volume` × `operations.cost`
approximates annual process cost; `exceptions[].frequency` × volume sizes the exception load;
`kpis[].actuals` vs. `target` shows which processes actually underperform. State `as_of` dates.
A finding backed by numbers outranks a purely structural one; when numbers are missing, say
"unquantified — add an `operations:` block to prioritize confidently" instead of guessing.

## Output format

Ranked findings, most valuable decision first:

```
## Strategic findings
1. <finding> — evidence: <files/ids> — recommended decision: <automate/outsource/merge/…>
   expected effect: <KPI or friction affected>
```

End with a short "healthy" list: what is well-aligned and should not be touched. Recommend
concrete next steps (e.g. "re-model to-be variant", "move component on the map after the
sourcing decision" — offer the `new-process` or `process-review` skill where it fits).

Ground every claim in a model element; if data is missing for an analysis (e.g. no KPIs), say
which and skip it rather than guessing.
