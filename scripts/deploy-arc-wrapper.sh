#!/usr/bin/env bash
#
# Deploys contracts/arc-evm/src/XebraCctpWrapper.sol, the fee wrapper for CCTP transfers out of Arc,
# and records it in deployments/<network>.json under `arcWrapper`.
#
# Default is a DRY RUN: every gate runs, the exact constructor arguments are printed, and the
# deployment is simulated (`forge create` without --broadcast). Nothing is sent. To deploy, set
#     CONFIRM="deploy the arc wrapper to <network>"
#
# Gates, in order:
#   1. The RPC is the chain it claims to be (Arc mainnet 5042, testnet 5042002).
#   2. Circle's TokenMessengerV2 there reports domain 26 through its transmitter, and its
#      implementation still has depositForBurnWithHook (selector 0x779b432d).
#   3. The contract's test suite passes.
#   4. The deployer holds enough USDC (Arc's gas token) for the deployment.
#   5. Typed confirmation.
#
# `usdc` and `tokenMessenger` are immutable, and there is no upgrade path: a wrong value means a new
# deployment. Destinations are every chain in packages/network-config's table except Arc, plus
# Solana, at the table's caps, so the contract and the page check the same ceilings. Adding one
# later takes the 48-hour timelock.
#
# Usage:
#   NETWORK=testnet ACCOUNT=<cast keystore> ADMIN=0x… PAUSER=0x… FEE_RECIPIENT=0x… \
#     scripts/deploy-arc-wrapper.sh
#   PRIVATE_KEY_FILE=… may stand in for ACCOUNT on testnet only.

set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS="$REPO_ROOT/contracts/arc-evm"
NETWORK="${NETWORK:-mainnet}"
RECORD="$REPO_ROOT/deployments/$NETWORK.json"
SENTENCE="deploy the arc wrapper to $NETWORK"

die() { echo "FAIL: $*" >&2; exit 1; }

case "$NETWORK" in
  mainnet)
    RPC="${ARC_RPC_URL:-https://rpc.mainnet.arc.io}"
    CHAIN_ID=5042
    MESSENGER=0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
    ;;
  testnet)
    RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
    CHAIN_ID=5042002
    MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
    ;;
  *) die "NETWORK must be mainnet or testnet" ;;
esac
USDC=0x3600000000000000000000000000000000000000

: "${ADMIN:?set ADMIN, the address that proposes and commits changes}"
: "${PAUSER:?set PAUSER, the address that can pause and veto}"
: "${FEE_RECIPIENT:?set FEE_RECIPIENT, where withdrawn fees go}"
if [ "$NETWORK" = mainnet ]; then
  [ -n "${ACCOUNT:-}" ] || die "mainnet signs with a cast keystore: set ACCOUNT"
  [ "$(echo "$ADMIN" | tr A-F a-f)" != "$(echo "$PAUSER" | tr A-F a-f)" ] \
    || die "admin and pauser are the same address; docs/go-live.md wants two people"
fi
if [ -n "${ACCOUNT:-}" ]; then
  SIGNER=(--account "$ACCOUNT")
  DEPLOYER="$(cast wallet address --account "$ACCOUNT")"
elif [ -n "${PRIVATE_KEY_FILE:-}" ]; then
  SIGNER=(--private-key "$(cat "$PRIVATE_KEY_FILE")")
  DEPLOYER="$(cast wallet address --private-key "$(cat "$PRIVATE_KEY_FILE")")"
else
  die "set ACCOUNT (a cast keystore) or, on testnet, PRIVATE_KEY_FILE"
fi

# ---- parameters, in USDC units (6 decimals) ---------------------------------------------------
# Stellar's fee: max(0.10%, 0.30 USDC), Circle's delivery fee paid out of it, not on top.
FEE_BPS="${FEE_BPS:-10}"
MIN_FEE="${MIN_FEE:-300000}"
MIN_TRANSFER="${MIN_TRANSFER:-1000000}"
# Deliberately low: nothing here is audited. Raising it later takes the 48h timelock.
MAX_TRANSFER="${MAX_TRANSFER:-100000000}"
# How far a Fast transfer's fee may exceed delivery. From Arc, Circle's Fast fee is zero today.
MAX_FAST_FEE_BPS="${MAX_FAST_FEE_BPS:-5}"
PARAMS="($FEE_BPS,$MIN_FEE,$MIN_TRANSFER,$MAX_TRANSFER,$MAX_FAST_FEE_BPS)"

TABLE="$REPO_ROOT/packages/network-config/dist/evm-chains.js"
[ -f "$TABLE" ] || die "build the chain table first: pnpm --filter @xebra/network-config build"
DOMAINS="$(node --input-type=module -e "
  const { EVM_CHAINS, SOLANA_FROM_ARC } = await import('$TABLE');
  const rows = Object.values(EVM_CHAINS)
    .filter((c) => c.id !== 'arc')
    .map((c) => '(' + [c.cctpDomainId, true, c.maxForwardFeeUnits, false, 0].join(',') + ')');
  rows.push('(' + [SOLANA_FROM_ARC.cctpDomainId, false, SOLANA_FROM_ARC.maxForwardFeeUnits, true,
    SOLANA_FROM_ARC.maxForwardFeeNewAccountUnits].join(',') + ')');
  console.log('[' + rows.join(',') + ']');
")"

