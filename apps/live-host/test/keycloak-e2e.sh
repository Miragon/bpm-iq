#!/bin/bash
# Keycloak IdP quickstart — verified end to end (the exit criterion of ADR 0007
# step 3). Needs Docker. Boots the quickstart realm (deploy/keycloak/realm-bpmiq.json
# through the compose `keycloak` profile), a GitHub stub and a fresh Live Host
# in LIVE_AUTH=oidc on http://localhost:8301, then proves:
#   K1  oidc mode refuses to start without the IdP (naming the variables);
#       up, it offers exactly the Keycloak login and answers 401 to anonymous
#   K2  browser login: /auth/oidc → Keycloak's login form → callback → session
#       cookie; /api/me = petra (oidc); the overview shows the writable repo
#   K3  MCP bearer: a code+PKCE flow on the bpmiq-mcp client (what Claude Code
#       runs) → /api/me by bearer, /mcp initialize answers
#   K4  a release on that identity: create a process → release → PR at the
#       stub, the human (IdP name) as git author
#   K5  fail closed: a token without github_login (user "nobody") is refused
#       at /api/me, at /mcp and at the browser login's callback
#
# Run: bash test/keycloak-e2e.sh   (not part of `pnpm test` — needs Docker;
# ports 8080, 8301 and 8399 must be free)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
FIXTURE="$REPO_ROOT/packages/validator/test/fixtures/content-repo"
E2E="$(mktemp -d "${TMPDIR:-/tmp}/bpm-keycloak-e2e.XXXXXX")"
COMPOSE=(docker compose -p bpmiq-keycloak-e2e -f "$REPO_ROOT/deploy/docker-compose.yml" --profile keycloak)
ISSUER="http://localhost:8080/realms/bpmiq"
HOST="http://localhost:8301"
STUB_PORT=8399
PASS=0; FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$E2E"
}
trap cleanup EXIT

for port in 8080 8301 "$STUB_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://localhost:$port/"; then
    echo "port $port is busy — stop what listens there first"; exit 2
  fi
done

# ── Keycloak with the quickstart realm (the compose profile, as documented) ──
"${COMPOSE[@]}" up -d keycloak >"$E2E/compose.log" 2>&1 || { cat "$E2E/compose.log"; exit 2; }
curl -sf --retry 60 --retry-delay 2 --retry-all-errors -o /dev/null "$ISSUER/.well-known/openid-configuration" \
  || { echo "Keycloak did not come up:"; docker logs bpmiq-keycloak-e2e-keycloak-1 2>&1 | tail -20; exit 2; }
ok "K0: Keycloak up, realm bpmiq imported (discovery answers)"

# ── GitHub stub + one content repo, exactly like release-e2e.sh ──────────────
openssl genrsa -out "$E2E/app.pem" 2048 2>/dev/null
mkdir -p "$E2E/origin/acme" "$E2E/empty" "$E2E/data"
SRC="$E2E/src"; cp -R "$FIXTURE" "$SRC"; printf 'processes: processes\n' > "$SRC/bpmiq.yml"
git -C "$SRC" init -q -b main && git -C "$SRC" add -A
git -C "$SRC" -c user.name=e2e -c user.email=e2e@test commit -qm "content"
git clone -q --bare "$SRC" "$E2E/origin/acme/bpm-processes.git"
STUB_PORT="$STUB_PORT" node "$HERE/stub-provider.ts" >"$E2E/stub.log" 2>&1 &
PIDS+=($!)
curl -sf --retry 20 --retry-delay 1 --retry-all-errors -o /dev/null "http://localhost:$STUB_PORT/app"
curl -s -X POST -d '{"repos":["acme/bpm-processes"]}' "http://localhost:$STUB_PORT/_control" >/dev/null

# the quickstart's Live Host environment (docs/on-prem/idp-quickstart.md) plus the stub wiring
host() {
  env PORT=8301 LIVE_PUBLIC_URL="$HOST" LIVE_DATA_DIR="$E2E/data" \
    GITHUB_REPO=acme/bpm-processes LIVE_HOST_CONTENT_DIR="$E2E/empty" \
    GITHUB_BASE_URL="http://localhost:$STUB_PORT" GITHUB_API_URL="http://localhost:$STUB_PORT" \
    GITHUB_APP_ID=4711 GITHUB_APP_PRIVATE_KEY_FILE="$E2E/app.pem" GITHUB_APP_SLUG=bpm-live-stub \
    LIVE_GIT_URL_OVERRIDE="file://$E2E/origin" LIVE_PUSH_URL_OVERRIDE="file://$E2E/origin/acme/bpm-processes.git" \
    "$@" node "$REPO_ROOT/apps/live-host/src/server.ts"
}
OIDC=(LIVE_AUTH=oidc LIVE_OIDC_ISSUER="$ISSUER" LIVE_OIDC_JWKS_URL="$ISSUER/protocol/openid-connect/certs"
      LIVE_OIDC_AUDIENCE=bpmiq LIVE_OIDC_CLIENT_ID=bpmiq-web LIVE_OIDC_LOGIN_LABEL=Keycloak)

# ═══ K1: prerequisites ═══
host LIVE_AUTH=oidc >"$E2E/host-noidp.log" 2>&1
grep -q 'LIVE_AUTH=oidc needs LIVE_OIDC_ISSUER' "$E2E/host-noidp.log" \
  && ok "K1: oidc mode without an IdP refuses to start, naming the variables" \
  || bad "K1: expected the prerequisite error, got: $(tail -3 "$E2E/host-noidp.log")"

