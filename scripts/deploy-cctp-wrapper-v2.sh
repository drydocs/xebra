#!/usr/bin/env bash
#
# Deploys contracts/stellar-cctp-wrapper-v2 (Circle Forwarding Service wrapper) to Stellar MAINNET and
# records it in deployments/mainnet.json under `cctpWrapperV2`. v1's entry (`cctpWrapper`) is left
# untouched: v1 stays live until the web app is cut over.
#
# Default is a DRY RUN. It runs every gate, prints the exact constructor arguments, and validates the
# transaction by BUILDING it (`--build-only`), which encodes the arguments against the wasm's own
# spec and fails on any wrong shape. It sends nothing. To deploy, set
#     CONFIRM="deploy v2 to mainnet"
#
# Gates, in order:
#   1. Circle's live TokenMessengerMinter still has the burn signatures the wrapper calls
#      (`deposit_for_burn`, and `deposit_for_burn_with_hook` which forwarding uses).
#   2. The v2 test suite passes.
#   3. A release wasm builds and is optimized (rent, and so cost, scales with its size).
#   4. The deployer holds enough XLM (the simulated upload plus instantiation plus a reserve).
#   5. Typed confirmation.
#
# `usdc` and `token_messenger` are IMMUTABLE after deploy: no upgrade entrypoint exists. A wrong value
# means redeploying, which means paying the upload again.
#
# Usage:
#   ./scripts/deploy-cctp-wrapper-v2.sh                              # dry run
#   CONFIRM="deploy v2 to mainnet" ./scripts/deploy-cctp-wrapper-v2.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$REPO_ROOT/contracts/stellar-cctp-wrapper-v2"
V1_TARGET="$REPO_ROOT/contracts/stellar-cctp-wrapper/target"
RECORD="$REPO_ROOT/deployments/mainnet.json"

RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
HORIZON="${HORIZON_URL:-https://horizon.stellar.org}"
PASS="Public Global Stellar Network ; September 2015"
SOURCE="${SOURCE:-xebra-deployer}"
SENTENCE="deploy v2 to mainnet"

# Circle's mainnet contracts, pinned in deployments/mainnet.json by the v1 deploy.
USDC="$(python3 -c "import json;print(json.load(open('$RECORD'))['cctpWrapper']['usdc'])")"
MESSENGER="$(python3 -c "import json;print(json.load(open('$RECORD'))['cctpWrapper']['tokenMessenger'])")"
ADMIN="$(python3 -c "import json;print(json.load(open('$RECORD'))['cctpWrapper']['admin'])")"
PAUSER="$(python3 -c "import json;print(json.load(open('$RECORD'))['cctpWrapper']['pauser'])")"
FEE_RECIPIENT="$(python3 -c "import json;print(json.load(open('$RECORD'))['cctpWrapper']['feeRecipient'])")"

# ---- parameters, in 7-decimal stroops (1 USDC = 10,000,000) ------------------------------------
# Our fee: max(0.10%, 0.30 USDC). Delivery (Circle's forward fee) is paid out of it, not on top.
FEE_BPS="${FEE_BPS:-10}"
MIN_FEE="${MIN_FEE:-3000000}"                     # 0.30 USDC
# The contract refuses a min_transfer below MIN_TRANSFER_FLOOR, 1 USDC in v2 (v1's was 10). Note that a
# small transfer to Solana is still refused by the forward-fee bound (delivery fee <= a tenth of the
# burn): about 2 USDC or more to an existing token account, about 4 USDC to a new wallet.
MIN_TRANSFER="${MIN_TRANSFER:-10000000}"          # 1 USDC
# Deliberately low: nothing here is audited. Loosening it later goes through the 48h timelock;
# lowering it is instant, so starting low costs a wait, starting high costs exposure.
MAX_TRANSFER="${MAX_TRANSFER:-1000000000}"        # 100 USDC
MAX_CCTP_FEE_BPS="${MAX_CCTP_FEE_BPS:-20}"
# Only used by the plain (non-forwarded) path, which the web app no longer offers.
ACCOUNT_FEE="${ACCOUNT_FEE:-0}"

