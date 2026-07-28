/**
 * Interactive browser OIDC login (authorization-code + PKCE) — the second
 * resident of the auth/ landing zone (docs/extending/sso.md), next to the
 * bearer-JWT resource server (oidc.ts). Vendor-neutral by construction: no
 * provider SDK, only the standard endpoints — Keycloak, Entra ID, WorkOS
 * AuthKit and any other OIDC-conformant IdP are pure configuration.
 *
 * This module owns the OAuth mechanics ONLY (authorize URL, code→token
 * exchange, endpoint discovery). What comes back is an ACCESS TOKEN that the
 * existing resource-server verifier (auth/oidc.ts) validates exactly like an
 * MCP bearer — same issuer/audience/login-claim contract, same fail-closed
 * rules, same cell-mode tenant gate. One identity contract, two entrances.
 *
 * PKCE is ALWAYS on (RFC 7636 — required for public clients, recommended for
 * confidential ones). A client secret is optional: absent → public client
 * (WorkOS AuthKit, Keycloak public clients); present → sent in the token
 * request body (client_secret_post — the broadly supported variant).
 *
 * Endpoints come from OIDC discovery (`<issuer>/.well-known/openid-configuration`),
 * fetched lazily on first login and cached; explicit URL overrides win
 * (air-gapped deployments where the issuer URL isn't reachable from the host).
 */
import { AppError } from "@bpmiq/http-kit";

export interface OidcLoginConfig {
  /** the IdP (same issuer the resource-server verifier is configured with) */
  issuer: string;
  clientId: string;
  /** absent → public client + PKCE only */
  clientSecret?: string;
  /** explicit endpoint overrides — skip discovery entirely when both are set */
  authorizeUrl?: string;
  tokenUrl?: string;
  /** login-button label in the web client (default "SSO") */
  label?: string;
  /** authorize scope (default "openid profile email") */
  scope?: string;
}

export interface OidcLogin {
  label: string;
  /** the IdP authorize URL for a browser redirect (discovery-lazy) */
  authorizeUrl(redirectUri: string, state: string, codeChallenge: string): Promise<string>;
  /** redeem the callback code for the access token (server-side) */
  exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string }>;
}

export function makeOidcLogin(cfg: OidcLoginConfig): OidcLogin {
  const issuer = cfg.issuer.replace(/\/+$/, "");
  let endpoints: Promise<{ authorize: string; token: string }> | undefined;

  /** discovery, once — a failed fetch resets the cache so the next login retries */
  const resolveEndpoints = (): Promise<{ authorize: string; token: string }> => {
    if (cfg.authorizeUrl && cfg.tokenUrl) return Promise.resolve({ authorize: cfg.authorizeUrl, token: cfg.tokenUrl });
    endpoints ??= (async () => {
      const url = `${issuer}/.well-known/openid-configuration`;
      let doc: { authorization_endpoint?: string; token_endpoint?: string };
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = (await res.json()) as typeof doc;
      } catch (e) {
        throw new AppError(
          "auth/idp-discovery-failed",
          `OIDC discovery at ${url} failed — set LIVE_OIDC_AUTHORIZE_URL + LIVE_OIDC_TOKEN_URL explicitly if the issuer is not reachable`,
          {
            status: 502,
            expose: true,
            cause: e,
          },
        );
      }
      const authorize = cfg.authorizeUrl ?? doc.authorization_endpoint;
      const token = cfg.tokenUrl ?? doc.token_endpoint;
      if (!authorize || !token) {
        throw new AppError(
          "auth/idp-discovery-failed",
          `the IdP's discovery document carries no authorization/token endpoint`,
          {
            status: 502,
            expose: true,
          },
        );
      }
      return { authorize, token };
    })();
    return endpoints.catch((e) => {
      endpoints = undefined; // never cache a failure
      throw e;
    });
  };

  return {
    label: cfg.label ?? "SSO",

    async authorizeUrl(redirectUri, state, codeChallenge) {
      const { authorize } = await resolveEndpoints();
      const u = new URL(authorize);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", cfg.scope ?? "openid profile email");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchangeCode(code, redirectUri, codeVerifier) {
      const { token } = await resolveEndpoints();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cfg.clientId,
        code_verifier: codeVerifier,
      });
      if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
      const res = await fetch(token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      });
      if (!res.ok) {
        // a reloaded callback (used code) or an expired code lands here — a
        // user-facing 401 with a fresh-login hint, never a raw 500. The IdP's
        // error detail goes to the log only (may echo request internals).
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        console.log(`oidc login: code exchange → ${res.status}: ${detail}`);
        throw new AppError("auth/code-exchange-failed", "sign-in could not be completed — try again", {
          status: 401,
          expose: true,
        });
      }
      const grant = (await res.json()) as { access_token?: string };
      if (!grant.access_token) {
        throw new AppError("auth/code-exchange-failed", "the IdP's token response carries no access_token", {
          status: 401,
          expose: true,
        });
      }
      return { accessToken: grant.access_token };
    },
  };
}