echo "==> Gate 1/4: the chain"
got="$(cast chain-id --rpc-url "$RPC")" || die "RPC $RPC did not answer"
[ "$got" = "$CHAIN_ID" ] || die "RPC $RPC is chain $got, expected $CHAIN_ID"

echo "==> Gate 2/4: Circle's TokenMessengerV2"
transmitter="$(cast call "$MESSENGER" 'localMessageTransmitter()(address)' --rpc-url "$RPC")"
domain="$(cast call "$transmitter" 'localDomain()(uint32)' --rpc-url "$RPC")"
[ "$domain" = 26 ] || die "the messenger's transmitter reports domain $domain, not 26"
# Circle's messenger is a proxy that names its implementation, as scripts/check-evm-cctp.sh reads it.
impl="$(cast call "$MESSENGER" 'implementation()(address)' --rpc-url "$RPC")"
cast code "$impl" --rpc-url "$RPC" | grep -qi 779b432d \
  || die "depositForBurnWithHook (0x779b432d) is not in the messenger's implementation $impl"

echo "==> Gate 3/4: tests"
(cd "$CONTRACTS" && forge test --match-contract XebraCctpWrapperTest >/dev/null) || die "forge test failed"

echo "==> Gate 4/4: the deployer's USDC"
balance_wei="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
# The testnet deployment used 4,136,823 gas (the constructor writes fifteen destinations); at
# Arc's 20 gwei that is 0.083 USDC. Ask for 0.2, so a rise in the gas price does not strand it.
python3 -c "import sys; sys.exit(0 if int('$balance_wei') >= 2 * 10**17 else 1)" \
  || die "deployer $DEPLOYER holds $(cast from-wei "$balance_wei") USDC; it needs at least 0.2"

cat <<EOF

  network         $NETWORK (chain $CHAIN_ID)
  deployer        $DEPLOYER
  usdc            $USDC
  tokenMessenger  $MESSENGER
  admin           $ADMIN
  pauser          $PAUSER
  feeRecipient    $FEE_RECIPIENT
  params          $PARAMS   (feeBps, minFee, minTransfer, maxTransfer, maxFastFeeBps)
  domains         $DOMAINS
                  (domain, evmStyle, maxForwardFee, accountCreation, maxForwardFeeNewAccount)

EOF

ARGS=(src/XebraCctpWrapper.sol:XebraCctpWrapper --rpc-url "$RPC" "${SIGNER[@]}")
# Last on the line: --constructor-args takes every argument after it.
CTOR=(--constructor-args "$USDC" "$MESSENGER" "$ADMIN" "$PAUSER" "$FEE_RECIPIENT" "$PARAMS" "$DOMAINS")

if [ "${CONFIRM:-}" != "$SENTENCE" ]; then
  echo "==> Dry run (simulated, nothing sent)"
  (cd "$CONTRACTS" && forge create "${ARGS[@]}" "${CTOR[@]}") | grep -v '^\s*[]{}["]' | tail -5
  echo
  echo "To deploy: CONFIRM=\"$SENTENCE\" $0"
  exit 0
fi

echo "==> Deploying"
out="$(cd "$CONTRACTS" && forge create "${ARGS[@]}" --broadcast --json "${CTOR[@]}")"
ADDRESS="$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])')"
TX="$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')"
echo "deployed $ADDRESS in $TX"

echo "==> Reading it back"
[ "$(cast call "$ADDRESS" 'localDomain()(uint32)' --rpc-url "$RPC")" = 26 ] || die "localDomain is not 26"
check_role() {
  local got
  got="$(cast call "$ADDRESS" "$1()(address)" --rpc-url "$RPC")"
  [ "$(echo "$got" | tr A-F a-f)" = "$(echo "$2" | tr A-F a-f)" ] || die "$1 is $got, expected $2"
}
check_role admin "$ADMIN"
check_role pauser "$PAUSER"
check_role feeRecipient "$FEE_RECIPIENT"
count="$(cast call "$ADDRESS" 'getDomains()((uint32,bool,uint256,bool,uint256)[])' --rpc-url "$RPC" | grep -o '(' | wc -l)"
echo "  $count destinations"
CODEHASH="$(cast keccak "$(cast code "$ADDRESS" --rpc-url "$RPC")")"

python3 - "$RECORD" <<PY
import json, os, subprocess, sys, datetime
path = sys.argv[1]
record = json.load(open(path)) if os.path.exists(path) else {}
git = lambda *a: subprocess.run(["git", "-C", "$REPO_ROOT", *a], capture_output=True, text=True).stdout.strip()
record["arcWrapper"] = {
  "address": "$ADDRESS",
  "chainId": $CHAIN_ID,
  "deployTx": "$TX",
  "deployer": "$DEPLOYER",
  "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "gitCommit": git("rev-parse", "HEAD"),
  "gitDirty": bool(git("status", "--porcelain", "--", "contracts/arc-evm/src")),
  "runtimeCodeKeccak": "$CODEHASH",
  "usdc": "$USDC",
  "tokenMessenger": "$MESSENGER",
  "admin": "$ADMIN",
  "pauser": "$PAUSER",
  "feeRecipient": "$FEE_RECIPIENT",
  "params": "$PARAMS",
  "domains": "$DOMAINS",
}
json.dump(record, open(path, "w"), indent=2, sort_keys=True)
open(path, "a").write("\n")
PY
sync
echo "recorded in $RECORD under arcWrapper"
