# @miragon/design-iq-validator

Deterministic validator for BPM content repositories: `designiq.yml` discovery, BPMN structural
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
npx @miragon/design-iq-validator --root .

# validate a single process
npx @miragon/design-iq-validator --root . order-to-cash
```

`--root` points at any checkout that follows the content contract (a root `designiq.yml` naming
the models folder — `models:`, legacy alias `processes:`). A repo that still carries the legacy
file name `bpmiq.yml` validates unchanged, plus one `[WARN]` that suggests the rename
(`git mv bpmiq.yml designiq.yml`); the exit code is not affected.

## Part of designIQ

Source, content contract, and the example content repo live in
[Miragon/design-iq](https://github.com/Miragon/design-iq) — see
[docs/on-prem](https://github.com/Miragon/design-iq/tree/main/docs/on-prem) for running the
platform yourself.

## License

MIT
