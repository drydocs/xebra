#!/usr/bin/env bash
#
# One real transfer through the mainnet wrapper v2, from a Stellar identity to a Solana wallet.
#
# The wrapper is the only thing that should be sending: it puts Circle's forwarding hook on the burn, so
# Circle mints on the destination and nobody else has to. This is the end-to-end check of that.
#
# Default is a DRY RUN. It reads the live state, prices the transfer with the contract's own `quote`,
# and SIMULATES the `bridge` call. It sends nothing. To send, set CONFIRM_SEND_TO to the recipient
# wallet address exactly, so the recipient is retyped by whoever runs it.
#
# What it works out itself (never hardcoded, all of it read live):
#   - the recipient's USDC token account (derived) and whether it exists on chain. If it does not,
#     Circle opens it as part of delivery: `recipient_needs_account` and `recipient_owner` are set and
#     the higher fee applies. The wallet must NOT be passed as the mint recipient: Circle enforces that
#     the mint recipient is the token account, and a wallet address strands the burn.
#   - `max_fee`: Circle's `high` forward-fee quote for exactly this case, at 1.0x, in stroops.
#   - the price shown by the contract's `quote`, which is pinned as `max_wrapper_fee`.
#
# Refuses: an amount above MAX_USDC, a recipient token account with the wrong owner or mint, a quote
# the contract will not forward, and a fee above the destination's cap.
#
# Usage:
#   RECIPIENT=<solana wallet> AMOUNT_USDC=3.7 ./scripts/test-wrapper-v2-mainnet.sh
#   RECIPIENT=... AMOUNT_USDC=3.7 CONFIRM_SEND_TO=<same wallet> ./scripts/test-wrapper-v2-mainnet.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
PASS="Public Global Stellar Network ; September 2015"
SOURCE="${SOURCE:-xebra-fee-recipient}"
MAX_USDC="${MAX_USDC:-5}"
WRAPPER="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapperV2']['contractId'])")"
IRIS="${IRIS_BASE_URL:-https://iris-api.circle.com}"

: "${RECIPIENT:?RECIPIENT (a Solana wallet address) is required}"
: "${AMOUNT_USDC:?AMOUNT_USDC is required}"

die() { echo "FAIL: $*" >&2; exit 1; }

python3 -c "import sys; sys.exit(0 if 0 < float('$AMOUNT_USDC') <= float('$MAX_USDC') else 1)" \
  || die "AMOUNT_USDC must be above 0 and at most $MAX_USDC (this is a test script; raise MAX_USDC deliberately)"
AMOUNT="$(python3 -c "from decimal import Decimal;print(int(Decimal('$AMOUNT_USDC')*10**7))")"

USER_ADDR="$(stellar keys address "$SOURCE")" || die "no stellar identity named $SOURCE"
echo "wrapper     $WRAPPER"
echo "sender      $SOURCE  $USER_ADDR"
echo "recipient   $RECIPIENT"
echo "amount      $AMOUNT_USDC USDC ($AMOUNT stroops)"

# ---- the recipient, on chain -------------------------------------------------------------------
RESOLVED="$(node "$REPO_ROOT/scripts/resolve-solana-recipient.mjs" "$RECIPIENT")" || die "could not resolve the recipient"
read -r OWNER_HEX ATA_HEX EXISTS ATA_B58 <<<"$RESOLVED"
echo "token acct  $ATA_B58  (exists on chain: $EXISTS)"
if [ "$EXISTS" = "true" ]; then NEEDS=false; OWNER_FIELD="$(printf '0%.0s' {1..64})"; else NEEDS=true; OWNER_FIELD="$OWNER_HEX"; fi

# ---- Circle's live delivery fee for exactly this case ----------------------------------------------
SETUP=""; [ "$NEEDS" = "true" ] && SETUP="&includeRecipientSetup=true"
UNITS="$(curl -s -m 20 "$IRIS/v2/burn/USDC/fees/27/5?forward=true$SETUP" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
r = next(x for x in rows if x['finalityThreshold'] == 2000)
print(r['forwardFee']['high'])")" || die "could not read Circle's fee quote"
MAX_FEE=$((UNITS * 10))
echo "circle fee  high tier $UNITS units -> max_fee $MAX_FEE stroops ($(python3 -c "print($MAX_FEE/1e7)") USDC), new account: $NEEDS"

inv() { stellar contract invoke --id "$WRAPPER" --source-account "$SOURCE" --rpc-url "$RPC" --network-passphrase "$PASS" "$@"; }

