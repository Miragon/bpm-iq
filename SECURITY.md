# Security Policy

The Live Host is a security-sensitive server: it holds a GitHub App private key, mints
installation tokens, and pushes to repositories on behalf of the signed-in person. Take
vulnerabilities in it seriously; we do.

## Reporting a vulnerability

**Do not open a public issue.** Report privately via either channel:

- GitHub Security Advisories on this repository ("Report a vulnerability")
- security@miragon.io

We confirm receipt within a few business days and work with you on a coordinated
disclosure — target: fix and disclosure within **90 days** of the report. We do not
currently run a bug bounty program.

## Scope — where to look

The areas we most want reports on:

- **Login and sessions** — the OIDC login (code + PKCE, browser-bound state, the
  resource-server verification of access tokens: issuer, audience, signature, and the
  fail-closed login claim `github_login`), server-side identity-only sessions, cookie
  handling, session fixation/replay. Any way to obtain a session for a git-provider
  identity the IdP did not verify is a finding.
- **Token minting and storage** — installation-token minting and the encrypted token cache
  (`CELL_TOKEN_KEY`), token leakage into logs or responses. No user credential is stored
  anywhere ([ADR 0001](docs/adr/0001-zero-stored-user-tokens.md),
  [ADR 0007](docs/adr/0007-idp-only-login-and-no-auth-mode.md)); `SESSION_ENC_KEY` only
  keys the login-state HMAC.
- **Webhook signature verification** — acceptance of unsigned or wrongly-signed provider
  webhooks.
- **`LIVE_AUTH=none` boundaries** — the declared absence of authentication: every request is
  the local principal, meant for a developer's machine or a trusted network. It must be
  explicit (never inferred from missing configuration), and a browser page from another
  site must not become that principal (cross-site gate). Any path that opens a none-mode
  host to the web, or an authenticated host to nobody, is a finding.
- **Release/PR authorization path** — the per-(user,repo) permission checks that gate what a
  session can read, edit, and release. Any way to see or push to a repo without git write
  permission is the highest-severity class here.

## Supported versions

Pre-1.0: only the **latest minor** receives security fixes. Track
`ghcr.io/miragon/bpmiq-live-host:latest` or the newest `vX.Y.Z` tag.
