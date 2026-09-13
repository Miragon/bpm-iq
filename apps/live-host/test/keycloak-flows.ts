/**
 * Keycloak E2E helpers (test/keycloak-e2e.sh): drive the two OAuth flows a
 * browser / an MCP client would run, without a browser.
 *
 *   login <host> <user> <pass>
 *       the Live Host's own /auth/oidc round-trip: start → Keycloak's login
 *       form → callback → session cookie. Prints the session id.
 *   token <issuer> <clientId> <redirectUri> <user> <pass>
 *       a code+PKCE flow straight against Keycloak on a pre-registered public
 *       client (what Claude Code runs with --client-id/--callback-port); the
 *       redirect is read off the 302, nothing listens. Prints the access token.
 *
 * Failures throw with the stage that failed; the shell script turns that into
 * a FAIL line.
 */
import { createHash, randomBytes } from "node:crypto";

/** a minimal cookie jar (names only — every cookie here belongs to one origin) */
class Jar {
  private readonly cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const nv = c.split(";")[0] ?? "";
      const i = nv.indexOf("=");
      const name = nv.slice(0, i);
      const value = nv.slice(i + 1);
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

/** submit Keycloak's login page for an authorize URL; returns the redirect back to the client */
async function keycloakLogin(authorizeUrl: string, user: string, pass: string): Promise<string> {
  const kc = new Jar();
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  kc.absorb(page);
  if (page.status !== 200) throw new Error(`authorize → HTTP ${page.status} (expected Keycloak's login page)`);
  const html = await page.text();
  const form = html.match(/<form[^>]*kc-form-login[^>]*>/)?.[0];
  const action = form?.match(/action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!action) throw new Error("no kc-form-login form on Keycloak's page");
  const submit = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: kc.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: pass, credentialId: "" }).toString(),
  });
  if (submit.status !== 302) {
    throw new Error(`login POST → HTTP ${submit.status}: ${(await submit.text()).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return submit.headers.get("location") ?? "";
}

async function hostLogin(host: string, user: string, pass: string): Promise<void> {
  const jar = new Jar();
  const start = await fetch(`${host}/auth/oidc`, { redirect: "manual" });
  jar.absorb(start);
  if (start.status !== 302) throw new Error(`/auth/oidc → HTTP ${start.status}`);
  const back = await keycloakLogin(start.headers.get("location") ?? "", user, pass);
  if (!back.startsWith(`${host}/auth/oidc/callback`)) throw new Error(`Keycloak redirected to ${back}`);
  const cb = await fetch(back, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.absorb(cb);
  if (cb.status !== 302 || cb.headers.get("location") !== "/") {
    throw new Error(`callback → HTTP ${cb.status} ${(await cb.text()).slice(0, 300)}`);
  }
  const sid = jar.get("bpm_live_sid");
  if (!sid) throw new Error("no bpm_live_sid cookie after the callback");
  process.stdout.write(sid);
}

async function mcpToken(
  issuer: string,
  clientId: string,
  redirectUri: string,
  user: string,
  pass: string,
): Promise<void> {
  const disc = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
  };
  const verifier = randomBytes(32).toString("base64url");
  const u = new URL(disc.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", randomBytes(12).toString("base64url"));
  u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  u.searchParams.set("code_challenge_method", "S256");
  const back = await keycloakLogin(u.toString(), user, pass);
  if (!back.startsWith(redirectUri)) throw new Error(`Keycloak redirected to ${back}`);
  const code = new URL(back).searchParams.get("code");
  if (!code) throw new Error("no code on the redirect");
  const tok = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const grant = (await tok.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!grant.access_token) throw new Error(`token endpoint: ${grant.error} ${grant.error_description ?? ""}`);
  process.stdout.write(grant.access_token);
}

const [, , cmd, ...args] = process.argv;
try {
  if (cmd === "login" && args.length === 3) await hostLogin(args[0]!, args[1]!, args[2]!);
  else if (cmd === "token" && args.length === 5) await mcpToken(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
  else throw new Error("usage: login <host> <user> <pass> | token <issuer> <clientId> <redirectUri> <user> <pass>");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
