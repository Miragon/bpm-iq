# @bpmiq/validator

Deterministic validator for BPM content repositories: `bpmiq.yml` discovery, BPMN structural
checks (flow soundness, complete BPMNDI coverage), the generic cross-model reference rule
(every required reference — `callActivity` calls, `businessRuleTask` decides — must resolve
in the repo), and a per-mediaKind parse baseline for every other registered notation (a
broken `.tt`/`.vc.json` is an ERROR; DSL notations are lenient by design). Every finding
carries a stable `ruleId` (e.g. `bpmn/flow`, `dmn/di`, `refs/dangling`). It treats the
target repo as pure data — it never executes content-repo code. Exit code 0 = no errors
(warnings allowed), 1 = errors.

## Usage

```sh
# validate the content repo in the current directory
npx @bpmiq/validator --root .

# validate a single process
npx @bpmiq/validator --root . order-to-cash
```

`--root` points at any checkout that follows the content contract (a root `bpmiq.yml` naming
the models folder — `models:`, legacy alias `processes:`).

## Part of bpm-iq

Source, content contract, and the example content repo live in
[Miragon/bpm-iq](https://github.com/Miragon/bpm-iq) — see
[docs/on-prem](https://github.com/Miragon/bpm-iq/tree/main/docs/on-prem) for running the
platform yourself.

## License

MIT