# ---- the contract's own price ------------------------------------------------------------------
QUOTE="$(inv --send no -- quote --amount "$AMOUNT" --recipient_needs_account "$NEEDS" --destination_domain 5 --max_fee "$MAX_FEE" 2>&1 | grep -v '^ℹ️\|^🌎')" \
  || { echo "$QUOTE" >&2; die "the contract would not quote this (see the error above; #41 means the delivery fee is over a tenth of the burn, so use a larger amount)"; }
echo "quote       $QUOTE"
FEE="$(python3 -c "import json,sys;q=json.loads(sys.argv[1]);assert q['forwarded'] is True, 'not forwarded';print(q['fee'])" "$QUOTE")" \
  || die "the contract says this transfer would not be forwarded"
GETS="$(python3 -c "import json,sys;q=json.loads(sys.argv[1]);print((int(q['net_burned'])-int(q['forward_fee']))/1e7)" "$QUOTE")"
echo "fee         $(python3 -c "print($FEE/1e7)") USDC   recipient gets $GETS USDC"

# ---- the request ---------------------------------------------------------------------------------
latest_ledger() {
  local n out
  for n in 1 2 3 4; do
    out="$(curl -s -m 15 "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['sequence'])" 2>/dev/null)" && [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 2
  done
  return 1
}
LEDGER="$(latest_ledger)" || die "could not read the latest ledger, so no valid approval expiry can be set"
DEADLINE=$(( $(date +%s) + 600 ))
REQ="$(python3 - <<EOF
import json
print(json.dumps({
  "user": "$USER_ADDR",
  "amount": "$AMOUNT",
  "destination_domain": 5,
  "mint_recipient": "$ATA_HEX",
  "max_fee": "$MAX_FEE",
  "min_finality_threshold": 2000,
  "approval_expiration_ledger": $((LEDGER + 50)),
  "recipient_needs_account": "$NEEDS" == "true",
  "recipient_owner": "$OWNER_FIELD",
  "max_wrapper_fee": "$FEE",
  "deadline": $DEADLINE,
}))
EOF
)"

echo
echo "==> simulating bridge (no signature, nothing sent)"
inv --send no -- bridge --req "$REQ" 2>&1 | grep -v '^ℹ️\|^🌎' | head -5 || true

if [ "${CONFIRM_SEND_TO:-}" != "$RECIPIENT" ]; then
  echo
  echo "(dry run: nothing sent)  To send, re-run with CONFIRM_SEND_TO=$RECIPIENT"
  exit 0
fi

echo
echo "==> SENDING $AMOUNT_USDC USDC from $SOURCE to $RECIPIENT"
# A fresh ledger and deadline for the real send; the simulation above may be a few seconds old.
LEDGER="$(latest_ledger)" || die "could not read the latest ledger"
REQ="$(python3 -c "
import json,sys
r=json.loads(sys.argv[1]); r['approval_expiration_ledger']=int(sys.argv[2]) + 50; r['deadline']=int(sys.argv[3]); print(json.dumps(r))" "$REQ" "$LEDGER" "$(( $(date +%s) + 600 ))")"
OUT="$(inv -- bridge --req "$REQ" 2>&1)" || { echo "$OUT" >&2; die "the bridge call failed (nothing is lost unless a transaction hash was shown above)"; }
echo "$OUT" | grep -v '^ℹ️\|^🌎' | head -20
TX="$(echo "$OUT" | grep -oE 'tx/[0-9a-f]{64}' | head -1 | cut -d/ -f2)"
[ -n "$TX" ] || die "sent, but could not find the transaction hash in the output"
echo "stellar tx  $TX"
echo "$TX" > "$REPO_ROOT/.secrets/dryrun/last-v2-test-tx.txt"

echo
echo "==> watching Circle (Standard finality: usually a few minutes)"
for i in $(seq 1 60); do
  R="$(curl -s -m 15 "$IRIS/v2/messages/27?transactionHash=$TX" || true)"
  S="$(echo "$R" | python3 -c "
import sys, json
try:
    m = json.load(sys.stdin)['messages'][0]
    print(m.get('status'), m.get('forwardState'), m.get('forwardTxHash') or '', m.get('forwardErrorCode') or '')
except Exception:
    print('not indexed yet')" 2>/dev/null)"
  echo "  [$((i*10))s] $S"
  case "$S" in *COMPLETE*|*FAILED*) break;; esac
  sleep 10
done
