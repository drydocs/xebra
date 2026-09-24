#!/usr/bin/env bash
#
# MAINNET: does Circle's Forwarding Service deliver a Stellar burn to Solana, with and without
# creating the recipient's USDC token account?
#
# Two cases, one script. Both burn straight through Circle's TokenMessengerMinter (not our
# wrapper), Standard finality, and both need no SOL from anyone: Circle's forwarder pays the
# Solana gas, and in the second case the rent for the new account too.
#
#   CASE=existing  the recipient's USDC token account already exists. Plain forward hook (32 bytes),
#                  fee quoted with `forward=true`.
#   CASE=new       it does not exist. Circle's extended hook creates it: 24-byte "cctp-forward",
#                  version 0, length 33, an ATA-creation flag byte (1) and the 32-byte owner, 65
#                  bytes in all. The fee is quoted with `includeRecipientSetup=true`, and the
#                  mint recipient must be the ATA derived from that owner.
#                  (https://developers.circle.com/cctp/concepts/forwarding-service)
#
# Real money, capped and hard to misuse:
#   - the amount defaults to 1 USDC and is capped (MAX_USDC)
#   - RECIPIENT_OWNER is required and there is no default
#   - the destination is verified on Solana before anything is sent: for `existing` the token
#     account must exist, be initialized USDC and belong to that owner; for `new` it must NOT exist
#   - `send` refuses unless CONFIRM_SEND_TO repeats the recipient owner exactly
#   - it never sets a max_fee below Circle's own quote
#   - every transaction is simulated before it is sent
#
# If Circle does not forward it, the burn is still attested and anyone can mint it (destination_caller
# is zero). For `new` that mint needs the account created first, which costs a little SOL from
# whoever rescues it; that is the one real risk here.
#
#   CASE=existing RECIPIENT_OWNER=<base58> scripts/test-cctp-forwarding-solana-mainnet.sh check
#   CASE=new      RECIPIENT_OWNER=<base58> scripts/test-cctp-forwarding-solana-mainnet.sh check
#   CASE=... RECIPIENT_OWNER=<base58> CONFIRM_SEND_TO=<base58> scripts/test-cctp-forwarding-solana-mainnet.sh send
#   CASE=... RECIPIENT_OWNER=<base58> scripts/test-cctp-forwarding-solana-mainnet.sh status <txhash> [--watch]
#
# Environment:
#   CASE             existing | new                                   (required)
#   RECIPIENT_OWNER  the Solana wallet address that will own the USDC (required)
#   SOURCE           stellar identity that burns                      (default xebra-fee-recipient)
#   AMOUNT_USDC      whole USDC to burn                               (default 1, at most MAX_USDC)
#   MAX_FEE_MULT     max_fee as a multiple of Iris's `high` quote     (default 1.0, at least 1.0)
#                    `high` is already the padded tier: sampled on mainnet over 3 minutes it sat ~22%
#                    above the stable `low` tier (0.7% spread) and above every `med` reading, and it
#                    moved ~5% itself. Circle takes the WHOLE max_fee, so extra headroom is pure cost.
#                    (An earlier default of 1.3 was carried over from the Arc test without evidence.)
#
# Needs: stellar CLI, node (with @solana/web3.js from packages/cctp-solana), curl, python3.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Stellar mainnet. Must match packages/network-config/src/networks.ts. ---
SOROBAN_RPC="https://mainnet.sorobanrpc.com"
PASSPHRASE="Public Global Stellar Network ; September 2015"
TOKEN_MESSENGER="CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL"
USDC_SAC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"

# --- Solana mainnet ---
SOLANA_RPC="https://api.mainnet-beta.solana.com"
SOLANA_USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SPL_TOKEN="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SOLANA_DOMAIN=5
STELLAR_DOMAIN=27

IRIS="https://iris-api.circle.com"

# "cctp-forward" as 24 bytes (right-padded), then a big-endian uint32 version 0.
HOOK_MAGIC_VERSION="636374702d666f7277617264000000000000000000000000""00000000"
ZERO32="0000000000000000000000000000000000000000000000000000000000000000"

MAX_USDC=2
CASE="${CASE:-}"
SOURCE="${SOURCE:-xebra-fee-recipient}"
AMOUNT_USDC="${AMOUNT_USDC:-1}"
FINALITY=2000 # Standard. Stellar has no Fast Transfer.

