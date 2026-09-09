#!/usr/bin/env bash
#
# Deploys contracts/stellar-cctp-wrapper and records the result in deployments/<network>.json.
#
# The repo previously had no Soroban deploy tooling at all — the escrow was deployed by
# pasting a snippet from its README, which is why no committed record of any deployment
# exists. This script is the replacement: reproducible, gated, and it writes down what it did.
#
# Gates, in order, before anything is broadcast:
#   1. The CCTP interface check passes against the target network's live TokenMessengerMinter.
#   2. The contract's own test suite passes.
#   3. A release wasm builds.
#   4. For mainnet, an explicit typed confirmation.
#
# Usage:
#   NETWORK=testnet SOURCE=my-identity ./scripts/deploy-cctp-wrapper.sh
#   NETWORK=mainnet SOURCE=deployer FEE_BPS=10 MIN_FEE=3000000 ... ./scripts/deploy-cctp-wrapper.sh
#
# Required env for a real deploy: ADMIN, PAUSER, FEE_RECIPIENT (Stellar addresses).
# ADMIN and PAUSER must be different keys held by different operators — the script warns
# loudly if they match, because a pauser that is also the admin removes the only check on a
# compromised admin key.

set -euo pipefail

# Resolved from this script's own location, so it works from any working directory. These were
# referenced throughout and never assigned, which under `set -u` killed the script on its first
# line — this has never successfully run.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$REPO_ROOT/contracts/stellar-cctp-wrapper"
WASM="$CRATE_DIR/target/wasm32v1-none/release/xebra_cctp_wrapper.wasm"

# Mainnet-only build. There is one env file and one network.
ENV_FILE="$REPO_ROOT/.env.production"
[ -f "$ENV_FILE" ] || { echo "missing env file: $ENV_FILE" >&2; exit 2; }

set -a
# shellcheck disable=SC1090
. <(grep -E '^[A-Z0-9_]+=' "$ENV_FILE" | sed 's/^\([A-Z0-9_]*\)=\(.*\)$/\1="\2"/')
set +a

if [ "${NETWORK:-}" != "mainnet" ]; then
  echo "FAIL: $ENV_FILE declares NETWORK=${NETWORK:-unset}; this is a mainnet-only build" >&2
  exit 2
fi

RPC_URL="$SOROBAN_RPC_URL"
PASSPHRASE="$STELLAR_NETWORK_PASSPHRASE"
USDC="$STELLAR_USDC_ADDRESS"
MESSENGER="$STELLAR_TOKEN_MESSENGER_ADDRESS"

# Parameters, in 7-decimal stroops. Defaults are conservative starting values; the min_fee
# should be derived from measured Solana mint gas cost before any real launch.
FEE_BPS="${FEE_BPS:-10}"              # 0.10%
# Covers the ~872,621 lamports every sponsored mint costs (used_nonce rent, which nobody can
# ever reclaim, plus the transaction fee), with headroom for SOL moving against us. At $300 SOL
# that cost is about $0.26, so this is thin — raise it if SOL runs higher.
MIN_FEE="${MIN_FEE:-3000000}"         # 0.30 USDC
# Only first-time recipients pay this: creating their token account costs a further 2,039,280
# lamports, also unreclaimable. Kept separate from MIN_FEE so repeat users are not charged for a
# cost they do not cause.
ACCOUNT_FEE="${ACCOUNT_FEE:-7000000}" # 0.70 USDC
MIN_TRANSFER="${MIN_TRANSFER:-100000000}"      # 10 USDC
# Circle's own live per-message cap for USDC. Effectively no ceiling of ours — which also means
# no bound on the damage from a bug nobody has found. Set this low for the first transfers and
# raise it as clean ones accumulate; that is what it is for.
MAX_TRANSFER="${MAX_TRANSFER:-100000000000000}"  # 10M USDC
MAX_CCTP_FEE_BPS="${MAX_CCTP_FEE_BPS:-20}"

die() { echo "FAIL: $*" >&2; exit 1; }

[ -n "${SOURCE:-}" ]    || die "SOURCE (stellar CLI identity) is required"
[ -n "${ADMIN:-}" ]     || die "ADMIN is required"
[ -n "${PAUSER:-}" ]    || die "PAUSER is required"
[ -n "${FEE_RECIPIENT:-}" ] || die "FEE_RECIPIENT is required"
[ -n "$USDC" ]          || die "STELLAR_USDC_ADDRESS is empty in $ENV_FILE"
[ -n "$MESSENGER" ]     || die "STELLAR_TOKEN_MESSENGER_ADDRESS is empty in $ENV_FILE"

if [ "$ADMIN" = "$PAUSER" ]; then
  echo "WARNING: ADMIN and PAUSER are the same address." >&2
  echo "  The pauser exists so a compromised admin can still be stopped by someone else." >&2
  echo "  Set them to different keys held by different operators before a real launch." >&2
fi

echo "==> Gate 1/4: CCTP interface drift check (mainnet)"
"$REPO_ROOT/scripts/check-cctp-interface.sh" \
  || die "interface check failed — do NOT deploy against a drifted TokenMessengerMinter"

echo "==> Gate 2/4: contract test suite"
( cd "$CRATE_DIR" && cargo test --quiet ) || die "tests failed"

