#!/usr/bin/env bash
#
# Does Circle's Forwarding Service pick up a burn that starts on Stellar?
#
# Circle's docs never state whether a Stellar-ORIGIN burn is forwarded. The chain table's
# "Forwarding Service" column lists which chains can be a forwarding DESTINATION (Stellar cannot, and
# that is not our direction); the Stellar -> Arc quickstart mints directly without it; and Iris
# quotes a forward fee for 27 -> 26. Only a burn settles it. (An earlier version of this comment
# read that column as "Stellar is unsupported", which was a misreading.) This makes one, on
# TESTNET, with no real money.
#
# What it does: burns USDC straight through Circle's testnet TokenMessengerMinter (not our
# wrapper) with the forward hook set and Arc testnet as the destination, then watches Iris for a
# forwarded mint. If Circle forwards it, the recipient's Arc balance rises with nobody submitting
# receiveMessage and nobody paying Arc gas.
#
# Testnet only, deliberately: every address below is a testnet address, and there is no mainnet
# switch. A mainnet run is a different script's job, written after this one shows the mechanism
# works.
#
#   scripts/test-cctp-forwarding.sh check                    read-only: balances, quote, the plan
#   CONFIRM=SEND scripts/test-cctp-forwarding.sh send        approve + burn (testnet transactions)
#   scripts/test-cctp-forwarding.sh status <txhash>          ask Iris and the recipient's balance
#   scripts/test-cctp-forwarding.sh status <txhash> --watch  ...every 15s until it lands
#
# Environment:
#   SOURCE         stellar identity that burns        (default xebra-fwdtest)
#   AMOUNT_USDC    whole USDC to burn                 (default 1)
#   MAX_FEE_MULT   max_fee as a multiple of Iris's `high` forward-fee quote   (default 2)
#                  1 = exactly the quote; below the quote is a deliberate fallback test
#   MAX_FEE_STROOPS  an explicit max_fee in 7-decimal stroops (multiple of 10), overriding the
#                  multiple. Used to bisect the lowest max_fee Circle still forwards.
#   DEST           arc (default) or solana. Solana needs a token account that already exists:
#                  SOLANA_ATA=<base58>, default .secrets/solana-devnet-ata.txt (devnet only)
#
#   scripts/test-cctp-forwarding.sh verdict <txhash>   just Iris's forwardState/error, exit 0 once decided
#   ARC_RECIPIENT  Arc testnet address to receive     (default: .secrets/arc-testnet-recipient.json)
#
# Needs: stellar CLI, cast (Foundry), curl, python3.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Stellar testnet (https://developers.circle.com/cctp/references/stellar-contracts) ---
SOROBAN_RPC="https://soroban-testnet.stellar.org"
PASSPHRASE="Test SDF Network ; September 2015"
TOKEN_MESSENGER="CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP"
# SAC of USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 — derived, not copied.
USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
USDC_ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

# --- Arc testnet ---
ARC_RPC="https://rpc.testnet.arc.io"
ARC_DOMAIN=26
ARC_USDC="0x3600000000000000000000000000000000000000"

IRIS="https://iris-api-sandbox.circle.com"
STELLAR_DOMAIN=27

DEST="${DEST:-arc}"
SOLANA_RPC="https://api.devnet.solana.com"
case "$DEST" in
  arc) DEST_DOMAIN=$ARC_DOMAIN ;;
  solana) DEST_DOMAIN=5 ;;
  *) echo "DEST must be arc or solana" >&2; exit 2 ;;
esac

# Circle's static "cctp-forward" hook, version 0 (single hook): the ASCII string "cctp-forward"
# right-padded to 32 bytes. https://developers.circle.com/cctp/concepts/forwarding-service
FORWARD_HOOK="636374702d666f72776172640000000000000000000000000000000000000000"
# 32 zero bytes: anyone may submit the mint, so a failed forward is still claimable.
ZERO32="0000000000000000000000000000000000000000000000000000000000000000"

