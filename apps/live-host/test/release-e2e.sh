#!/bin/bash
# Release-flow integration test — fully offline: GitHub stub + file:// origins.
#
# Verifies the four release-gate behaviors end to end:
#   A1  releasing an unchanged process is rejected ("nothing to release")
#   A2  a model change without a version bump is blocked (Hard Rule 5)
#   A3  a proper release pushes a branch + opens a PR with correct paths
#   A4  upstream commits the workspace never absorbed block the release
#       (a release must never silently revert merged work)
#   B   monorepo-shaped repos (content under process-documentation/) release
#       to process-documentation/processes/…, not a bogus top-level processes/
#   C   model-anchored todos over HTTP: create → tracker issue with anchor +
#       session attribution, list with process filter, empty-title 400
#
# Run: bash test/release-e2e.sh   (or: pnpm --filter @bpmiq/live-host test)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
FIXTURE="$REPO_ROOT/packages/validator/test/fixtures/content-repo"
E2E="$(mktemp -d "${TMPDIR:-/tmp}/bpm-release-e2e.XXXXXX")"
STUB_PORT="${STUB_PORT:-8399}"
PORT_A="${PORT_A:-8321}"
PORT_B="${PORT_B:-8322}"
PASS=0; FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$E2E"; }
trap cleanup EXIT

mkdir -p "$E2E/origin/acme" "$E2E/empty" "$E2E/data1" "$E2E/data2"

# the live host only enumerates repos when app credentials exist — a throwaway
# RSA key is enough, the stub never verifies signatures
if [ -z "${GITHUB_APP_ID:-}" ]; then
  openssl genrsa -out "$E2E/app.pem" 2048 2>/dev/null
  export GITHUB_APP_ID="4711"
  export GITHUB_APP_PRIVATE_KEY_FILE="$E2E/app.pem"
fi

edit() { # $1=file $2=search $3=replace  (portable in-place substitution)
  # with `node -e` there is no script path: user args start at process.argv[1]
  node -e 'const fs=require("fs");const[,f,s,r]=process.argv;const t=fs.readFileSync(f,"utf8");if(!t.includes(s))throw new Error(`edit: "${s}" not found in ${f}`);fs.writeFileSync(f,t.replace(s,r));' "$1" "$2" "$3"
}

# ── origin 1: plain content repo ─────────────────────────────────────
SRC1="$E2E/src1"
cp -R "$FIXTURE" "$SRC1"
git -C "$SRC1" init -q -b main && git -C "$SRC1" add -A
git -C "$SRC1" -c user.name=e2e -c user.email=e2e@test commit -qm "content"
git clone -q --bare "$SRC1" "$E2E/origin/acme/bpm-processes.git"

# ── origin 2: monorepo shape (content under process-documentation/) ──
SRC2="$E2E/src2"
mkdir -p "$SRC2/process-documentation"
cp -R "$FIXTURE/." "$SRC2/process-documentation/"
echo "# a monorepo" > "$SRC2/README.md"
git -C "$SRC2" init -q -b main && git -C "$SRC2" add -A
git -C "$SRC2" -c user.name=e2e -c user.email=e2e@test commit -qm "monorepo content"
git clone -q --bare "$SRC2" "$E2E/origin/acme/monorepo.git"

# ── stub provider ─────────────────────────────────────────────────────
STUB_PORT="$STUB_PORT" node "$HERE/stub-provider.ts" >"$E2E/stub.log" 2>&1 &
PIDS+=($!)
sleep 1
curl -s -X POST -d '{"repos":["acme/bpm-processes","acme/monorepo"]}' "http://localhost:$STUB_PORT/_control" >/dev/null