for tool in stellar node curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

die() { echo "REFUSING: $*" >&2; exit 2; }

sinvoke() { # <contract> <fn> [args...]   — extra CLI flags via SINVOKE_FLAGS
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

solana_account() { # <address> -> jsonParsed getAccountInfo response (retries on rate limits)
  local out i
  for i in 1 2 3 4; do
    out="$(curl -s -m 30 -X POST -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$1\",{\"encoding\":\"jsonParsed\"}]}" "$SOLANA_RPC")"
    echo "$out" | grep -q '"result"' && { echo "$out"; return; }
    sleep 4
  done
  echo "$out"
}

ata_balance() { # <ata> -> USDC balance string, "missing" if the account does not exist
  curl -s -m 30 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenAccountBalance\",\"params\":[\"$1\"]}" "$SOLANA_RPC" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d["result"]["value"]["uiAmountString"] if "result" in d else "missing")'
}

derive() { # <owner base58> -> JSON {ata, ownerHex, ataHex, onCurve}
  node -e '
const { PublicKey } = require(process.argv[1]);
const owner = new PublicKey(process.argv[2]);
const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(process.argv[3]).toBuffer(), new PublicKey(process.argv[4]).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
console.log(JSON.stringify({ ata: ata.toBase58(), ownerHex: Buffer.from(owner.toBytes()).toString("hex"), ataHex: Buffer.from(ata.toBytes()).toString("hex"), onCurve: PublicKey.isOnCurve(owner.toBytes()) }));' \
    "$REPO_ROOT/packages/cctp-solana/node_modules/@solana/web3.js" "$1" "$SPL_TOKEN" "$SOLANA_USDC"
}

plan() {
  [ "$CASE" = "existing" ] || [ "$CASE" = "new" ] || die "CASE must be 'existing' or 'new'"
  [ -n "${RECIPIENT_OWNER:-}" ] || die "RECIPIENT_OWNER is required; there is deliberately no default"
  python3 - "$AMOUNT_USDC" "$MAX_USDC" "${MAX_FEE_MULT:-1.0}" <<'PY' || exit 2
import sys
amt, cap, mult = (float(x) for x in sys.argv[1:4])
if not (0 < amt <= cap):
    sys.exit(f"REFUSING: AMOUNT_USDC must be above 0 and at most {cap:g}")
if mult < 1.0:
    sys.exit("REFUSING: MAX_FEE_MULT below 1.0 would underpay Circle's quote and skip the forward")
PY

  local d
  d="$(derive "$RECIPIENT_OWNER")" || die "RECIPIENT_OWNER is not a valid Solana address"
  ATA="$(echo "$d" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ata"])')"
  OWNER_HEX="$(echo "$d" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ownerHex"])')"
  ATA_HEX="$(echo "$d" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ataHex"])')"
  [ "$(echo "$d" | python3 -c 'import sys,json; print(json.load(sys.stdin)["onCurve"])')" = "True" ] \
    || die "RECIPIENT_OWNER is off the ed25519 curve (a program address); a wallet is expected"

  # Verify the destination against the chain, so a wrong address cannot spend a burn.
  local acct state
  acct="$(solana_account "$ATA")"
  state="$(echo "$acct" | python3 -c '
import sys, json
try:
    v = json.load(sys.stdin)["result"]["value"]
except Exception:
    print("unreadable"); sys.exit()
if not v:
    print("absent"); sys.exit()
