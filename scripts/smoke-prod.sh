#!/usr/bin/env bash
#
# Is the deployed app working? Read-only: it only GETs, and sends nothing to any chain.
#
#   BASE_URL=https://xebra-sandy.vercel.app ./scripts/smoke-prod.sh
#   BASE_URL=http://localhost:3111          ./scripts/smoke-prod.sh   # a local production build
#   BASE_URL=https://<preview> VERCEL_BYPASS_SECRET=<secret> ./scripts/smoke-prod.sh   # a protected preview
#
# It checks the things that broke or could break at cutover, against REAL data:
#   - the pages serve, and the built app points at wrapper v2 (and not at v1);
#   - Circle is reachable through the pre-flight route, for both destinations and the new-account price;
#   - the delivery route reads Circle's verdict for a transfer that really happened on mainnet
#     (the first v2 test, 2026-09-24) and reports it delivered, with the right Solana transaction;
#   - the attestation route serves that transfer's proof, and the recipient lookup finds its account;
#   - the removed relay routes are gone;
#   - the shared Iris rate counter (Convex) is the one in use, not the per-instance fallback.
#
# Exit status is the number of failed checks, so it can gate a deploy.

set -uo pipefail

BASE_URL="${BASE_URL:?set BASE_URL, e.g. https://xebra-sandy.vercel.app}"
BASE_URL="${BASE_URL%/}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V2="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapperV2']['contractId'])")"
V1="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapper']['contractId'])")"

# The first real transfer through v2: 3.7 USDC Stellar -> Solana, delivered by Circle.
TX="cca4af89bff152915eacf4fc1650db49d71e1dd57a9725d7a97e6421162cd7b3"
FORWARD_TX="2fpvybw9SE5A599N8w5JtERWduo8eDJJc7mZoPFXHJRgtP5HDJfXMJ68vYKzFQUZEAAchzv3bsPLsEv4BkNz3Wvs"
RECIPIENT="C98dmk3BdRwmTTVNdutnzYp9sJSjnhp22ionPRXPXbDR"

# Vercel preview deployments sit behind deployment protection; pass the automation bypass secret to test one.
H=()
[ -n "${VERCEL_BYPASS_SECRET:-}" ] && H=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS_SECRET")

FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
get()  { curl -s ${H[@]+"${H[@]}"} -m 40 -A "xebra-smoke/1" -w '\n%{http_code}' "$BASE_URL$1"; }
# check <label> <path> <expected status> [python assertion over the parsed body `b`]
check() {
  local label="$1" path="$2" want="$3" assertion="${4:-}" out code body
  out="$(get "$path")"; code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" != "$want" ]; then fail "$label: expected HTTP $want, got $code"; return; fi
  if [ -n "$assertion" ]; then
    if BODY="$body" python3 -c "
import json, os, sys
b = json.loads(os.environ['BODY'])
sys.exit(0 if ($assertion) else 1)" 2>/dev/null; then pass "$label"; else fail "$label: unexpected body: ${body:0:200}"; fi
  else
    pass "$label"
  fi
}

echo "smoke test: $BASE_URL"
echo "expecting wrapper v2 $V2 (not v1 $V1)"
echo

echo "pages"
for p in / /claim /recover; do
  code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL$p")"
  [ "$code" = "200" ] && pass "GET $p" || fail "GET $p returned $code"
done

echo "built app points at wrapper v2"
HTML="$(curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL/")"
CHUNKS="$(echo "$HTML" | grep -oE '/_next/static/chunks/[^"]+\.js' | sort -u)"
FOUND_V2=0; FOUND_V1=0
for c in $CHUNKS; do
  js="$(curl -s ${H[@]+"${H[@]}"} -m 40 "$BASE_URL$c")"
  echo "$js" | grep -q "$V2" && FOUND_V2=1
  echo "$js" | grep -q "$V1" && FOUND_V1=1
done
[ "$FOUND_V2" = 1 ] && pass "v2 contract id is in the client bundle" || fail "v2 contract id is NOT in the client bundle (NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID wrong at build time?)"
[ "$FOUND_V1" = 0 ] && pass "v1 contract id is not in the client bundle" || fail "v1 contract id is still in the client bundle"

echo "Circle pre-flight (live Circle calls)"
check "solana, existing account"  "/api/circle-health?dest=solana"               200 "b['status'] in ('ok','degraded') and 0 < b['quote']['high'] < 2000000 and b['quote']['high'] >= b['quote']['low']"
check "solana, new account price" "/api/circle-health?dest=solana&newAccount=1"   200 "b['status'] in ('ok','degraded') and b['quote']['high'] > 200000"
check "arc"                       "/api/circle-health?dest=arc"                   200 "b['status'] in ('ok','degraded') and 0 < b['quote']['high'] < 2000000"
check "rejects an unknown destination" "/api/circle-health?dest=btc"              400
echo "  (a status of 'down' above would mean Circle is unhealthy right now, not that the app is broken: re-run in a minute)"

echo "delivery of a real transfer"
check "delivery reads Circle's verdict" "/api/delivery?tx=$TX" 200 "b['status']=='known' and b['state']=='delivered' and b['forwardTxHash']=='$FORWARD_TX'"
check "delivery rejects a bad hash"     "/api/delivery?tx=zz"  400
check "attestation is served for it"    "/api/attestation?tx=$TX" 200 "b['status']=='complete' and b['destinationDomain']==5 and b['message'].startswith('0x') and b['attestation'].startswith('0x')"
check "recipient lookup finds its account" "/api/recipient?owner=$RECIPIENT" 200 "b['status']=='exists'"

echo "the relay is gone"
for p in "/api/relay/status?tx=$TX" "/api/relay/burns"; do
  code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL$p")"
  [ "$code" = "404" ] && pass "GET $p is 404" || fail "GET $p returned $code (expected 404)"
done
code="$(curl -s ${H[@]+"${H[@]}"} -o /dev/null -m 40 -w '%{http_code}' "$BASE_URL/api/health")"
[ "$code" = "404" ] && pass "GET /api/health (old relay health) is 404" || fail "GET /api/health returned $code (expected 404)"

echo "Iris rate counter"
# Production Convex redacts error messages, so the deployed functions cannot be probed from outside. The app
# reports which counter it is really using instead: `shared` (Convex, seen by every instance) or `local`
# (this instance only: Convex unreachable, or IRIS_BUDGET_SECRET differs between Vercel and Convex).
check "the shared counter is in use" "/api/circle-health?dest=solana" 200 "b['budgetBackend']=='shared'"

echo
if [ "$FAILS" = 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
exit "$FAILS"
