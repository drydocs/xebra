#!/usr/bin/env bash
#
# Consolidates spare XLM from the role wallets into the deployer, leaving each with a fixed amount.
#
# Default is a DRY RUN: it reads live balances, prints the exact payments, and sends nothing.
# To send, set CONFIRM to the exact sentence the plan ends with.
#
# Safety, in order:
#   - the destination is derived from the `xebra-deployer` identity and must equal the pinned
#     address below, so a swapped or mistyped identity cannot redirect the sweep;
#   - the amount is `balance - KEEP - fee buffer`, read live, never a constant;
#   - a wallet at or below KEEP is skipped, not overdrawn;
#   - each payment is verified against Horizon afterwards.
#
# Usage:
#   ./scripts/sweep-stellar-xlm.sh                       # plan only
#   CONFIRM="send the XLM plan above" ./scripts/sweep-stellar-xlm.sh

set -euo pipefail

HORIZON="${HORIZON_URL:-https://horizon.stellar.org}"
RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
PASS="Public Global Stellar Network ; September 2015"
DEST_IDENTITY="xebra-deployer"
DEST_PINNED="GAV4VTN62KQCHZZMWA4EPNPQB3XCB7CJKUO7RW3SMH6I42F3RYUVXI65"
SOURCES=(xebra-admin xebra-pauser xebra-fee-recipient)
KEEP_STROOPS=20000000     # 2 XLM
FEE_BUFFER_STROOPS=10000  # 0.001 XLM, so the source is not left below KEEP by the fee
SENTENCE="send the XLM plan above"

die() { echo "FAIL: $*" >&2; exit 1; }

DEST="$(stellar keys address "$DEST_IDENTITY")"
[ "$DEST" = "$DEST_PINNED" ] || die "identity $DEST_IDENTITY is $DEST, expected $DEST_PINNED"

balance_stroops() { # $1 = address
  curl -s -m 20 -A curl/8 "$HORIZON/accounts/$1" | python3 -c "
import sys, json
from decimal import Decimal
r = json.load(sys.stdin)
print(int(Decimal(next(b['balance'] for b in r['balances'] if b['asset_type'] == 'native')) * 10**7))"
}

declare -a NAMES AMOUNTS ADDRS
echo "destination  $DEST_IDENTITY  $DEST"
echo
for name in "${SOURCES[@]}"; do
  addr="$(stellar keys address "$name")"
  bal="$(balance_stroops "$addr")" || die "could not read the balance of $name"
  amt=$(( bal - KEEP_STROOPS - FEE_BUFFER_STROOPS ))
  if [ "$amt" -le 0 ]; then
    printf '  %-22s %s  balance %s stroops: at or below the amount to keep, skipped\n' "$name" "${addr:0:6}…" "$bal"
    continue
  fi
  printf '  %-22s %s  balance %s  ->  send %s stroops (%s XLM), keeps about 2 XLM\n' \
    "$name" "${addr:0:6}…${addr: -4}" "$bal" "$amt" "$(python3 -c "print($amt/1e7)")"
  NAMES+=("$name"); AMOUNTS+=("$amt"); ADDRS+=("$addr")
done
echo
[ "${#NAMES[@]}" -gt 0 ] || { echo "nothing to send"; exit 0; }
echo "Confirm by re-running with CONFIRM=\"$SENTENCE\""

if [ "${CONFIRM:-}" != "$SENTENCE" ]; then
  echo "(dry run: nothing sent)"
  exit 0
fi

for i in "${!NAMES[@]}"; do
  echo "==> ${NAMES[$i]} -> $DEST_IDENTITY  ${AMOUNTS[$i]} stroops"
  stellar tx new payment \
    --source-account "${NAMES[$i]}" \
    --destination "$DEST" \
    --asset native \
    --amount "${AMOUNTS[$i]}" \
    --rpc-url "$RPC" --network-passphrase "$PASS" 2>&1 | tail -3
  after="$(balance_stroops "${ADDRS[$i]}")"
  echo "    ${NAMES[$i]} now holds $after stroops"
done
echo "deployer now holds $(balance_stroops "$DEST") stroops"