i = (v.get("data") or {}).get("parsed", {}).get("info", {})
ok = v.get("owner") == "'"$SPL_TOKEN"'" and i.get("state") == "initialized" and i.get("mint") == "'"$SOLANA_USDC"'" and i.get("owner") == "'"$RECIPIENT_OWNER"'"
print("valid" if ok else "invalid")')"
  [ "$state" != "unreadable" ] || die "could not read $ATA from Solana, so it cannot be verified"
  [ "$state" != "invalid" ] || die "$ATA exists but is not an initialized USDC token account owned by $RECIPIENT_OWNER"
  if [ "$CASE" = "existing" ]; then
    [ "$state" = "valid" ] || die "CASE=existing but the USDC token account $ATA does not exist; use CASE=new"
    QUOTE_QS="forward=true"
    HOOK="${HOOK_MAGIC_VERSION}00000000"
    ATA_NOTE="exists (initialized USDC, owned by the recipient)"
  else
    [ "$state" = "absent" ] || die "CASE=new but $ATA already exists; use CASE=existing (creating it would be paid for and wasted)"
    QUOTE_QS="forward=true&includeRecipientSetup=true"
    HOOK="${HOOK_MAGIC_VERSION}00000021""01""${OWNER_HEX}"
    ATA_NOTE="does not exist yet: Circle's forwarder will create it"
  fi
  MINT_RECIPIENT="$ATA_HEX"

  AMOUNT_STROOPS="$(python3 -c 'import sys; print(int(round(float(sys.argv[1])*10**7)))' "$AMOUNT_USDC")"
  QUOTE="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/$STELLAR_DOMAIN/$SOLANA_DOMAIN?$QUOTE_QS")"
  read -r FWD_HIGH MIN_FEE <<<"$(echo "$QUOTE" | python3 -c '
import sys, json
q = [x for x in json.load(sys.stdin) if x["finalityThreshold"] == 2000][0]
print(q["forwardFee"]["high"], q["minimumFee"])')"
  MAX_FEE="$(python3 -c '
