# Contributing to bpmiq

**There is no build step.** This repo runs raw TypeScript on Node >= 23.6 via type
stripping; `pnpm typecheck` is the only type gate. Backends and packages execute their
`.ts` sources directly — the only things that bundle are the SPAs and the VS Code
extension (`pnpm build`).

## Toolchain

**pnpm only.** `pnpm install`, `pnpm --filter <pkg> …` — never `npm`/`yarn`. The
`preinstall` hook (`only-allow pnpm`) enforces this; if install fails immediately, you used
the wrong package manager.

## Dev setup

```bash
pnpm install
pnpm live-host      # platform server: sync + API + web app on http://localhost:8301
pnpm web:dev        # web client with hot reload (proxies to the Live Host)
pnpm portal:dev     # VitePress content portal, renders all models live
```

## Local gates (mirror CI, run in this order)

```bash
pnpm lint           # eslint
pnpm arch           # dependency-cruiser — architecture boundaries (ADR 0003)
pnpm format:check   # prettier
pnpm typecheck      # the type gate — there is no compile step to catch you later
pnpm validate       # content validation of process-documentation/
pnpm test           # workspace tests
pnpm build          # SPAs + extension bundle
```

A PR is expected green on all seven. If you edit **content** — anything under
`process-documentation/` (models, `process.yaml`, landscape files) — `pnpm validate` must
pass before you finish; broken references are hard rule 1 in `CLAUDE.md`.

## Architecture rules (ADR 0003)

`domain/` is pure. `application/` never imports adapter implementations — they are injected
against `ports/`. A new vendor (GitLab, Jira, …) is a new `adapters/<vendor>/` folder
against the existing ports, never a change to a use-case. `pnpm arch` enforces all of this;
the grandfather list in `.dependency-cruiser.mjs` shrinks monotonically — the PR that moves
a module deletes its exception, and no PR adds one.

Contributing a connector? Start at [docs/extending/connectors.md](docs/extending/connectors.md).

## Commits and PRs

- **Sign-off, not CLA**: we use the [DCO](https://developercertificate.org/). Sign every
  commit with `git commit -s`.
- Keep PRs small and single-purpose — one connector, one fix, one refactor. Large PRs that
  mix concerns will be asked to split.
- Green gate before review: run the local gates above; CI runs the same list.
