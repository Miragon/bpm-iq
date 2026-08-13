# @bpmiq/decisions

Simulation, analysis and tests for DMN decisions — the server-side half of the dmn-js
simulation add-on the modeler widget runs in the browser.

Same engine on both sides ([`@emaarco/dmn-js-simulation`](https://github.com/emaarco/dmn-js-simulation),
FEEL via [`feelin`](https://github.com/nikku/feelin)), so a scenario a human clicks in the
modeler and one an agent simulates through the MCP endpoint cannot drift apart. The DMN
itself is parsed exactly once, by the notation registry (`@bpmiq/notations`), never here.

```ts
import { analyzeDecision, simulateDecision } from "@bpmiq/decisions";
import { runDecisionTests, parseTestSuite } from "@bpmiq/decisions/tests";
```

| Function             | What it answers                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `simulateDecision`   | Given these values, which rules fire and what comes out? (whole DRD, in dependency order)  |
| `analyzeDecision`    | What is wrong with this decision without any test data — and what values would a test use? |
| `runDecisionTests`   | Do the stored cases still hold, and which rules does no case ever exercise?                |
| `recordExpectations` | Freeze what the decision does today (golden master) for cases that carry no expectation.   |

## Why analysis exists

Every FEEL engine treats a broken expression as "did not match". A typo in a rule is
therefore indistinguishable from a rule that legitimately did not apply — the model looks
fine and quietly decides nothing. `analyzeDecision` is the only place that tells the two
apart. It also reports what the engine cannot: rules that can never be reported under the
hit policy, requirements whose result variable nothing reads, cycles.

Findings are conservative by design. Rule shadowing, for instance, is only reported when
one entry literally subsumes another (`-`, or an identical test) — never for ranges that
would need interval arithmetic, because a false "unreachable" is worse than a missed one.

## Test cases

A decision's cases live next to it as `<decision>.tests.yaml` — an ordinary, reviewable
repo file that ships in the same release PR as the model:

```yaml
decision: credit-limit-check
cases:
  - name: A blocked customer is rejected even for a tiny, clean order
    given: { customerSegment: blocked, orderValue: 50, overdueInvoices: 0 }
    expect:
      value: reject
      rules: [Rule_blocked_customer] # WHICH rule produced it
```

`expect.rules` is what makes a case more than an output check: a right answer produced by
the wrong rule still fails. A case without `expect` is legal — it reports as `pending`
with the value it currently produces, and `recordExpectations` freezes exactly that.

Coverage counts the rules the hit policy actually **reported**, not the ones that merely
matched: under `FIRST` a shadowed rule can match in every case without ever deciding
anything.

## CLI

```sh
node packages/decisions/cli.ts --root <checkout> [<decision-id>]
```

Analyses every `.dmn` in a content repo and runs its cases; exit code 1 on an error or a
failing case. `pnpm validate` runs it after the platform validator (which owns the
mechanical invariants: XML, DMNDI coverage, requirement integrity).

## Free variables

Most real decision tables are written without modelled `InputData`: a column simply reads
`kundentyp` and nothing declares it. Those free variables are discovered through the FEEL
engine itself (evaluating against an empty context reports every unresolved name) and fed
in as synthetic inputs, so such a table simulates exactly like a fully modelled DRD — and
`decisionVariables()` doubles as the list a test case has to fill in.