# Domains are set here, at deploy, because adding one afterwards goes through the 48h timelock.
# Caps sit a comfortable margin above Circle's live `high` quote (mainnet, this week): Arc about
# 0.022 USDC, Solana about 0.18 (existing account) or 0.35 (account created).
ARC_MAX_FORWARD_FEE="${ARC_MAX_FORWARD_FEE:-1000000}"            # 0.10 USDC
SOL_MAX_FORWARD_FEE="${SOL_MAX_FORWARD_FEE:-2500000}"            # 0.25 USDC
SOL_MAX_FORWARD_FEE_NEW_ACCOUNT="${SOL_MAX_FORWARD_FEE_NEW_ACCOUNT:-4500000}"  # 0.45 USDC

PARAMS="{\"fee_bps\":$FEE_BPS,\"min_fee\":\"$MIN_FEE\",\"min_transfer\":\"$MIN_TRANSFER\",\"max_transfer\":\"$MAX_TRANSFER\",\"max_cctp_fee_bps\":$MAX_CCTP_FEE_BPS,\"account_fee\":\"$ACCOUNT_FEE\"}"
DOMAINS="[{\"domain\":5,\"evm_style\":false,\"forward\":true,\"max_forward_fee\":\"$SOL_MAX_FORWARD_FEE\",\"account_creation\":true,\"max_forward_fee_new_account\":\"$SOL_MAX_FORWARD_FEE_NEW_ACCOUNT\"},{\"domain\":26,\"evm_style\":true,\"forward\":true,\"max_forward_fee\":\"$ARC_MAX_FORWARD_FEE\",\"account_creation\":false,\"max_forward_fee_new_account\":\"0\"}]"

die() { echo "FAIL: $*" >&2; exit 1; }

DEPLOYER="$(stellar keys address "$SOURCE")" || die "no stellar identity named $SOURCE"
[ "$ADMIN" != "$PAUSER" ] || die "admin and pauser are the same address"

echo "==> Gate 1/4: Circle's live TokenMessengerMinter"
"$SCRIPT_DIR/check-cctp-interface.sh" >/dev/null || die "deposit_for_burn drifted from the live contract"
LIVE="$(stellar contract info interface --id "$MESSENGER" --rpc-url "$RPC" --network-passphrase "$PASS" 2>/dev/null)"
for want in "caller: soroban_sdk::Address" "hook_data: soroban_sdk::Bytes" "min_finality_threshold: u32"; do
  echo "$LIVE" | grep -A12 "fn deposit_for_burn_with_hook" | grep -q "$want" \
    || die "deposit_for_burn_with_hook no longer has '$want'"
done
echo "    deposit_for_burn and deposit_for_burn_with_hook match"

echo "==> Gate 2/4: v2 test suite"
( cd "$CRATE_DIR" && CARGO_TARGET_DIR="$V1_TARGET" cargo test --quiet 2>&1 | tail -3 ) || die "tests failed"

echo "==> Gate 3/4: release wasm, optimized"
( cd "$CRATE_DIR" && CARGO_TARGET_DIR="$V1_TARGET" cargo build --release --target wasm32v1-none --quiet ) || die "wasm build failed"
WASM="$V1_TARGET/wasm32v1-none/release/xebra_cctp_wrapper_v2.wasm"
stellar contract optimize --wasm "$WASM" >/dev/null 2>&1 || die "wasm-opt failed"
OPT="${WASM%.wasm}.optimized.wasm"
[ -f "$OPT" ] || die "no optimized wasm at $OPT"
WASM_SHA="$(sha256sum "$OPT" | cut -d' ' -f1)"
echo "    $(wc -c <"$OPT") bytes, sha256 $WASM_SHA"

echo "==> Gate 4/4: the deployer can pay"
BAL="$(curl -s -m 20 -A curl/8 "$HORIZON/accounts/$DEPLOYER" | python3 -c "import sys,json;print(next(b['balance'] for b in json.load(sys.stdin)['balances'] if b['asset_type']=='native'))")"
echo "    $SOURCE ($DEPLOYER) holds $BAL XLM"
python3 -c "import sys; sys.exit(0 if float('$BAL') >= 64.0 else 1)" || die "the deployer needs about 64 XLM (run scripts/dry-run-deploy-v2.sh for the live figure)"

