#!/usr/bin/env bash
#
# Sends one real transfer out of Arc TESTNET through the deployed XebraCctpWrapper and follows it to
# the destination: Circle's attestation, its forwarder's delivery, and the recipient's balance, which
# must equal the amount minus the fee the contract quoted.
#
# Testnet only; nothing here can touch mainnet. The wrapper is read from deployments/testnet.json.
#
# Usage:
#   PRIVATE_KEY_FILE=… DEST=base scripts/test-arc-wrapper-testnet.sh
#     DEST       base | optimism | arbitrum | avalanche | solana
#     AMOUNT     in USDC units, default 2000000 (2 USDC)
#     RECIPIENT  an EVM address; default a fresh one, so the balance starts at zero
#     SOLANA_OWNER  for solana: the wallet (base58); default a fresh one, so Circle opens its account
#
# Requires cast, curl, python3, and node with apps/web's dependencies installed (for Solana keys).

set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARC_RPC="https://rpc.testnet.arc.network"
IRIS="https://iris-api-sandbox.circle.com"
USDC=0x3600000000000000000000000000000000000000
SOLANA_DEVNET_RPC="https://api.devnet.solana.com"
SOLANA_DEVNET_USDC="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
AMOUNT="${AMOUNT:-2000000}"
DEST="${DEST:?set DEST: base, optimism, arbitrum, avalanche or solana}"
KEY="$(cat "${PRIVATE_KEY_FILE:?set PRIVATE_KEY_FILE, a funded Arc testnet key}")"
WRAPPER="${WRAPPER:-$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/testnet.json'))['arcWrapper']['address'])")}"

die() { echo "FAIL: $*" >&2; exit 1; }

# Public endpoints drop requests; every read is retried before it counts as an answer.
fetch() {
  local out
  for _ in 1 2 3 4 5 6; do
    out="$(curl -s -m 20 "$@")" && [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 3
  done
  return 1
}
rpc_post() { fetch "$1" -X POST -H 'content-type: application/json' -d "$2"; }
retry() {
  local out
  for _ in 1 2 3 4 5 6; do
    out="$("$@" 2>/dev/null)" && [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 3
  done
  return 1
}

# Testnet USDC, each address read back from its own chain (symbol USDC, 6 decimals) on 2026-10-14.
case "$DEST" in
  base)      DOMAIN=6; RPC=https://sepolia.base.org;                    DUSDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e ;;
  optimism)  DOMAIN=2; RPC=https://sepolia.optimism.io;                 DUSDC=0x5fd84259d66Cd46123540766Be93DFE6D43130D7 ;;
  arbitrum)  DOMAIN=3; RPC=https://sepolia-rollup.arbitrum.io/rpc;      DUSDC=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d ;;
  avalanche) DOMAIN=1; RPC=https://api.avax-test.network/ext/bc/C/rpc;  DUSDC=0x5425890298aed601595a70AB815c96711a31Bc65 ;;
  solana)    DOMAIN=5 ;;
  *) die "unknown DEST $DEST" ;;
esac

SENDER="$(cast wallet address --private-key "$KEY")"
OWNER_HEX=0x0000000000000000000000000000000000000000000000000000000000000000
CREATES=false
QUERY="forward=true"
if [ "$DOMAIN" = 5 ]; then
  read -r OWNER_B58 ATA_B58 OWNER32 ATA32 < <(cd "$REPO_ROOT/apps/web" && SOLANA_OWNER="${SOLANA_OWNER:-}" node --input-type=module -e "
    import { Keypair, PublicKey } from '@solana/web3.js';
    const owner = process.env.SOLANA_OWNER ? new PublicKey(process.env.SOLANA_OWNER) : Keypair.generate().publicKey;
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), new PublicKey('$SOLANA_DEVNET_USDC').toBuffer()],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
    console.log(owner.toBase58(), ata.toBase58(), '0x' + owner.toBuffer().toString('hex'), '0x' + ata.toBuffer().toString('hex'));
  ")
  exists="$(rpc_post "$SOLANA_DEVNET_RPC" \
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$ATA_B58\",{\"encoding\":\"base64\"}]}" \
    | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["result"]["value"] else "no")')"
  RECIP32="$ATA32"
  if [ "$exists" = no ]; then
    OWNER_HEX="$OWNER32"; CREATES=true; QUERY="forward=true&includeRecipientSetup=true"
  fi
  echo "recipient   Solana devnet wallet $OWNER_B58, USDC account $ATA_B58 (exists: $exists)"
