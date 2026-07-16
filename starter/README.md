# bpmiq starter

The minimal starting point for a **bpmiq content repository** — the repo your
team's BPMN process models live in, served by the
[bpmiq platform](https://github.com/Miragon/bpm-iq) for live collaborative
modeling and release-as-PR.

## Layout

```
bpmiq.yml            the contract: names the folder your processes live in
processes/           your BPMN process models (one .bpmn file per process)
  example.bpmn
```

That is the whole contract. The platform reads `bpmiq.yml` at the repo root:

```yaml
processes: processes
```

- Every `.bpmn` file under that folder (subfolders included) is a **process**.
- A process's **id** is its file name without the extension
  (`processes/order-to-cash.bpmn` → `order-to-cash`) — keep file names unique
  and URL-friendly (kebab-case recommended).
- A repo **without** a `bpmiq.yml` is not a content repo — the platform will
  not list or serve it.

## Using it

1. Create a repo from this template and install the bpmiq GitHub App on it.
2. Open the repo in the bpmiq web app — every BPMN file appears as a process
   you can model on live, together.
3. **Release → PR** publishes the live state of a process as a reviewable
   pull request; merging it is the approval.

## What's next

This starter is deliberately small — it is the seed of the content-repo
contract, not its ceiling. Metadata, decision models, landscape views and
documentation conventions will grow back in as the contract evolves.
