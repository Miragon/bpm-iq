# @bpmiq/validator

Deterministic validator for BPM content repositories: `bpmiq.yml` discovery, BPMN structural
checks (flow soundness, complete BPMNDI coverage), and `callActivity` link integrity (a
`calledElement` should resolve to a process in the repo). It treats the target repo as pure
data — it never executes content-repo code. Exit code 0 = no errors (warnings allowed), 1 = errors.

## Usage

```sh
# validate the content repo in the current directory
npx @bpmiq/validator --root .

# validate a single process
npx @bpmiq/validator --root . order-to-cash
```

`--root` points at any checkout that follows the content contract (a root `bpmiq.yml` naming
the BPMN processes folder).

## Part of bpm-iq

Source, content contract, and the example content repo live in
[Miragon/bpm-iq](https://github.com/Miragon/bpm-iq) — see
[docs/on-prem](https://github.com/Miragon/bpm-iq/tree/main/docs/on-prem) for running the
platform yourself.

## License

MIT
