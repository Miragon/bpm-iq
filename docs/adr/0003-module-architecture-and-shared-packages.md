# ADR 0003 — Module architecture: hexagonal backends, shared packages, architecture tests

Status: **accepted** (2026-07-15) · Scope: monorepo structure (both backends, both SPAs, packages/)

## Context

Before this restructuring, each backend was organized around one god file
(`control-plane/server.ts` at 755 LOC: wiring + router + reconciler + fleet upgrade + fanout;
`live-host` with persistence logic inside the Hocuspocus hooks of the composition root). HTTP
plumbing, GitHub REST, OAuth state and timing-safe compares existed as copies in both apps —
with two proven drift bugs (rawBody buffering, state-secret lifecycle). The two React SPAs
shared the same stack via copy-paste; API shapes were hand-copied (two types had actually drifted).

Strategic driver: **swappable connectors** (GitHub today; GitLab, Jira, … planned).

## Decision

### 1. One hexagonal structure in both backend apps

```
src/
  domain/       pure business logic — no I/O builtins, no npm, no fetch
  ports/        interfaces (+ pure helpers/fakes) — the contracts connectors fulfill
  application/  use-cases: orchestrate domain + ports; NEVER import adapter impls
                (type-only is fine) — adapter functions are INJECTED by server.ts
  adapters/     one folder per technology/vendor: github/ git/ fly/ sqlite/ cells/
  http/         driving adapter: router (createXxx(deps)) + static/SPA serving
  server.ts     composition root — the ONLY place that reads env and constructs adapters
```

**Connector rule:** a new connector = a new folder under `adapters/<vendor>/` against the
existing ports (`ports/git-provider.ts` + `ports/connection-source.ts` in the live-host,
`ports/provisioner.ts` in the control-plane) — zero changes to `domain/`/`application/`. If a
connector ships standalone, it is extracted as `@bpmiq/connector-<vendor>` against the same
ports (follow-up ADR then).

Deliberately NOT: DI container (hand-wiring in server.ts), generic repository/DB ports (the
stores in `adapters/sqlite/` ARE the adapters; `:memory:` is the test fake), barrel index.ts,
a shared router framework; outcome objects (`DriveResult` etc.) stay data instead of exceptions.

### 2. Shared packages (anti-drift, all raw `.ts`, no build step)

| Package                | Contents                                                                                                 | Consumers                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@bpmiq/cell-protocol` | derived secrets + handoff codec (unchanged; stays dependency-free/copy-portable)                         | both backends                             |
| `@bpmiq/http-kit`      | send/redirect/readBody/securityHeaders/cookie/HMAC primitives + `AppError`/`errorBody`                   | both backends                             |
| `@bpmiq/github-app`    | appJwt/loadPrivateKey + appRest/mint/paginate + `./oauth` (User-Agent parameterized per app)             | both backends                             |
| `@bpmiq/contracts`     | backend↔frontend wire types + `live.ts` (`CONTENT_KEY`, `roomName()`)                                    | backends + SPAs + live-client + vscode    |
| `@bpmiq/ui-kit`        | shadcn primitives, `cn()`, `theme.css` (Tailwind v4 `@source` pattern)                                   | both SPAs                                 |
| `@bpmiq/api-client`    | `ApiError`, `api<T>()`, `queryDefaults`                                                                  | both SPAs                                 |
| `@bpmiq/live-client`   | `openLiveSession()` + minimal-diff writer + bpmn-sync — the ONE implementation of live-document behavior | web, vscode, guest-test — **never cp-ui** |

**Type-contract pattern:** plain interfaces + `satisfies` at the assembly sites (the
cell-protocol pattern). No zod (the CP image is install-free), no OpenAPI/ts-rest. Drift = tsc error.

Deliberately NOT shared: session/cookie POLICY (two security models), webhook flows, the two
OAuth _flows_ (only the GitHub client), the SPAs' app shells/routers (separate trust domains).

_Amended by [ADR 0004](0004-open-source-split.md): the control-plane ↔ operator-SPA wire types
moved out of `@bpmiq/contracts` into the private `@bpmiq/cp-contracts`._

### 3. Architecture tests as a CI gate

`.dependency-cruiser.mjs` (`pnpm arch`, part of the deploy and validate gates): topology
(no app→app, no package→app, SPAs never import backend src), control-plane minimalism (never
yjs/hocuspocus/bpmn-js/monaco/notations/validator/live-client; no third-party runtime deps),
cp-ui-stays-light, I/O discipline (child_process/sqlite only in designated adapters), hexagonal
folder rules (domain pure; application without adapter impls; no cross-vendor; type-only imports
are legal everywhere — `verbatimModuleSyntax` makes the classification exact). ESLint covers what
a dependency graph cannot see: `process.env` outside the composition roots (warn ratchet),
`fetch` in domain/ports (error). **Rule lifecycle: the PR that moves a module deletes its
grandfather exception.**

## Consequences

- Connector extension is an additive, arch-enforced path; the historically riskiest logic
  (Yjs lineage restore-vs-seed, migration) is unit-tested for the first time; shape drift and
  plumbing drift are structurally impossible instead of review discipline.
- More packages/files; Docker images must COPY new packages (checklist: manifest layer of both
  Dockerfiles + the CP symlink block); shared packages lightly couple the two backends' deploys
  (accepted: zero-dep, unit-tested, both e2e suites gate every change).

Implementation: 12 individually shipped, behavior-preserving PRs (23ce18c…ba4f41c), each under
the full gate (lint, arch, format, typecheck, `pnpm -r test` incl. both offline e2e suites,
build) — plus two real bugs fixed along the way (CP rawBody buffering; LH OAuth state now
survives deploys) and the vscode socket leak + full-replace writes.
