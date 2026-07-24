# src/auth/ — identity-provider landing zone

Reserved for identity-provider modules: OIDC/SAML/WorkOS handshakes that
authenticate a PERSON and mint a session (`SessionStore.create(identity)` — the
grant is optional by design). First resident: `oidc.ts` — resource-server
verification of audience-bound bearer JWTs from a ready-made IdP, used by
`/mcp` and the REST content routes. It fails closed: the login claim (default
`github_login`) must carry the IdP-verified GitHub login — no
`preferred_username`/`sub` fallback — and the host only VERIFIES tokens, it
never runs its own authorization server (ADR 0005). Interactive login flows
(authorize redirect + callback) land beside it.

What does NOT belong here: git-provider authorization — the per-(user,repo)
grant lives in `../ports/` (`git-provider.ts`, `connection-source.ts`) and its
vendor implementations in `../adapters/<vendor>/`. Identity is who you are;
the git grant stays the entry ticket for what you may release.

Contribution guide: [docs/extending/sso.md](../../../../docs/extending/sso.md).
