# @bpmiq/validator

Deterministic validator for BPM content repositories: `process.yaml` schema conformance, link
integrity across processes, BPMN/DMN structural checks (including complete BPMNDI), governance
rules (versioning/approval), and export freshness. It treats the target repo as pure data —
it never executes content-repo code. Exit code 0 = no errors (warnings allowed), 1 = errors.

## Usage

```sh
# validate the content repo in the current directory
npx @bpmiq/validator --root .

# validate a single process
npx @bpmiq/validator --root . order-to-cash
```

`--root` points at any checkout that follows the content contract (`processes/`, `landscape/`).

## Part of bpm-iq

Source, content contract, and the example content repo live in
[Miragon/bpm-iq](https://github.com/Miragon/bpm-iq) — see
[docs/on-prem](https://github.com/Miragon/bpm-iq/tree/main/docs/on-prem) for running the
platform yourself.

## License

MIT