echo
echo "==> Constructor arguments"
echo "    usdc             $USDC"
echo "    token_messenger  $MESSENGER   (IMMUTABLE)"
echo "    admin            $ADMIN"
echo "    pauser           $PAUSER"
echo "    fee_recipient    $FEE_RECIPIENT"
echo "    params           $PARAMS"
echo "    domains          $DOMAINS"
echo

# Build (do not send) the deploy transaction. This encodes every argument against the wasm's own
# spec, so a wrong field type or name fails here instead of after the upload is paid for.
DEPLOY_ARGS=(
  --usdc "$USDC"
  --token_messenger "$MESSENGER"
  --admin "$ADMIN"
  --pauser "$PAUSER"
  --fee_recipient "$FEE_RECIPIENT"
  --params "$PARAMS"
  --domains "$DOMAINS"
)
echo "==> Validating the arguments against the contract's spec (builds, sends nothing)"
if ! stellar contract deploy --wasm "$OPT" --source-account "$DEPLOYER" --rpc-url "$RPC" \
     --network-passphrase "$PASS" --build-only -- "${DEPLOY_ARGS[@]}" >/dev/null 2>"${TMPDIR:-/tmp}/v2-deploy-validate.err"; then
  cat "${TMPDIR:-/tmp}/v2-deploy-validate.err" >&2
  die "the constructor arguments do not encode"
fi
echo "    arguments encode"

if [ "${CONFIRM:-}" != "$SENTENCE" ]; then
  echo
  echo "(dry run: nothing sent)  Deploy with CONFIRM=\"$SENTENCE\""
  exit 0
fi

echo
echo "==> Deploying (this spends about 63 XLM and cannot be undone)"
# Bid ceiling for inclusion, not a charge: the market rate is charged up to it. The CLI default is the
# network minimum, which is not a bid at all and is what got the first mainnet attempt dropped.
INCLUSION_FEE="${INCLUSION_FEE:-10000000}"
CONTRACT_ID="$(stellar contract deploy --wasm "$OPT" --inclusion-fee "$INCLUSION_FEE" \
  --source-account "$SOURCE" --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- "${DEPLOY_ARGS[@]}" | tail -1)"
[ -n "$CONTRACT_ID" ] || die "deploy produced no contract id"
echo "    deployed: $CONTRACT_ID"

# The work is often deployed from an uncommitted tree, so `gitCommit` alone can point at code that is not
# what was deployed. The wasm hash pins the binary; this pins the source that built it.
SOURCE_SHA="$(cd "$CRATE_DIR" && find src Cargo.toml Cargo.lock -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
export SOURCE_SHA CONTRACT_ID WASM_SHA USDC MESSENGER ADMIN PAUSER FEE_RECIPIENT PARAMS DOMAINS
python3 - "$RECORD" <<'PYEOF'
import datetime, json, os, subprocess, sys
path = sys.argv[1]
rec = json.load(open(path))
rec["cctpWrapperV2"] = {
    "contractId": os.environ["CONTRACT_ID"],
    "wasmSha256": os.environ["WASM_SHA"],
    "sourceSha256": os.environ["SOURCE_SHA"],
    "gitCommit": subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip(),
    "gitDirty": bool(subprocess.check_output(["git", "status", "--porcelain"]).decode().strip()),
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "usdc": os.environ["USDC"],
    "tokenMessenger": os.environ["MESSENGER"],
    "admin": os.environ["ADMIN"],
    "pauser": os.environ["PAUSER"],
    "feeRecipient": os.environ["FEE_RECIPIENT"],
    "params": json.loads(os.environ["PARAMS"]),
    "domains": json.loads(os.environ["DOMAINS"]),
}
json.dump(rec, open(path, "w"), indent=2, sort_keys=True)
open(path, "a").write("\n")
print("recorded in", path, "under cctpWrapperV2")
PYEOF

echo
echo "==> Next (not optional before real money):"
echo "    1. Read the contract back: get_params, get_domains, and confirm admin/pauser/fee_recipient."
echo "    2. One real transfer to Arc, then one to Solana (existing account), then one to a new wallet."
echo "    3. Only then set NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID and deploy the web app."
