#!/usr/bin/env bash
#
# Guards the highest-severity risk in contracts/stellar-cctp-wrapper: that our declared
# `TokenMessenger` trait drifts from Circle's deployed TokenMessengerMinter.
#
# `deposit_for_burn` takes two `i128`s (`amount`, `max_fee`) and two `BytesN<32>`s
# (`mint_recipient`, `destination_caller`). Transposing either pair compiles, deploys, and
# destroys funds — nothing else in the build catches it. This does.
#
# Fetches the live contract spec and asserts the deposit_for_burn parameter list matches,
# name-for-name and in order, what src/lib.rs declares.
#
# Usage:
#   scripts/check-cctp-interface.sh                 # mainnet (default)
#   NETWORK=testnet scripts/check-cctp-interface.sh
#
# Exits non-zero on any drift. Intended to run in CI on every PR touching the wrapper, and
# on a schedule so a Circle redeploy is noticed before a user finds it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.production"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 2; }

# Mainnet-only build: the contract id, RPC and passphrase all come from the single env file.
set -a
# shellcheck disable=SC1090
. <(grep -E '^[A-Z0-9_]+=' "$ENV_FILE" | sed 's/^\([A-Z0-9_]*\)=\(.*\)$/\1="\2"/')
set +a

if [ "${NETWORK:-}" != "mainnet" ]; then
  echo "FAIL: $ENV_FILE declares NETWORK=${NETWORK:-unset}; this is a mainnet-only build" >&2
  exit 2
fi

CONTRACT_ID="$STELLAR_TOKEN_MESSENGER_ADDRESS"
RPC_URL="$SOROBAN_RPC_URL"
PASSPHRASE="$STELLAR_NETWORK_PASSPHRASE"
NETWORK=mainnet

LIB_RS="$REPO_ROOT/contracts/stellar-cctp-wrapper/src/lib.rs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching live spec for $CONTRACT_ID on $NETWORK ..."
stellar contract info interface \
  --id "$CONTRACT_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$PASSPHRASE" \
  > "$WORK/live.rs"

# The deployed spec renders as `fn deposit_for_burn(\n  env: ...,\n  caller: ...,\n ... );`
# Extract the parameter names in order, dropping the env argument.
extract_params() {
  awk '
    /fn deposit_for_burn\(/ { collecting = 1; next }
    collecting && /^\s*\)/  { exit }
    collecting {
      # "        caller: soroban_sdk::Address," -> "caller"
      gsub(/^[ \t]+/, "")
      split($0, parts, ":")
      name = parts[1]
      if (name != "env" && name != "e" && name != "") print name
    }
  ' "$1"
}

extract_params "$WORK/live.rs"  > "$WORK/live.params"
extract_params "$LIB_RS"        > "$WORK/ours.params"

if [ ! -s "$WORK/live.params" ]; then
  echo "FAIL: could not find deposit_for_burn in the live spec." >&2
  exit 1
fi
if [ ! -s "$WORK/ours.params" ]; then
  echo "FAIL: could not find deposit_for_burn in $LIB_RS." >&2
  exit 1
fi

if diff -u "$WORK/ours.params" "$WORK/live.params" > "$WORK/diff.txt"; then
  echo "OK: deposit_for_burn signature matches the live $NETWORK contract."
  echo "    parameters: $(paste -sd, "$WORK/live.params")"
  exit 0
fi

cat >&2 <<EOF

FAIL: our TokenMessenger trait has DRIFTED from the live $NETWORK contract.

  ours (contracts/stellar-cctp-wrapper/src/lib.rs)  vs  live ($CONTRACT_ID)

$(cat "$WORK/diff.txt")

Do NOT "fix" this by editing lib.rs to match until you understand why it changed.
A reordered or renamed parameter means every burn this contract makes is now passing
values into the wrong slots. Pause the wrapper first, then investigate.
EOF
exit 1