else
  RECIPIENT="${RECIPIENT:-$(cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["address"])')}"
  RECIP32="$(cast abi-encode 'f(address)' "$RECIPIENT")"
  echo "recipient   $RECIPIENT on $DEST"
fi

MAX_FEE="$(fetch "$IRIS/v2/burn/USDC/fees/26/$DOMAIN?$QUERY" \
  | python3 -c 'import json,sys; print(next(r["forwardFee"]["high"] for r in json.load(sys.stdin) if r["finalityThreshold"] == 2000))')"
QUOTE="$(retry cast call "$WRAPPER" 'quote(uint256,uint32,uint256,uint32,bool)((uint256,uint256,uint256,uint256,uint256,bool))' \
  "$AMOUNT" "$DOMAIN" "$MAX_FEE" 2000 "$CREATES" --rpc-url "$ARC_RPC")"
FEE="$(echo "$QUOTE" | tr -d '()' | cut -d, -f2 | awk '{print $1}')"
EXPECT=$((AMOUNT - FEE))
echo "amount      $AMOUNT   Circle's fee $MAX_FEE   total fee $FEE   recipient should get $EXPECT"

accrued_before="$(retry cast call "$WRAPPER" 'accruedFees()(uint256)' --rpc-url "$ARC_RPC" | awk '{print $1}')"
cast send "$USDC" 'approve(address,uint256)' "$WRAPPER" "$AMOUNT" --private-key "$KEY" --rpc-url "$ARC_RPC" >/dev/null
DEADLINE=$(( $(date +%s) + 600 ))
TX="$(cast send "$WRAPPER" 'bridge((uint256,uint32,bytes32,uint256,uint32,bytes32,uint256,uint64))' \
  "($AMOUNT,$DOMAIN,$RECIP32,$MAX_FEE,2000,$OWNER_HEX,$FEE,$DEADLINE)" \
  --private-key "$KEY" --rpc-url "$ARC_RPC" --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="0x1", d; print(d["transactionHash"])')"
echo "burned      $TX (from $SENDER)"
accrued_after="$(retry cast call "$WRAPPER" 'accruedFees()(uint256)' --rpc-url "$ARC_RPC" | awk '{print $1}')"
echo "accrued     $accrued_before -> $accrued_after (took $((accrued_after - accrued_before)))"
left="$(retry cast call "$USDC" 'allowance(address,address)(uint256)' "$WRAPPER" 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA --rpc-url "$ARC_RPC" | awk '{print $1}')"
[ "$left" = 0 ] || die "the wrapper left allowance $left to Circle's messenger"

balance() {
  if [ "$DOMAIN" = 5 ]; then
    rpc_post "$SOLANA_DEVNET_RPC" \
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenAccountBalance\",\"params\":[\"$ATA_B58\"]}" \
      | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["result"]["value"]["amount"] if "result" in r else 0)'
  else
    retry cast call "$DUSDC" 'balanceOf(address)(uint256)' "$RECIPIENT" --rpc-url "$RPC" | awk '{print $1}'
  fi
}

# The recipient's balance is the finish line. Circle's own forwardState is printed alongside: it has
# been seen as both CONFIRMED and COMPLETE for a delivered transfer.
echo "waiting for Circle's forwarder (testnet takes from seconds to about 15 minutes)…"
start=$(date +%s)
got=0
for _ in $(seq 1 120); do
  state="$(fetch "$IRIS/v2/messages/26?transactionHash=$TX" | python3 -c '
import json, sys
try:
    m = json.load(sys.stdin)["messages"][0]
    body = (m.get("decodedMessage") or {}).get("decodedMessageBody") or {}
    print(m.get("status"), m.get("forwardState"), body.get("feeExecuted"))
except Exception:
    print("none none none")' || echo "none none none")"
  read -r status forward fee_executed <<<"$state"
  [ "$forward" = FAILED ] && die "Circle reports the forward FAILED; claim it at /claim"
  got="$(balance || echo 0)"
  [ "$got" = "$EXPECT" ] && break
  sleep 15
done
echo "delivered   after $(( $(date +%s) - start ))s; Circle says $status / $forward, feeExecuted $fee_executed (maxFee $MAX_FEE)"
echo "recipient   holds $got, expected $EXPECT"
[ "$got" = "$EXPECT" ] || die "the recipient did not get amount - fee within 30 minutes"
[ "$fee_executed" = "$MAX_FEE" ] || echo "note: Circle executed $fee_executed of the $MAX_FEE allowed"
echo "PASS $DEST"
