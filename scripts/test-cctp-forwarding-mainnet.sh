#!/usr/bin/env bash
#
# MAINNET: does Circle's Forwarding Service pick up a real Stellar -> Arc burn?
#
# The testnet run (scripts/test-cctp-forwarding.sh) showed the mechanism works. Circle's docs never
# say whether a Stellar-ORIGIN burn is forwarded (their table only lists forwarding DESTINATIONS),
# so only a real burn answers it for production. This makes exactly one, and is built to be hard
# to misuse.
#
# RESULT (2026-09-20): it forwards on mainnet. Burn 3eb7dba6da30b4a67915c91d981090a539bff30aa84920d13e9ed7221ab7cc8f
# (1 USDC, max_fee 21430) -> Circle's forwarder minted 0.978570 USDC to the recipient about three
# minutes later (forward tx 0x941eeb1bd6ea342122bb788df98c4233e9ea2a9cb20126f20d830b98b77aa078,
# 206,325 gas). feeExecuted equalled max_fee. Safeguards:
#
#   - it burns straight through Circle's TokenMessengerMinter, not our wrapper
#   - the amount is capped (MAX_USDC below) and defaults to 1 USDC
#   - there is no default recipient: ARC_RECIPIENT must be given, and is validated
#   - `send` refuses unless CONFIRM_SEND_TO repeats the recipient exactly
#   - it never sets a max_fee below Circle's own quote, so a failure cannot come from underpaying
#
# Real money. The burned USDC arrives at the recipient minus Circle's forward fee (about two
# cents on Arc). If Circle does NOT forward it, the burn is still attested, the attestation is
# public and never expires, and anyone may submit `receiveMessage` on Arc (destination_caller is
# zero) - which costs about a cent of Arc gas from any wallet. Nothing is lost, only delayed.
#
#   ARC_RECIPIENT=0x... scripts/test-cctp-forwarding-mainnet.sh check
#   CONFIRM=FUND        scripts/test-cctp-forwarding-mainnet.sh fund
#   ARC_RECIPIENT=0x... CONFIRM_SEND_TO=0x... scripts/test-cctp-forwarding-mainnet.sh send
#   scripts/test-cctp-forwarding-mainnet.sh status <txhash> [--watch]     (ARC_RECIPIENT for balance)
#
# `fund` withdraws AMOUNT_USDC of the wrapper's accrued fees to its fee recipient with the ADMIN
# key. It is optional: skip it if SOURCE already holds the USDC.
#
# Environment:
#   ARC_RECIPIENT  Arc mainnet address to receive        (required)
#   SOURCE         stellar identity that burns           (default xebra-fee-recipient)
#   ADMIN          stellar identity of the wrapper admin (default xebra-admin; `fund` only)
#   AMOUNT_USDC    whole USDC to burn                    (default 1, at most MAX_USDC)
#   MAX_FEE_MULT   max_fee as a multiple of Iris's `high` quote (default 1.3, at least 1.0)
#
# Needs: stellar CLI, cast (Foundry), curl, python3.

set -euo pipefail

# --- Stellar mainnet. Must match packages/network-config/src/networks.ts. ---
SOROBAN_RPC="https://mainnet.sorobanrpc.com"
PASSPHRASE="Public Global Stellar Network ; September 2015"
TOKEN_MESSENGER="CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL"
USDC_SAC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
WRAPPER="CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ"

# --- Arc mainnet ---
ARC_RPC="https://rpc.mainnet.arc.io"
ARC_DOMAIN=26
ARC_USDC="0x3600000000000000000000000000000000000000"
# Addresses USDC could never be recovered from. Mirrors apps/web/lib/arc-address.ts.
ARC_UNSAFE="0x3600000000000000000000000000000000000000 0x28b5a0e9c621a5badaa536219b3a228c8168cf5d 0x81d40f21f12a8f0e3252bccb954d722d4c464b64 0xfd78ee919681417d192449715b2594ab58f5d002"

IRIS="https://iris-api.circle.com"
STELLAR_DOMAIN=27

# Circle's static "cctp-forward" hook, version 0: "cctp-forward" right-padded to 32 bytes.
FORWARD_HOOK="636374702d666f72776172640000000000000000000000000000000000000000"
ZERO32="0000000000000000000000000000000000000000000000000000000000000000"

MAX_USDC=2
SOURCE="${SOURCE:-xebra-fee-recipient}"
ADMIN="${ADMIN:-xebra-admin}"
AMOUNT_USDC="${AMOUNT_USDC:-1}"
FINALITY=2000 # Standard. Stellar has no Fast Transfer.

for tool in stellar cast curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

die() { echo "REFUSING: $*" >&2; exit 2; }