start_host() { # $1=repo $2=data-dir $3=port — sets HOST_PID
  PORT="$3" LIVE_DATA_DIR="$2" LIVE_DEV_TOKEN=demo \
  GITHUB_REPO="$1" LIVE_HOST_CONTENT_DIR="$E2E/empty" \
  GITHUB_BASE_URL="http://localhost:$STUB_PORT" GITHUB_API_URL="http://localhost:$STUB_PORT" \
  GITHUB_CLIENT_ID=stub GITHUB_CLIENT_SECRET=stub \
  LIVE_GIT_URL_OVERRIDE="file://$E2E/origin" \
  LIVE_PUSH_URL_OVERRIDE="file://$E2E/origin/$1.git" \
  node "$REPO_ROOT/apps/live-host/src/server.ts" >"$E2E/host-$3.log" 2>&1 &
  HOST_PID=$!
  PIDS+=($HOST_PID)
}
release() { # $1=port $2=repo $3=id
  curl -s --max-time 60 -X POST -H "Authorization: Bearer demo" "http://localhost:$1/api/repos/$2/release/$3"
}

# ═══ Case A: plain content repo ═══
start_host "acme/bpm-processes" "$E2E/data1" "$PORT_A"
sleep 2.5
curl -s --max-time 60 -H "Authorization: Bearer demo" "http://localhost:$PORT_A/api/repos/acme/bpm-processes/processes" >/dev/null
sleep 1
WS1="$E2E/data1/workspaces/acme/bpm-processes"
[ -d "$WS1/.git" ] && ok "A: workspace cloned" || bad "A: workspace not cloned"

R=$(release "$PORT_A" acme/bpm-processes two-pool)
echo "$R" | grep -q "nothing to release" && ok "A1: no-change release rejected" || bad "A1: expected 'nothing to release', got: $R"

edit "$WS1/processes/two-pool/two-pool.bpmn" 'name="Send offer"' 'name="Send revised offer"'
R=$(release "$PORT_A" acme/bpm-processes two-pool)
echo "$R" | grep -q "Versions-Bump" && ok "A2: model change without version bump blocked" || bad "A2: expected version gate, got: $R"

edit "$WS1/processes/two-pool/process.yaml" "version: 0.1.0" "version: 0.2.0"
edit "$WS1/processes/two-pool/process.yaml" "history:" "history:
  - version: 0.2.0
    date: 2026-07-09
    change: rename send offer task
    changed_by: e2e"
R=$(release "$PORT_A" acme/bpm-processes two-pool)
echo "$R" | grep -q '"pr"' && ok "A3: release succeeded → PR" || bad "A3: release failed: $R"
# bot-authored (ADR 0001): the dev session carries NO user token, yet the release
# publishes — because push + PR use the app installation token
echo "$R" | grep -q '"botAuthored": *true' && ok "A3: release is bot-authored (no user token needed)" || bad "A3: expected botAuthored=true, got: $R"
git -C "$E2E/origin/acme/bpm-processes.git" branch | grep -q "release/two-pool" && ok "A3: release branch on origin" || bad "A3: no release branch on origin"
BRANCH=$(git -C "$E2E/origin/acme/bpm-processes.git" branch | grep release/two-pool | tail -1 | tr -d ' *')
git -C "$E2E/origin/acme/bpm-processes.git" show --stat "$BRANCH" | grep -q "processes/two-pool" && ok "A3: diff touches processes/two-pool" || bad "A3: wrong paths in release commit"
# the commit is ATTRIBUTED to the human (git author), not the bot
AUTHOR=$(git -C "$E2E/origin/acme/bpm-processes.git" show -s --format='%an' "$BRANCH")
[ "$AUTHOR" = "dev-token" ] && ok "A3: commit authored by the releasing user (attribution)" || bad "A3: unexpected commit author '$AUTHOR'"
git -C "$E2E/origin/acme/bpm-processes.git" show -s --format='%b' "$BRANCH" | grep -q "Co-authored-by:" && ok "A3: Co-authored-by trailer present" || bad "A3: no Co-authored-by trailer"

