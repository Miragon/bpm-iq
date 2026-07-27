/**
 * OIDC resource-server verification — the Live Host's bearer-JWT auth for
 * headless clients (MCP, CI, editor plugins). The Live Host never runs an
 * authorization server of its own: a ready-made IdP (Keycloak, WorkOS, Auth0,
 * …) issues audience-bound JWTs; this module only VERIFIES them (signature via
 * the IdP's JWKS, issuer, audience) and maps the login claim to an identity.
 *
 * IDENTITY vs AUTHORIZATION: the JWT only says who you are. Whether that
 * identity may touch a repository stays with the git provider (AccessCache,
 * app-side installation check keyed on the login) — so the login claim MUST
 * carry the VERIFIED git-provider username (default claim: `github_login`,
 * populated by the IdP from its GitHub connection, never user-editable).
 *
 * FAIL CLOSED: a token without the configured login claim is refused — there
 * is deliberately NO fallback to `preferred_username`/`sub`. Those claims are
 * user-editable in many IdPs; falling back would let anyone who can rename
 * themselves at the IdP authorize as an arbitrary GitHub identity.
 *
 * The interactive browser-SSO login (authorize-redirect flow) is a separate,
 * still-open contribution seam — see docs/extending/sso.md.
 */
import { AppError } from "@bpmiq/http-kit";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

export interface OidcVerifierConfig {
  /** expected `iss` claim (the IdP) */
  issuer: string;
  /** the IdP's JWKS endpoint (explicit — no boot-time discovery fetch) */
  jwksUrl: string;
  /** expected `aud` claim — this Live Host's public URL (RFC 8707) */
  audience: string;
  /** JWT claim carrying the git-provider login (default `github_login`) */
  loginClaim: string;
  /** exact-match claims the token MUST carry (cell mode: installation_id ==
   * TENANT_INSTALLATION_ID). Needed because in the SaaS the audience is a shared
   * fleet value (WorkOS resource indicators are dashboard-only, no per-tenant
   * audiences) — so the tenant boundary is this claim, not `aud`. A token for
   * tenant A replayed at cell B fails here (the claim is IdP-injected from the
   * org membership, not client-influencable). Empty/absent → not enforced. */
  requiredClaims?: Record<string, string>;
}

export interface VerifiedIdentity {
  login: string;
  name: string;
  sub: string;
}

export type OidcVerify = (token: string) => Promise<VerifiedIdentity>;

export function makeOidcVerifier(cfg: OidcVerifierConfig): OidcVerify {
  // created ONCE — jose caches the fetched keys (incl. kid rotation) internally,
  // so per-request verification costs one signature check, no network
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  return async (token) => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: cfg.issuer, audience: cfg.audience }));
    } catch (e) {
      throw mapJoseError(e);
    }
    // tenant gate (cell mode): the token must belong to THIS tenant. Checked
    // before the login claim so a cross-tenant token is rejected as such.
    for (const [claim, expected] of Object.entries(cfg.requiredClaims ?? {})) {
      if (payload[claim] !== expected) {
        throw new AppError("auth/wrong-tenant", `token '${claim}' claim does not match this tenant`, {
          status: 401,
          expose: true,
        });
      }
    }
    const login = payload[cfg.loginClaim];
    if (typeof login !== "string" || login.length === 0) {
      throw new AppError(
        "auth/missing-claim",
        `token carries no '${cfg.loginClaim}' claim — configure the IdP to issue the git-provider login`,
        { status: 401, expose: true },
      );
    }
    const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : login;
    return { login, name, sub: typeof payload.sub === "string" ? payload.sub : login };
  };
}

/** distinct 401 codes for the actionable failures; everything else (bad
 *  signature, JWKS miss, malformed token) stays generic — verifier internals
 *  are not caller information */
function mapJoseError(e: unknown): AppError {
  if (e instanceof joseErrors.JWTExpired) {
    return new AppError("auth/token-expired", "bearer token expired", { status: 401, expose: true, cause: e });
  }
  if (e instanceof joseErrors.JWTClaimValidationFailed) {
    if (e.claim === "aud") {
      return new AppError("auth/wrong-audience", "token not issued for this resource", {
        status: 401,
        expose: true,
        cause: e,
      });
    }
    if (e.claim === "iss") {
      return new AppError("auth/wrong-issuer", "token not issued by the configured IdP", {
        status: 401,
        expose: true,
        cause: e,
      });
    }
  }
  return new AppError("auth/invalid-token", "invalid bearer token", { status: 401, expose: true, cause: e });
}
