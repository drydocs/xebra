#!/usr/bin/env bash
#
# What would deploying wrapper v2 to mainnet cost, right now? Broadcasts nothing.
#
# Builds and optimizes the v2 wasm, builds an UNSIGNED upload transaction with `--build-only`, and
# asks Soroban RPC to simulate it. There is no signing step in this script and the deployer's key is
# never read: only its public address is used as the transaction's source.
#
# Prints the upload fee, the deployer's balance and the shortfall, and the rent slope (what keeping
# the code alive costs per month), measured from an extension simulation on v1's code that is already
# on chain.
#
# Why simulate the upload and not read a formula: the fee is rent for the code entry over the
# minimum persistent lifetime plus write fees, both set by network settings validators can change.
# The number moves; this reads it live.
#
# Usage:  DEPLOYER=xebra-deployer ./scripts/dry-run-deploy-v2.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V1_TARGET="$REPO_ROOT/contracts/stellar-cctp-wrapper/target"
CRATE_V2="$REPO_ROOT/contracts/stellar-cctp-wrapper-v2"
DEPLOYER="${DEPLOYER:-xebra-deployer}"
RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
HORIZON="${HORIZON_URL:-https://horizon.stellar.org}"
PASS="Public Global Stellar Network ; September 2015"
# v1's WASM as pinned in deployments/mainnet.json, already on chain, so extending it can be
# simulated to measure the rent rate.
V1_HASH="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/mainnet.json'))['cctpWrapper']['wasmSha256'])")"

die() { echo "FAIL: $*" >&2; exit 1; }

OUT="$REPO_ROOT/.secrets/dryrun"
mkdir -p "$OUT"
DEP_ADDR="$(stellar keys address "$DEPLOYER")" || die "no stellar identity named $DEPLOYER"

echo "==> build v2 (reusing v1's target dir for the compiled Soroban SDK)"
( cd "$CRATE_V2" && CARGO_TARGET_DIR="$V1_TARGET" cargo build --release --target wasm32v1-none --quiet )
WASM="$V1_TARGET/wasm32v1-none/release/xebra_cctp_wrapper_v2.wasm"
[ -f "$WASM" ] || die "no wasm at $WASM"
stellar contract optimize --wasm "$WASM" >/dev/null 2>&1 || die "wasm-opt failed"
OPT="${WASM%.wasm}.optimized.wasm"
echo "    $(wc -c <"$OPT") bytes optimized, sha256 $(sha256sum "$OPT" | cut -d' ' -f1)"

echo "==> simulate the upload (unsigned, nothing is sent)"
stellar contract upload --wasm "$OPT" --source-account "$DEP_ADDR" --rpc-url "$RPC" \
  --network-passphrase "$PASS" --build-only 2>/dev/null >"$OUT/upload-v2.xdr" || die "could not build the upload tx"
[ -s "$OUT/upload-v2.xdr" ] || die "empty upload tx"

sim() { # $1 = xdr file -> prints minResourceFee in stroops, dies on a simulation error
  python3 - "$1" "$RPC" <<'EOF'
import json, sys, urllib.request
xdr = open(sys.argv[1]).read().strip()
req = urllib.request.Request(sys.argv[2], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "simulateTransaction", "params": {"transaction": xdr}}).encode(), headers={"content-type": "application/json", "user-agent": "curl/8"})
r = json.load(urllib.request.urlopen(req, timeout=60)).get("result", {})
if r.get("error"): sys.exit("simulation error: " + str(r["error"]))
print(r["minResourceFee"])
EOF
}
UPLOAD_STROOPS="$(sim "$OUT/upload-v2.xdr")" || die "upload simulation failed"

echo "==> measure the rent slope on v1's code (already on chain)"
ext() { # $1 = ledgers -> stroops
  stellar contract extend --wasm-hash "$V1_HASH" --ledgers-to-extend "$1" --durability persistent \
    --source-account "$DEP_ADDR" --rpc-url "$RPC" --network-passphrase "$PASS" --build-only 2>/dev/null >"$OUT/ext.xdr"
  sim "$OUT/ext.xdr"
}
A="$(ext 2500000)"; B="$(ext 3100000)"
V1_BYTES="$(python3 -c "import os;print(os.path.getsize('$V1_TARGET/wasm32v1-none/release/xebra_cctp_wrapper.optimized.wasm'))")"

BAL="$(curl -s -m 20 -A curl/8 "$HORIZON/accounts/$DEP_ADDR" | python3 -c "import sys,json;print(next(b['balance'] for b in json.load(sys.stdin)['balances'] if b['asset_type']=='native'))")"

python3 - "$UPLOAD_STROOPS" "$A" "$B" "$V1_BYTES" "$(wc -c <"$OPT")" "$BAL" "$DEP_ADDR" <<'EOF'
import sys
upload, a, b, v1b, v2b, bal, addr = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), sys.argv[7]
X = 1e7
# stroops per ledger for the v1 code, scaled to v2's size (rent is roughly linear in entry size)
slope_v1 = (b - a) / 600_000
slope_v2 = slope_v1 * v2b / v1b
LEDGERS_PER_MONTH = 17_280 * 30
create = 0.25 * X   # v1's real mainnet instantiation charged 0.18 XLM; v2 stores a little more
reserve = 1.0 * X   # keep the deployer account itself alive
need = (upload + create + reserve) / X
print()
print(f"  upload (code entry, rent for its minimum lifetime + writes)   {upload / X:8.2f} XLM   simulated")
print(f"  instantiate (constructor)                                     {create / X:8.2f} XLM   v1 charged 0.18")
print(f"  keep the deployer account alive                               {reserve / X:8.2f} XLM")
print(f"  needed on the deployer                                        {need:8.2f} XLM")
print(f"  {addr[:8]}... holds                                       {bal:8.2f} XLM")
print(f"  {'SHORT BY' if bal < need else 'surplus  '}                                                     {abs(bal - need):8.2f} XLM")
print()
print(f"  upkeep: v2 code rent about {slope_v2 * LEDGERS_PER_MONTH / X:.1f} XLM per month "
      f"(v1's is {slope_v1 * LEDGERS_PER_MONTH / X:.1f}; rent scales with wasm size)")
print("  anyone can pay an extension; the code is archived (restorable, not lost) if none is paid.")
EOF