SOURCE="${SOURCE:-xebra-fwdtest}"
AMOUNT_USDC="${AMOUNT_USDC:-1}"
FINALITY=2000 # Standard. Stellar has no Fast Transfer.

for tool in stellar cast curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

# sinvoke <contract> <fn> [args...]   — extra CLI flags via SINVOKE_FLAGS (e.g. --send no)
sinvoke() {
  local id="$1"; shift
  # shellcheck disable=SC2086
  stellar contract invoke --id "$id" --rpc-url "$SOROBAN_RPC" --network-passphrase "$PASSPHRASE" \
    --source-account "$SOURCE" ${SINVOKE_FLAGS:-} -- "$@"
}

latest_ledger() {
  curl -fsS -m 15 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' "$SOROBAN_RPC" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["sequence"])'
}

# The allowance's expiry ledger, `ttl` ledgers ahead of the chain's latest. It must never be guessed:
# `local exp=$(($(latest_ledger) + N))` once turned a truncated RPC response into ledger N (an expiry
# in the past), because `local x=$(cmd)` swallows cmd's failure. This retries, checks that the value
# is a plausible ledger sequence, and refuses otherwise.
expiry_ledger() {
  local ttl="$1" l i
  for i in 1 2 3 4; do
    l="$(latest_ledger 2>/dev/null || true)"
    if [[ "$l" =~ ^[0-9]{6,}$ ]]; then echo $((l + ttl)); return 0; fi
    sleep 3
  done
  echo "REFUSING: could not read the latest Stellar ledger, so the approval expiry cannot be set safely" >&2
  return 1
}

recipient() {
  if [ "$DEST" = "solana" ]; then
    if [ -n "${SOLANA_ATA:-}" ]; then echo "$SOLANA_ATA"; return; fi
    local sf="$REPO_ROOT/.secrets/solana-devnet-ata.txt"
    [ -f "$sf" ] || { echo "no SOLANA_ATA and no $sf" >&2; exit 2; }
    tr -d '[:space:]' < "$sf"; return
  fi
  if [ -n "${ARC_RECIPIENT:-}" ]; then echo "$ARC_RECIPIENT"; return; fi
  local f="$REPO_ROOT/.secrets/arc-testnet-recipient.json"
  [ -f "$f" ] || { echo "no ARC_RECIPIENT and no $f" >&2; exit 2; }
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(d["address"])' "$f"
}

# The recipient's USDC as a 6-decimal string, through the ERC-20 interface CCTP mints into.
arc_balance() {
  local raw
  if [ "$DEST" = "solana" ]; then
    # The token account's balance on devnet. A missing account is reported, not treated as zero:
    # forwarding needs it to exist, so "missing" is itself the answer to a check.
    curl -s -m 20 -X POST -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenAccountBalance\",\"params\":[\"$1\"]}" "$SOLANA_RPC" \
      | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d["result"]["value"]["uiAmountString"] if "result" in d else "missing")'
    return
  fi
  raw="$(cast call "$ARC_USDC" 'balanceOf(address)(uint256)' "$1" --rpc-url "$ARC_RPC" | awk '{print $1}')"
  python3 -c 'import sys; print("%.6f" % (int(sys.argv[1])/1e6))' "$raw"
}

# The plain forward hook does not create a Solana token account, so a burn to one that does not
# exist cannot be forwarded — and looks exactly like a fee failure. Refusing here is
# what stops a wrong or missing SOLANA_ATA from silently spending a burn and corrupting a test.
# (A stale default once sent five burns to an account that did not exist.)
require_solana_token_account() {
  local acct="$1" out i
  for i in 1 2 3; do
    out="$(curl -s -m 20 -X POST -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$acct\",{\"encoding\":\"jsonParsed\"}]}" "$SOLANA_RPC")"
    echo "$out" | grep -q '"result"' && break
    sleep 4
  done
  echo "$out" | python3 -c '
import sys, json
acct = sys.argv[1]
try:
    v = json.load(sys.stdin)["result"]["value"]
except Exception:
    sys.exit("REFUSING: could not read " + acct + " from devnet, so it cannot be verified")