host "${OIDC[@]}" >"$E2E/host.log" 2>&1 &
PIDS+=($!)
curl -sf --retry 30 --retry-delay 1 --retry-all-errors -o /dev/null "$HOST/healthz" \
  || { echo "the Live Host did not come up:"; tail -20 "$E2E/host.log"; exit 2; }
CFG=$(curl -s "$HOST/api/config")
echo "$CFG" | grep -q '"auth": *"oidc"' && echo "$CFG" | grep -q '"id": *"oidc", *"label": *"Keycloak"' \
  && ok "K1b: /api/config offers the Keycloak login and nothing else" || bad "K1b: unexpected config: $CFG"
ANON=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/api/me")
[ "$ANON" = 401 ] && ok "K1c: anonymous is 401" || bad "K1c: anonymous → $ANON"

# ═══ K2: browser login ═══
if SID=$(node "$HERE/keycloak-flows.ts" login "$HOST" petra petra 2>&1); then
  ok "K2: /auth/oidc → Keycloak login form → callback → session cookie"
else
  bad "K2: browser login failed: $SID"; SID=""
fi
ME=$(curl -s -H "cookie: bpm_live_sid=$SID" "$HOST/api/me")
echo "$ME" | grep -q '"login": *"petra"' && echo "$ME" | grep -q '"provider": *"oidc"' \
  && ok "K2b: /api/me = petra via oidc" || bad "K2b: $ME"
REPOS=$(curl -s -H "cookie: bpm_live_sid=$SID" "$HOST/api/repos")
echo "$REPOS" | grep -q '"fullName": *"acme/bpm-processes"' && echo "$REPOS" | grep -q '"permission": *"write"' \
  && ok "K2c: the overview shows the writable repo (app-side permission check)" || bad "K2c: $REPOS"

# ═══ K3: MCP bearer ═══
if TOKEN=$(node "$HERE/keycloak-flows.ts" token "$ISSUER" bpmiq-mcp http://localhost:8765/callback petra petra 2>&1); then
  ok "K3: code+PKCE on the bpmiq-mcp client yields an access token"
else
  bad "K3: $TOKEN"; TOKEN=""
fi
MEB=$(curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/me")
echo "$MEB" | grep -q '"login": *"petra"' && ok "K3b: the bearer identifies petra at the REST routes" || bad "K3b: $MEB"
INIT=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"keycloak-e2e","version":"0"}}}' \
  "$HOST/mcp")
echo "$INIT" | grep -q '"serverInfo"' && ok "K3c: /mcp initialize answers on the bearer" || bad "K3c: $INIT"

# ═══ K4: a release on that identity ═══
P=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Keycloak Onboarding"}' "$HOST/api/repos/acme/bpm-processes/processes")
echo "$P" | grep -q '"id": *"keycloak-onboarding"' && ok "K4: process created by the bearer identity" || bad "K4: $P"
R=$(curl -s --max-time 60 -X POST -H "Authorization: Bearer $TOKEN" "$HOST/api/repos/acme/bpm-processes/release/keycloak-onboarding")
echo "$R" | grep -q '"pr": *"http://localhost:'"$STUB_PORT"'/' && echo "$R" | grep -q '"by": *"petra"' \
  && ok "K4b: released → PR opened at the stub, by petra" || bad "K4b: $R"
BRANCH=$(echo "$R" | sed -n 's/.*"branch": *"\([^"]*\)".*/\1/p')
AUTHOR=$(git -C "$E2E/origin/acme/bpm-processes.git" show -s --format='%an <%ae>' "$BRANCH" 2>/dev/null)
[ "$AUTHOR" = "Petra Prozess <petra@users.noreply.github.com>" ] \
  && ok "K4c: commit authored by the human (IdP name, GitHub noreply address)" || bad "K4c: author '$AUTHOR'"

# ═══ K5: fail closed without the login claim ═══
NTOKEN=$(node "$HERE/keycloak-flows.ts" token "$ISSUER" bpmiq-mcp http://localhost:8765/callback nobody nobody 2>&1) || bad "K5: token flow for nobody: $NTOKEN"
NME=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $NTOKEN" "$HOST/api/me")
echo "$NME" | grep -q 'github_login' && [ "$(echo "$NME" | tail -1)" = 401 ] \
  && ok "K5: a token without github_login is refused (401, names the claim)" || bad "K5: $NME"
NMCP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $NTOKEN" -H "content-type: application/json" -d '{}' "$HOST/mcp")
[ "$NMCP" = 401 ] && ok "K5b: …and at /mcp" || bad "K5b: /mcp → $NMCP"
NLOGIN=$(node "$HERE/keycloak-flows.ts" login "$HOST" nobody nobody 2>&1)
echo "$NLOGIN" | grep -q 'callback → HTTP 401' && ok "K5c: the browser login refuses nobody at the callback" || bad "K5c: $NLOGIN"

echo
echo "── $PASS passed, $FAIL failed ──"
if [ "$FAIL" -ne 0 ]; then echo "── host log (tail) ──"; tail -30 "$E2E/host.log"; fi
[ "$FAIL" -eq 0 ]