echo "==> Gate 3/4: release wasm build"
( cd "$CRATE_DIR" && cargo build --release --target wasm32v1-none ) || die "wasm build failed"
[ -f "$WASM" ] || die "expected wasm at $WASM"
echo "    $(wc -c < "$WASM") bytes unoptimized"

# wasm-opt on top of the already size-tuned release profile. Not cosmetic: the upload fee scales
# with the code entry's size, and on mainnet this measured 55,587 -> 42,100 bytes, taking the
# simulated upload from 67.92 XLM to 50.81. Deploying the unoptimized binary means paying 17 XLM
# for nothing, and paying it again on every rent extension for the life of the contract.
echo "==> Gate 3b/4: optimize"
stellar contract optimize --wasm "$WASM" >/dev/null 2>&1 || die "wasm-opt failed"
OPTIMIZED="${WASM%.wasm}.optimized.wasm"
[ -f "$OPTIMIZED" ] || die "expected optimized wasm at $OPTIMIZED"
WASM="$OPTIMIZED"
echo "    $(wc -c < "$WASM") bytes optimized"

if true; then
  echo
  echo "==> Gate 4/4: mainnet confirmation"
  echo "    usdc            $USDC"
  echo "    token_messenger $MESSENGER   (IMMUTABLE once deployed)"
  echo "    admin           $ADMIN"
  echo "    pauser          $PAUSER"
  echo "    fee_recipient   $FEE_RECIPIENT"
  echo "    fee_bps         $FEE_BPS"
  echo "    min_fee         $MIN_FEE"
  echo "    account_fee     $ACCOUNT_FEE"
  echo "    min_transfer    $MIN_TRANSFER"
  echo "    max_transfer    $MAX_TRANSFER"
  echo "    max_cctp_fee_bps $MAX_CCTP_FEE_BPS"
  echo
  echo "  usdc and token_messenger cannot be changed after deployment. There is no upgrade"
  echo "  entrypoint. Getting either wrong means redeploying."
  echo
  read -r -p "  Type 'deploy to mainnet' to continue: " confirm
  [ "$confirm" = "deploy to mainnet" ] || die "aborted"
fi

echo "==> Deploying"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source-account "$SOURCE" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$PASSPHRASE" \
  -- \
  --usdc "$USDC" \
  --token_messenger "$MESSENGER" \
  --admin "$ADMIN" \
  --pauser "$PAUSER" \
  --fee_recipient "$FEE_RECIPIENT" \
  --params "{\"fee_bps\":$FEE_BPS,\"min_fee\":\"$MIN_FEE\",\"min_transfer\":\"$MIN_TRANSFER\",\"max_transfer\":\"$MAX_TRANSFER\",\"max_cctp_fee_bps\":$MAX_CCTP_FEE_BPS,\"account_fee\":\"$ACCOUNT_FEE\"}" \
  --domains '[{"domain":5,"evm_style":false}]' \
  | tail -1)"

[ -n "$CONTRACT_ID" ] || die "deploy produced no contract id"
echo "    deployed: $CONTRACT_ID"

mkdir -p "$REPO_ROOT/deployments"
RECORD="$REPO_ROOT/deployments/mainnet.json"
WASM_HASH="$(sha256sum "$WASM" | cut -d' ' -f1)"

# The recorder reads these from the environment, so they must be exported, not just set.
export USDC_OUT="$USDC" MESSENGER_OUT="$MESSENGER"
export ADMIN PAUSER FEE_RECIPIENT FEE_BPS MIN_FEE ACCOUNT_FEE MIN_TRANSFER MAX_TRANSFER MAX_CCTP_FEE_BPS

python3 - "$RECORD" "$CONTRACT_ID" "$WASM_HASH" <<PYEOF
import json, os, subprocess, sys, datetime
path, contract_id, wasm_hash = sys.argv[1], sys.argv[2], sys.argv[3]
rec = json.load(open(path)) if os.path.exists(path) else {}
rec["cctpWrapper"] = {
    "contractId": contract_id,
    "wasmSha256": wasm_hash,
    "gitCommit": subprocess.check_output(["git","rev-parse","HEAD"]).decode().strip(),
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "usdc": os.environ["USDC_OUT"],
    "tokenMessenger": os.environ["MESSENGER_OUT"],
    "admin": os.environ["ADMIN"],
    "pauser": os.environ["PAUSER"],
    "feeRecipient": os.environ["FEE_RECIPIENT"],
    "params": {
        "feeBps": int(os.environ["FEE_BPS"]),
        "minFee": os.environ["MIN_FEE"],
        "accountFee": os.environ["ACCOUNT_FEE"],
        "minTransfer": os.environ["MIN_TRANSFER"],
        "maxTransfer": os.environ["MAX_TRANSFER"],
        "maxCctpFeeBps": int(os.environ["MAX_CCTP_FEE_BPS"]),
    },
}
json.dump(rec, open(path,"w"), indent=2, sort_keys=True)
open(path,"a").write("\n")
print("recorded in", path)
PYEOF

echo
echo "==> Next steps (none of these are optional before real money):"
echo "    1. Set SOROBAN_CCTP_WRAPPER_CONTRACT_ID=$CONTRACT_ID for indexer-stellar."
echo "    2. Run one small-value bridge and confirm it mints on the destination chain."
echo "    3. Confirm a REAL wallet (Freighter) can produce the auth tree — mock_all_auths()"
echo "       in the test suite does not prove this."
echo "    4. Commit deployments/mainnet.json."