if not v:
    sys.exit("REFUSING: " + acct + " does not exist on devnet; the plain forward hook does not create token accounts, so a burn to it cannot be forwarded")
info = (v.get("data") or {}).get("parsed", {}).get("info", {})
if v.get("owner") != "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" or info.get("state") != "initialized":
    sys.exit("REFUSING: " + acct + " is not an initialized SPL token account")
if info.get("mint") != "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU":
    sys.exit("REFUSING: " + acct + " holds mint " + str(info.get("mint")) + ", not devnet USDC")' "$acct" || exit 2
}

# Everything derived from the environment, computed once so `check` and `send` cannot disagree.
plan() {
  SRC_ADDR="$(stellar keys address "$SOURCE")"
  RECIPIENT="$(recipient)"
  MINT_RECIPIENT="$(python3 - "$DEST" "$RECIPIENT" <<'PY' || exit 2
import re, sys
dest, r = sys.argv[1], sys.argv[2]
if dest == "arc":
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", r):
        sys.exit(f"ARC recipient is not a 20-byte hex address: {r}")
    print("0" * 24 + r[2:].lower())
else:
    A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for c in r:
        if c not in A:
            sys.exit(f"SOLANA_ATA is not base58: {r}")
        n = n * 58 + A.index(c)
    b = n.to_bytes(32, "big") if n.bit_length() <= 256 else None
    lead = len(r) - len(r.lstrip("1"))
    if b is None or (lead and b[:lead] != bytes(lead)):
        sys.exit("SOLANA_ATA does not decode to 32 bytes")
    print(b.hex())
PY
)"
  if [ "$DEST" = "solana" ]; then require_solana_token_account "$RECIPIENT"; fi
  AMOUNT_STROOPS="$(python3 -c 'import sys; print(int(float(sys.argv[1])*10**7))' "$AMOUNT_USDC")"

  QUOTE="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$STELLAR_DOMAIN/$DEST_DOMAIN?forward=true")"
  # The `high` forward fee at Standard finality, in 6-decimal units. Converted to 7-decimal
  # stroops, doubled for headroom and rounded up to a multiple of 10 (Stellar USDC has 7
  # decimals, CCTP's canonical amount 6; MAX_FEE_MULT overrides the doubling). A max_fee below what the forwarder needs makes the
  # burn silently fall back to a plain Standard transfer — exactly the outcome this test exists
  # to tell apart from "forwarding is not supported".
  read -r FWD_HIGH MIN_FEE <<<"$(echo "$QUOTE" | python3 -c '
import sys, json
q = [x for x in json.load(sys.stdin) if x["finalityThreshold"] == 2000][0]
print(q["forwardFee"]["high"], q["minimumFee"])')"
  MAX_FEE="$(python3 -c '
