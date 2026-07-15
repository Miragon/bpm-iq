# Security Policy

The Live Host is a security-sensitive server: it holds OAuth client secrets and GitHub App
private keys, mints installation tokens, and pushes to repositories as the signed-in user.
Take vulnerabilities in it seriously; we do.

## Reporting a vulnerability

**Do not open a public issue.** Report privately via either channel:

- GitHub Security Advisories on this repository ("Report a vulnerability")
- security@miragon.io

We confirm receipt within a few business days and work with you on a coordinated
disclosure — target: fix and disclosure within **90 days** of the report. We do not
currently run a bug bounty program.

## Scope — where to look

The areas we most want reports on:

- **Session store** — server-side sessions, cookie handling, session fixation/replay.
- **Token minting and storage** — installation-token minting, encryption at rest
  (`SESSION_ENC_KEY`), token leakage into logs or responses.
- **Webhook signature verification** — acceptance of unsigned or wrongly-signed provider
  webhooks.
- **`LIVE_DEV_TOKEN` semantics** — it creates a dev-only bot session and defaults to `demo`
  only when no git provider is configured; any path where it grants access alongside a
  configured provider, or in a way not obviously opt-in, is a finding.
- **Release/PR authorization path** — the per-(user,repo) permission checks that gate what a
  session can read, edit, and release. Any way to see or push to a repo without git write
  permission is the highest-severity class here.

## Supported versions

Pre-1.0: only the **latest minor** receives security fixes. Track
`ghcr.io/miragon/bpmiq-live-host:latest` or the newest `vX.Y.Z` tag.