import sys, math
high, mn, mult = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
stroops = math.ceil((high * 10 + mn * 10**7) * mult)
print(-(-stroops // 10) * 10)' "$FWD_HIGH" "$MIN_FEE" "${MAX_FEE_MULT:-1.0}")"
  python3 - "$MAX_FEE" "$AMOUNT_STROOPS" <<'PY' || exit 2
import sys
mf, amt = int(sys.argv[1]), int(sys.argv[2])
if mf * 2 >= amt:
    sys.exit(f"REFUSING: max_fee {mf} would be half or more of the burn ({amt}); raise AMOUNT_USDC")
PY
  SRC_ADDR="$(stellar keys address "$SOURCE")"
  FEE_USDC="$(python3 -c 'import sys; print("%.6f" % (int(sys.argv[1])/1e7))' "$MAX_FEE")"
  NET_USDC="$(python3 -c 'import sys; print("%.6f" % ((int(sys.argv[1]) - int(sys.argv[2]))/1e7))' "$AMOUNT_STROOPS" "$MAX_FEE")"
  HOOK_BYTES=$(( ${#HOOK} / 2 ))
}

show_plan() {
  cat <<PLAN
============================ MAINNET - REAL MONEY (Stellar -> Solana) ============================
Case           $CASE   (fee quoted with: $QUOTE_QS)
Burn from      $SOURCE  $SRC_ADDR
Burn through   Circle TokenMessengerMinter $TOKEN_MESSENGER   (not our wrapper)
Amount         $AMOUNT_USDC USDC   ($AMOUNT_STROOPS stroops)
Recipient      owner $RECIPIENT_OWNER
  USDC account $ATA   -> $ATA_NOTE
  mintRecipient 0x$MINT_RECIPIENT   (the token account, never the wallet)
Finality       $FINALITY (Standard)
Hook data      $HOOK_BYTES bytes: 0x$HOOK
destination_caller = 32 zero bytes   (anyone can mint, so a failed forward stays recoverable)
Forward fee    Iris high quote $FWD_HIGH (6-dec)   ->  max_fee $MAX_FEE stroops = $FEE_USDC USDC
Expected       recipient receives about $NET_USDC USDC, minted by Circle; nobody supplies SOL
Fee taken      the whole max_fee ($FEE_USDC USDC), out of the burn; plus a few cents of XLM
====================================================================================================
PLAN
}

cmd_check() {
  plan
  show_plan
  echo
  local usdc xlm ok=1
  usdc="$(SINVOKE_FLAGS='--send no' sinvoke "$USDC_SAC" balance --id "$SRC_ADDR" 2>/dev/null | tr -d '"' || true)"
  usdc="${usdc:-?}"
  xlm="$(curl -s -m 15 "https://horizon.stellar.org/accounts/$SRC_ADDR" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((b["balance"] for b in d.get("balances",[]) if b["asset_type"]=="native"),"no account"))')"
  echo "Source XLM balance          $xlm"
  echo "Source USDC balance         $usdc stroops   (need >= $AMOUNT_STROOPS)"
  echo "Recipient USDC balance      $(ata_balance "$ATA")"
  if ! [[ "$usdc" =~ ^[0-9]+$ ]] || [ "$usdc" -lt "$AMOUNT_STROOPS" ]; then echo "NOT READY: the source does not hold enough USDC"; ok=0; fi
  echo "Simulating approve (read-only) ..."
  local exp; exp="$(expiry_ledger 300)" || exit 1
  if SINVOKE_FLAGS='--send no' sinvoke "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null 2>&1; then echo "  approve simulates cleanly"; else echo "  approve did not simulate"; ok=0; fi
  echo
  if [ "$ok" = 1 ]; then echo "READY to send."; else echo "Not ready to send - see above."; fi
}

cmd_send() {
  plan
  show_plan
  echo
  if [ "${CONFIRM_SEND_TO:-}" != "$RECIPIENT_OWNER" ]; then
    echo "Refusing to send. This burns real USDC on mainnet." >&2
    echo "Re-run with CONFIRM_SEND_TO=$RECIPIENT_OWNER to confirm the recipient." >&2
    exit 1
  fi
  local exp; exp="$(expiry_ledger 300)" || exit 1
  echo "1/2 approve $AMOUNT_USDC USDC to the TokenMessengerMinter (expires at ledger $exp) ..."
  sinvoke "$USDC_SAC" approve --from "$SRC_ADDR" --spender "$TOKEN_MESSENGER" \
    --amount "$AMOUNT_STROOPS" --expiration_ledger "$exp" >/dev/null

  local burn=(deposit_for_burn_with_hook --caller "$SRC_ADDR" --amount "$AMOUNT_STROOPS"
    --destination_domain "$SOLANA_DOMAIN" --mint_recipient "$MINT_RECIPIENT" --burn_token "$USDC_SAC"
    --destination_caller "$ZERO32" --max_fee "$MAX_FEE" --min_finality_threshold "$FINALITY"
    --hook_data "$HOOK")

  echo "    simulating the burn first ..."
  SINVOKE_FLAGS='--send no' sinvoke "$TOKEN_MESSENGER" "${burn[@]}" >/dev/null

  echo "2/2 deposit_for_burn_with_hook ..."
  local out hash
  out="$(sinvoke "$TOKEN_MESSENGER" "${burn[@]}" 2>&1)" || { echo "$out" >&2; exit 1; }
  echo "$out" | tail -3 | cut -c1-200
  hash="$(echo "$out" | grep -oE 'tx/[0-9a-f]{64}' | head -1 | cut -d/ -f2 || true)"
  [ -n "$hash" ] || hash="$(echo "$out" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
  echo
  if [ -n "$hash" ]; then
    echo "Burn transaction: $hash"
    echo "Now watch it:     CASE=$CASE RECIPIENT_OWNER=$RECIPIENT_OWNER $0 status $hash --watch"
  else
    echo "Could not read the transaction hash above; find it in the CLI output and run status."
  fi
}

cmd_status() {
  local hash="${1:-}" watch="${2:-}"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || { echo "usage: $0 status <64-hex tx hash> [--watch]" >&2; exit 2; }
  [ -n "${RECIPIENT_OWNER:-}" ] || die "RECIPIENT_OWNER is required"
  ATA="$(derive "$RECIPIENT_OWNER" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ata"])')"
  local before now i=0
  before="$(ata_balance "$ATA")"
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
b = (m.get("decodedMessage") or {}).get("decodedMessageBody") or {}
for k in ("amount", "maxFee", "feeExecuted"):
    if k in b: print(f"  {k:<19}", str(b[k])[:60])' || echo "  (Iris poll failed; will retry)"
    now="$(ata_balance "$ATA" 2>/dev/null || echo "$before")"
    echo "  recipient USDC account: $before -> $now"
    if [ "$now" != "$before" ]; then
      echo; echo "LANDED. If forwardState is COMPLETE with a forwardTxHash, Circle forwarded it on MAINNET."
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
  send) cmd_send ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n 2,42p "$0"; exit 2 ;;
esac