import sys, math
high, mn = float(sys.argv[1]), float(sys.argv[2])
mult = float(sys.argv[3])
stroops = math.ceil((high * 10 + mn * 10**7) * mult)
print(-(-stroops // 10) * 10)' "$FWD_HIGH" "$MIN_FEE" "${MAX_FEE_MULT:-2}")"
  if [ -n "${MAX_FEE_STROOPS:-}" ]; then
    MAX_FEE="$MAX_FEE_STROOPS"
    [ $((MAX_FEE % 10)) -eq 0 ] || { echo "MAX_FEE_STROOPS must be a multiple of 10" >&2; exit 2; }
    python3 - "$MAX_FEE" "$AMOUNT_STROOPS" <<'PY' || exit 2
import sys
mf, amt = int(sys.argv[1]), int(sys.argv[2])
if not 0 < mf < amt:
    sys.exit(f"max_fee {mf} must be positive and below the burn ({amt})")
PY
  else
    python3 - "$MAX_FEE" "$AMOUNT_STROOPS" <<'PY' || exit 2
import sys
mf, amt = int(sys.argv[1]), int(sys.argv[2])
if mf >= amt // 10:
    sys.exit(f"max_fee {mf} is not comfortably below 10% of the burn ({amt}); raise AMOUNT_USDC")
PY
  fi
}

show_plan() {
  cat <<PLAN
Network        Stellar TESTNET -> $DEST TESTNET   (Iris sandbox)
Burn from      $SOURCE  $SRC_ADDR
Burn through   Circle testnet TokenMessengerMinter $TOKEN_MESSENGER   (not our wrapper)
Amount         $AMOUNT_USDC USDC  ($AMOUNT_STROOPS stroops)
Recipient      $RECIPIENT  ($DEST testnet, domain $DEST_DOMAIN)
  as bytes32   0x$MINT_RECIPIENT
Finality       $FINALITY (Standard)
Forward fee    high quote $FWD_HIGH (6-dec)  ->  max_fee $MAX_FEE stroops
Hook data      0x$FORWARD_HOOK   ("cctp-forward", v0)
destination_caller = 32 zero bytes
Expected       if forwarding is honoured, Circle mints to the recipient on Arc with nobody
               submitting receiveMessage; the recipient gets the burn minus Circle's fee.
PLAN
}

cmd_check() {
  plan
  show_plan
  echo
  local usdc xlm ok=1
  usdc="$(SINVOKE_FLAGS='--send no' sinvoke "$USDC_SAC" balance --id "$SRC_ADDR" 2>/dev/null | tr -d '"' || true)"
  usdc="${usdc:-?}"
  xlm="$(curl -s -m 15 "https://horizon-testnet.stellar.org/accounts/$SRC_ADDR" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((b["balance"] for b in d.get("balances",[]) if b["asset_type"]=="native"),"no account"))')"
  echo "Source XLM balance          $xlm"
  echo "Source USDC balance         $usdc stroops   (need >= $AMOUNT_STROOPS)"
  echo "Recipient Arc USDC balance  $(arc_balance "$RECIPIENT")"
  echo
  if ! [[ "$usdc" =~ ^[0-9]+$ ]] || [ "$usdc" -lt "$AMOUNT_STROOPS" ]; then
    echo "NOT READY: fund $SRC_ADDR with testnet USDC at https://faucet.circle.com"
    echo "           (choose Stellar + USDC; the trustline to $USDC_ISSUER already exists)"
    ok=0
  fi
  echo "Simulating approve (read-only) ..."
  local exp; exp="$(expiry_ledger 500)" || exit 1
  if SINVOKE_FLAGS='--send no' sinvoke "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null 2>&1; then
    echo "  approve simulates cleanly"
  else
    echo "  approve did not simulate"
    ok=0
  fi
  echo
  if [ "$ok" = 1 ]; then echo "READY. Run:  CONFIRM=SEND $0 send"; else echo "Not ready yet — see above."; fi
}

cmd_send() {
  plan
  show_plan
  echo
  if [ "${CONFIRM:-}" != "SEND" ]; then
    echo "Refusing to send. This makes two Stellar TESTNET transactions. Re-run with CONFIRM=SEND." >&2
    exit 1
  fi
  local exp; exp="$(expiry_ledger 500)" || exit 1

  echo "1/2 approve USDC to the TokenMessengerMinter (expires at ledger $exp) ..."
  sinvoke "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null

  local burn=(deposit_for_burn_with_hook --caller "$SRC_ADDR" --amount "$AMOUNT_STROOPS"
    --destination_domain "$DEST_DOMAIN" --mint_recipient "$MINT_RECIPIENT" --burn_token "$USDC_SAC"
    --destination_caller "$ZERO32" --max_fee "$MAX_FEE" --min_finality_threshold "$FINALITY"
    --hook_data "$FORWARD_HOOK")

  echo "    simulating the burn first ..."
  SINVOKE_FLAGS='--send no' sinvoke "$TOKEN_MESSENGER" "${burn[@]}" >/dev/null

  echo "2/2 deposit_for_burn_with_hook ..."
  local out hash
  out="$(sinvoke "$TOKEN_MESSENGER" "${burn[@]}" 2>&1)" || { echo "$out" >&2; exit 1; }
  echo "$out" | tail -5
  hash="$(echo "$out" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
  echo
  if [ -n "$hash" ]; then
    echo "Burn transaction: $hash"
    echo "Now watch it:     $0 status $hash --watch"
  else
    echo "Could not read the transaction hash from the output above. Find the stellar CLI's"
    echo "'Transaction hash is ...' line and pass it to:  $0 status <hash> --watch"
  fi
}

cmd_status() {
  local hash="${1:-}" watch="${2:-}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || { echo "usage: $0 status <64-hex tx hash> [--watch]" >&2; exit 2; }
  RECIPIENT="$(recipient)"
  local before now i=0
  before="$(arc_balance "$RECIPIENT")"
  while :; do
    echo "--- $(date +%H:%M:%S)  Iris sandbox, source domain $STELLAR_DOMAIN"
    # A poll that times out is not an answer. Under `set -e` and pipefail one flaky Iris response
    # used to end the whole watch, so every step of this loop is allowed to fail and be retried.
    curl -s -m 20 "$IRIS/v2/messages/$STELLAR_DOMAIN?transactionHash=$hash" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  (no JSON yet:", e, ")"); sys.exit(0)
msgs = d.get("messages") or []
if not msgs:
    print("  no message yet:", json.dumps(d)[:160]); sys.exit(0)
m = msgs[0]
print("  status         ", m.get("status"))
for k in ("forwardState", "forwardErrorCode", "forwardErrorDetails", "forwardTxHash", "cctpVersion", "delayReason"):
    if m.get(k) is not None: print(f"  {k:<19}", m[k])
# Iris sends `decodedMessage: null` until it has decoded the message, so a missing key and a
# null value are different things and both must be tolerated.
dm = m.get("decodedMessage") or {}
print("  destination    ", dm.get("destinationDomain"), "  finality", dm.get("minFinalityThreshold"))
body = dm.get("decodedMessageBody") or {}
for k in ("amount", "feeExecuted", "mintRecipient", "hookData"):
    if k in body: print(f"  {k:<15}", str(body[k])[:80])' || echo "  (Iris poll failed; will retry)"
    now="$(arc_balance "$RECIPIENT" 2>/dev/null || echo "$before")"
    echo "  recipient Arc USDC: $before -> $now"
    if [ "$now" != "$before" ]; then
      echo
      echo "LANDED. The recipient balance moved. If forwardState / forwardTxHash above are set,"
      echo "Circle forwarded it; if they are empty, someone submitted the mint by hand."
      return 0
    fi
    [ "$watch" = "--watch" ] || return 0
    i=$((i + 1))
    if [ "$i" -ge 80 ]; then echo "gave up after ~20 minutes"; return 1; fi
    sleep 15
  done
}

# Just the decision, for bisecting: exit 0 once Iris has decided (COMPLETE or FAILED), 1 while it has
# not. FAILED is visible as soon as the message is attested; COMPLETE arrives minutes later.
cmd_verdict() {
  local hash="${1:-}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || { echo "usage: $0 verdict <64-hex tx hash>" >&2; exit 2; }
  curl -s -m 20 "$IRIS/v2/messages/$STELLAR_DOMAIN?transactionHash=$hash" | python3 -c '
import sys, json
try:
    m = json.load(sys.stdin)["messages"][0]
except Exception:
    print("pending (not indexed)"); sys.exit(1)
b = (m.get("decodedMessage") or {}).get("decodedMessageBody") or {}
st = m.get("forwardState")
line = f"{m.get(\"status\")} | forwardState={st} | maxFee={b.get(\"maxFee\")} feeExecuted={b.get(\"feeExecuted\")}"
if m.get("forwardErrorCode"): line += f" | {m[\"forwardErrorCode\"]}"
print(line)
sys.exit(0 if st in ("COMPLETE", "FAILED") else 1)'
}

case "${1:-}" in
  verdict) shift; cmd_verdict "$@" ;;
  check) cmd_check ;;
  send) cmd_send ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n 2,28p "$0"; exit 2 ;;
esac