FOREIGN="$E2E/foreign"
git clone -q "$E2E/origin/acme/bpm-processes.git" "$FOREIGN"
edit "$FOREIGN/processes/two-pool/process.yaml" "Fixture -" "Fixture (upstream edit) -"
git -C "$FOREIGN" -c user.name=col -c user.email=c@test commit -qam "upstream tweak"
git -C "$FOREIGN" push -q origin main
edit "$WS1/processes/two-pool/two-pool.bpmn" 'name="Review offer"' 'name="Review final offer"'
R=$(release "$PORT_A" acme/bpm-processes two-pool)
echo "$R" | grep -q "upstream geändert" && ok "A4: upstream guard blocks silent revert" || bad "A4: expected upstream guard, got: $R"

# ═══ Case B: monorepo-shaped repo ═══
start_host "acme/monorepo" "$E2E/data2" "$PORT_B"
sleep 2.5
PROCS=$(curl -s --max-time 60 -H "Authorization: Bearer demo" "http://localhost:$PORT_B/api/repos/acme/monorepo/processes")
echo "$PROCS" | grep -q "two-pool" && ok "B: monorepo processes listed (content root detected)" || bad "B: monorepo listing failed: $PROCS"
WS2="$E2E/data2/workspaces/acme/monorepo"
edit "$WS2/process-documentation/processes/two-pool/two-pool.bpmn" 'name="Send offer"' 'name="Send better offer"'
edit "$WS2/process-documentation/processes/two-pool/process.yaml" "version: 0.1.0" "version: 0.2.0"
edit "$WS2/process-documentation/processes/two-pool/process.yaml" "history:" "history:
  - version: 0.2.0
    date: 2026-07-09
    change: better offer
    changed_by: e2e"
R=$(release "$PORT_B" acme/monorepo two-pool)
echo "$R" | grep -q '"pr"' && ok "B: monorepo release succeeded" || bad "B: monorepo release failed: $R"
BRANCH=$(git -C "$E2E/origin/acme/monorepo.git" branch | grep release/two-pool | tail -1 | tr -d ' *')
STAT=$(git -C "$E2E/origin/acme/monorepo.git" show --stat "$BRANCH")
echo "$STAT" | grep -q "process-documentation/processes/two-pool" && ok "B: PR paths under process-documentation/ (prefix fix)" || bad "B: PR paths wrong"
echo "$STAT" | grep -qE "^ processes/" && bad "B: bogus top-level processes/ in PR" || ok "B: no bogus top-level processes/"

# ═══ Case C: model-anchored todos (HTTP route → adapter → stub issue tracker) ═══
T=$(curl -s --max-time 60 -X POST -H "Authorization: Bearer demo" -H "Content-Type: application/json" \
  -d '{"title":"Verify credit rule","body":"Threshold looks stale.","anchor":{"process":"two-pool","elements":[{"id":"Task_SendOffer","name":"Send offer"}]}}' \
  "http://localhost:$PORT_A/api/repos/acme/bpm-processes/todos")
echo "$T" | grep -q '"id": *"1"' && ok "C: todo created via HTTP (tracker issue #1)" || bad "C: todo create failed: $T"
echo "$T" | grep -q '"author": *"dev-token"' && ok "C: author attributed from the session" || bad "C: wrong author: $T"
L=$(curl -s --max-time 60 -H "Authorization: Bearer demo" "http://localhost:$PORT_A/api/repos/acme/bpm-processes/todos?process=two-pool")
echo "$L" | grep -q '"process": *"two-pool"' && ok "C: todo listed with parsed anchor (process filter)" || bad "C: todo list failed: $L"
BADREQ=$(curl -s --max-time 60 -X POST -H "Authorization: Bearer demo" -d '{"title":"  "}' \
  "http://localhost:$PORT_A/api/repos/acme/bpm-processes/todos")
echo "$BADREQ" | grep -q "title must be" && ok "C: blank title rejected (400)" || bad "C: expected title validation, got: $BADREQ"

echo; echo "── $PASS passed, $FAIL failed ──"
exit "$FAIL"
