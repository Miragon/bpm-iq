# Keycloak — the identity-provider quickstart

`realm-designiq.json` is imported by the `keycloak` compose profile
(`docker compose --profile keycloak up -d`, from `deploy/`): realm `bpmiq`, the public
PKCE clients `designiq-web` (browser login) and `designiq-mcp` (MCP clients), the `github_login`
claim from an admin-only user attribute, a fixed audience `bpmiq`, the GitHub identity
provider (disabled, bring your own OAuth App) and two demo users.

Walkthrough, production notes and what is verified:
[docs/on-prem/idp-quickstart.md](../../docs/on-prem/idp-quickstart.md).
