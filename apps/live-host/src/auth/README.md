# src/auth/ — identity-provider landing zone

Reserved for identity-provider modules: OIDC/SAML/WorkOS handshakes that
authenticate a PERSON and mint a session (`SessionStore.create(identity)` — the
grant is optional by design). Empty today, on purpose.

What does NOT belong here: git-provider authorization — the per-(user,repo)
grant lives in `../ports/` (`git-provider.ts`, `connection-source.ts`) and its
vendor implementations in `../adapters/<vendor>/`. Identity is who you are;
the git grant stays the entry ticket for what you may release.

Contribution guide: [docs/extending/sso.md](../../../../docs/extending/sso.md).
