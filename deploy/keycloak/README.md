# Keycloak — the identity-provider quickstart

`realm-bpmiq.json` is imported by the `keycloak` compose profile
(`docker compose --profile keycloak up -d`, from `deploy/`): realm `bpmiq`, the public
PKCE clients `bpmiq-web` (browser login) and `bpmiq-mcp` (MCP clients), the `github_login`
claim from an admin-only user attribute, a fixed audience `bpmiq`, the GitHub identity
provider (disabled, bring your own OAuth App) and two demo users.

Walkthrough, production notes and what is verified:
[docs/on-prem/idp-quickstart.md](../../docs/on-prem/idp-quickstart.md).