# sinvoke <identity> <contract> <fn> [args...]   — extra CLI flags via SINVOKE_FLAGS
sinvoke() {
  local who="$1" id="$2"; shift 2
  # shellcheck disable=SC2086
  stellar contract invoke --id "$id" --rpc-url "$SOROBAN_RPC" --network-passphrase "$PASSPHRASE" \
    --source-account "$who" ${SINVOKE_FLAGS:-} -- "$@"
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

arc_balance() {
  local raw
  raw="$(cast call "$ARC_USDC" 'balanceOf(address)(uint256)' "$1" --rpc-url "$ARC_RPC" | awk '{print $1}')"
  python3 -c 'import sys; print("%.6f" % (int(sys.argv[1])/1e6))' "$raw"
}

validate_recipient() {
  [ -n "${ARC_RECIPIENT:-}" ] || die "ARC_RECIPIENT is required; there is deliberately no default"
  python3 - "$ARC_RECIPIENT" "$ARC_UNSAFE" <<'PY' || exit 2
import re, sys
a, unsafe = sys.argv[1], sys.argv[2].split()
if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a):
    sys.exit("REFUSING: ARC_RECIPIENT is not 0x plus 40 hex characters")
low = a.lower()
b = bytes.fromhex(low[2:])
if not any(b):
    sys.exit("REFUSING: that is the zero address")
if not any(b[:18]):
    sys.exit("REFUSING: that is a system or burn address")
if low in unsafe:
    sys.exit("REFUSING: that address is a contract USDC could never be recovered from")
body = a[2:]
if body != body.lower() and body != body.upper():
    import subprocess
    good = subprocess.run(["cast", "to-check-sum-address", low], capture_output=True, text=True).stdout.strip()
    if good != a:
        sys.exit(f"REFUSING: EIP-55 checksum mismatch (expected {good}); there is a typo in the address")
PY
  RECIPIENT_LC="$(echo "$ARC_RECIPIENT" | tr 'A-F' 'a-f')"
  RECIPIENT_CS="$(cast to-check-sum-address "$RECIPIENT_LC")"
  local code
  code="$(cast code "$RECIPIENT_LC" --rpc-url "$ARC_RPC")"
  if [ "${#code}" -gt 4 ] && [ "${ALLOW_CONTRACT_RECIPIENT:-}" != "1" ]; then
    die "the recipient is a contract on Arc; a contract that cannot receive USDC would strand it. Set ALLOW_CONTRACT_RECIPIENT=1 only if you are sure"
  fi
  RECIPIENT_KIND="$([ "${#code}" -gt 4 ] && echo "contract" || echo "EOA / unused address")"
}

plan() {
  validate_recipient
  SRC_ADDR="$(stellar keys address "$SOURCE")"
  MINT_RECIPIENT="$(python3 -c 'import sys; print("0"*24 + sys.argv[1][2:])' "$RECIPIENT_LC")"

  python3 - "$AMOUNT_USDC" "$MAX_USDC" "${MAX_FEE_MULT:-1.3}" <<'PY' || exit 2
import sys
amt, cap, mult = (float(x) for x in sys.argv[1:4])
if not (0 < amt <= cap):
    sys.exit(f"REFUSING: AMOUNT_USDC must be above 0 and at most {cap:g}")
if mult < 1.0:
    sys.exit("REFUSING: MAX_FEE_MULT below 1.0 would underpay Circle's quote and skip the forward")
PY
  AMOUNT_STROOPS="$(python3 -c 'import sys; print(int(round(float(sys.argv[1])*10**7)))' "$AMOUNT_USDC")"

  QUOTE="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$STELLAR_DOMAIN/$ARC_DOMAIN?forward=true")"
  # Circle deducts the WHOLE max_fee from what the recipient receives (measured on testnet), so
  # this is also the price of the test. `high` is the tier that gets forwarded reliably; the
  # multiple is headroom for the quote moving between now and Circle processing the burn.
  read -r FWD_HIGH MIN_FEE <<<"$(echo "$QUOTE" | python3 -c '
import sys, json
q = [x for x in json.load(sys.stdin) if x["finalityThreshold"] == 2000][0]
print(q["forwardFee"]["high"], q["minimumFee"])')"
  MAX_FEE="$(python3 -c '
import sys, math
high, mn, mult = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
stroops = math.ceil((high * 10 + mn * 10**7) * mult)
print(-(-stroops // 10) * 10)' "$FWD_HIGH" "$MIN_FEE" "${MAX_FEE_MULT:-1.3}")"
  python3 - "$MAX_FEE" "$AMOUNT_STROOPS" <<'PY' || exit 2
import sys
mf, amt = int(sys.argv[1]), int(sys.argv[2])
if mf >= amt // 10:
    sys.exit(f"REFUSING: max_fee {mf} would be 10% or more of the burn ({amt}); use a larger AMOUNT_USDC")
PY
  FEE_USDC="$(python3 -c 'import sys; print("%.6f" % (int(sys.argv[1])/1e7))' "$MAX_FEE")"
  NET_USDC="$(python3 -c 'import sys; print("%.6f" % (int(sys.argv[1])/1e7 - int(sys.argv[2])/1e7))' "$AMOUNT_STROOPS" "$MAX_FEE")"
}

show_plan() {
  cat <<PLAN
================================ MAINNET - REAL MONEY ================================
Burn from      $SOURCE  $SRC_ADDR
Burn through   Circle TokenMessengerMinter $TOKEN_MESSENGER   (not our wrapper)
Amount         $AMOUNT_USDC USDC   ($AMOUNT_STROOPS stroops)
Recipient      $RECIPIENT_CS   (Arc mainnet, domain $ARC_DOMAIN; $RECIPIENT_KIND)
  as bytes32   0x$MINT_RECIPIENT
Finality       $FINALITY (Standard)
Hook data      0x$FORWARD_HOOK   ("cctp-forward", v0)
destination_caller = 32 zero bytes   (anyone can mint, so a failed forward stays recoverable)
Forward fee    Iris high quote $FWD_HIGH (6-dec)   ->  max_fee $MAX_FEE stroops = $FEE_USDC USDC
Expected       recipient receives about $NET_USDC USDC on Arc, minted by Circle
Fee taken      the whole max_fee ($FEE_USDC USDC), paid out of the burn; plus a few cents of XLM
If not forwarded: burn is attested, nothing is minted, and any wallet can mint it for ~1 cent
                  of Arc gas. The recipient currently holds $(arc_balance "$RECIPIENT_LC") USDC on Arc.
======================================================================================
PLAN
}

cmd_check() {
  plan
  show_plan
  echo
  local usdc xlm ok=1
  usdc="$(SINVOKE_FLAGS='--send no' sinvoke "$SOURCE" "$USDC_SAC" balance --id "$SRC_ADDR" 2>/dev/null | tr -d '"' || true)"
  usdc="${usdc:-?}"
  xlm="$(curl -s -m 15 "https://horizon.stellar.org/accounts/$SRC_ADDR" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((b["balance"] for b in d.get("balances",[]) if b["asset_type"]=="native"),"no account"))')"
  local accrued
  accrued="$(SINVOKE_FLAGS='--send no' sinvoke "$SOURCE" "$WRAPPER" get_accrued_fees 2>/dev/null | tr -d '"' || echo "?")"
  echo "Source XLM balance             $xlm"
  echo "Source USDC balance            $usdc stroops   (need >= $AMOUNT_STROOPS)"
  echo "Wrapper accrued fees           $accrued stroops   (what \`fund\` can withdraw)"
  echo "Recipient Arc USDC balance     $(arc_balance "$RECIPIENT_LC")"
  echo
  if ! [[ "$usdc" =~ ^[0-9]+$ ]] || [ "$usdc" -lt "$AMOUNT_STROOPS" ]; then
    echo "SOURCE does not hold enough USDC yet."
    if [[ "$accrued" =~ ^[0-9]+$ ]] && [ "$accrued" -ge "$AMOUNT_STROOPS" ]; then
      echo "  -> \`CONFIRM=FUND $0 fund\` withdraws $AMOUNT_USDC USDC of accrued fees to the fee recipient."
    fi
    ok=0
  fi
  echo "Simulating fund (withdraw_fees, read-only) ..."
  if SINVOKE_FLAGS='--send no' sinvoke "$ADMIN" "$WRAPPER" withdraw_fees --amount "$AMOUNT_STROOPS" >/dev/null 2>&1; then
    echo "  withdraw_fees simulates cleanly with $ADMIN"
  else
    echo "  withdraw_fees did not simulate with $ADMIN"
  fi
  echo "Simulating approve (read-only) ..."
  local exp; exp="$(expiry_ledger 300)" || exit 1
  if SINVOKE_FLAGS='--send no' sinvoke "$SOURCE" "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null 2>&1; then
    echo "  approve simulates cleanly"
  else
    echo "  approve did not simulate"
    ok=0
  fi
  echo
  if [ "$ok" = 1 ]; then echo "READY to send."; else echo "Not ready to send yet - see above."; fi
}

cmd_fund() {
  AMOUNT_STROOPS="$(python3 -c 'import sys; print(int(round(float(sys.argv[1])*10**7)))' "$AMOUNT_USDC")"
  python3 - "$AMOUNT_USDC" "$MAX_USDC" <<'PY' || exit 2
import sys
if not (0 < float(sys.argv[1]) <= float(sys.argv[2])):
    sys.exit(f"REFUSING: AMOUNT_USDC must be above 0 and at most {sys.argv[2]}")
PY
  echo "Withdraw $AMOUNT_USDC USDC ($AMOUNT_STROOPS stroops) of the wrapper's accrued fees"
  echo "  signed by   $ADMIN  $(stellar keys address "$ADMIN")"
  echo "  paid to     the wrapper's configured fee recipient (withdraw_fees cannot choose another)"
  if [ "${CONFIRM:-}" != "FUND" ]; then
    echo "Refusing to send. Re-run with CONFIRM=FUND." >&2
    exit 1
  fi
  sinvoke "$ADMIN" "$WRAPPER" withdraw_fees --amount "$AMOUNT_STROOPS" 2>&1 | tail -6
}

cmd_send() {
  plan
  show_plan
  echo
  local want="${CONFIRM_SEND_TO:-}"
  if [ "$(echo "$want" | tr 'A-F' 'a-f')" != "$RECIPIENT_LC" ]; then
    echo "Refusing to send. This burns real USDC on mainnet." >&2
    echo "Re-run with CONFIRM_SEND_TO=$RECIPIENT_CS to confirm the recipient." >&2
    exit 1
  fi
  local exp; exp="$(expiry_ledger 300)" || exit 1

  echo "1/2 approve $AMOUNT_USDC USDC to the TokenMessengerMinter (expires at ledger $exp) ..."
  sinvoke "$SOURCE" "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null

  local burn=(deposit_for_burn_with_hook --caller "$SRC_ADDR" --amount "$AMOUNT_STROOPS"
    --destination_domain "$ARC_DOMAIN" --mint_recipient "$MINT_RECIPIENT" --burn_token "$USDC_SAC"
    --destination_caller "$ZERO32" --max_fee "$MAX_FEE" --min_finality_threshold "$FINALITY"
    --hook_data "$FORWARD_HOOK")

  echo "    simulating the burn first ..."
  SINVOKE_FLAGS='--send no' sinvoke "$SOURCE" "$TOKEN_MESSENGER" "${burn[@]}" >/dev/null

  echo "2/2 deposit_for_burn_with_hook ..."
  local out hash
  out="$(sinvoke "$SOURCE" "$TOKEN_MESSENGER" "${burn[@]}" 2>&1)" || { echo "$out" >&2; exit 1; }
  echo "$out" | tail -4 | cut -c1-200
  hash="$(echo "$out" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
  echo
  if [ -n "$hash" ]; then
    echo "Burn transaction: $hash"
    echo "Now watch it:     ARC_RECIPIENT=$RECIPIENT_CS $0 status $hash --watch"
  else
    echo "Could not read the transaction hash above; find it in the CLI output and run status."
  fi
}

cmd_status() {
  local hash="${1:-}" watch="${2:-}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || { echo "usage: $0 status <64-hex tx hash> [--watch]" >&2; exit 2; }
  validate_recipient
  local before now i=0
  before="$(arc_balance "$RECIPIENT_LC")"
  while :; do
    echo "--- $(date +%H:%M:%S)  Iris mainnet, source domain $STELLAR_DOMAIN"
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
for k in ("forwardState", "forwardErrorCode", "forwardErrorDetails", "forwardTxHash", "delayReason"):
    if m.get(k) is not None: print(f"  {k:<19}", m[k])
dm = m.get("decodedMessage") or {}
body = dm.get("decodedMessageBody") or {}
for k in ("amount", "maxFee", "feeExecuted", "mintRecipient"):
    if k in body: print(f"  {k:<19}", str(body[k])[:80])' || echo "  (Iris poll failed; will retry)"
    now="$(arc_balance "$RECIPIENT_LC" 2>/dev/null || echo "$before")"
    echo "  recipient Arc USDC: $before -> $now"
    if [ "$now" != "$before" ]; then
      echo
      echo "LANDED. If forwardState is COMPLETE with a forwardTxHash, Circle forwarded it on MAINNET."
      return 0
    fi
    [ "$watch" = "--watch" ] || return 0
    i=$((i + 1))
    if [ "$i" -ge 80 ]; then echo "gave up after ~20 minutes; see forwardState above"; return 1; fi
    sleep 15
  done
}

case "${1:-}" in
  check) cmd_check ;;
  fund) cmd_fund ;;
  send) cmd_send ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n 2,34p "$0"; exit 2 ;;
esac
