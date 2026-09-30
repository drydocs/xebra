#!/usr/bin/env bash
#
# Re-verifies, against the live chains, every constant the Stellar -> Arc corridor rests on.
#
# The Arc values in packages/network-config were read from the chain, not from documentation —
# and that mattered: a second set of "Arc CCTP addresses" circulates (0x8FE6…, 0xE737…). Those are
# Arc's *testnet* deployments and have no code on mainnet. This is that reading, written down so
# it can be repeated. Circle can redeploy, and a stale address
# here is a mint sent nowhere.
#
# Asserts:
#   - Arc answers as chain 5042
#   - the pinned TokenMessengerV2 / MessageTransmitterV2 carry code
#   - MessageTransmitterV2.localDomain() == 26 and it is not paused
#   - Arc's TokenMessenger holds Stellar's TokenMessengerMinter as remote domain 27, byte for byte
#   - Stellar's TokenMessenger holds Arc's TokenMessengerV2 as remote domain 26, byte for byte
#   - Arc's TokenMinter maps Stellar USDC to the pinned Arc USDC (a 6-decimal ERC-20)
#   - Circle's Iris prices a 27 -> 26 transfer
#
# Requires `cast` (Foundry), the `stellar` CLI, curl and python3. Read-only: nothing is signed.
#
# Usage:  scripts/check-arc-cctp.sh
# Exits non-zero on any drift.

set -euo pipefail

ARC_RPC="${ARC_RPC_URL:-https://rpc.mainnet.arc.io}"
SOROBAN_RPC="${SOROBAN_RPC_URL:-https://mainnet.sorobanrpc.com}"
PASSPHRASE="Public Global Stellar Network ; September 2015"
IRIS="${IRIS_BASE_URL:-https://iris-api.circle.com}"

# Pinned values — must match packages/network-config/src/networks.ts.
ARC_TOKEN_MESSENGER="0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"
ARC_MESSAGE_TRANSMITTER="0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"
ARC_USDC="0x3600000000000000000000000000000000000000"
STELLAR_TOKEN_MESSENGER="CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL"
STELLAR_USDC="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"

for tool in cast stellar curl python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

fail=0
check() { # name, expected, actual
  if [ "$(echo "$2" | tr 'A-F' 'a-f')" = "$(echo "$3" | tr 'A-F' 'a-f')" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected %s\n        got      %s\n' "$1" "$2" "$3"
    fail=1
  fi
}
call() { cast call "$@" --rpc-url "$ARC_RPC"; }
pad32() { printf '0x%064s' "${1#0x}" | tr ' ' '0'; }
strkey_hex() { stellar strkey decode "$1" | python3 -c 'import sys,json; print("0x"+json.load(sys.stdin)["contract"])'; }

echo "Arc ($ARC_RPC)"
check "chain id is 5042" "5042" "$(cast chain-id --rpc-url "$ARC_RPC")"
for pair in "TokenMessengerV2:$ARC_TOKEN_MESSENGER" "MessageTransmitterV2:$ARC_MESSAGE_TRANSMITTER"; do
  code="$(cast code "${pair#*:}" --rpc-url "$ARC_RPC")"
  check "${pair%%:*} has code" "yes" "$([ "${#code}" -gt 4 ] && echo yes || echo no)"
done
check "MessageTransmitterV2.localDomain() is 26" "26" "$(call "$ARC_MESSAGE_TRANSMITTER" 'localDomain()(uint32)')"
check "MessageTransmitterV2 is not paused" "false" "$(call "$ARC_MESSAGE_TRANSMITTER" 'paused()(bool)')"
check "TokenMessengerV2 points at this MessageTransmitter" "$ARC_MESSAGE_TRANSMITTER" \
  "$(call "$ARC_TOKEN_MESSENGER" 'localMessageTransmitter()(address)')"

stellar_tm_hex="$(strkey_hex "$STELLAR_TOKEN_MESSENGER")"
stellar_usdc_hex="$(strkey_hex "$STELLAR_USDC")"
check "Arc knows Stellar's TokenMessenger as domain 27" "$stellar_tm_hex" \
  "$(call "$ARC_TOKEN_MESSENGER" 'remoteTokenMessengers(uint32)(bytes32)' 27)"

minter="$(call "$ARC_TOKEN_MESSENGER" 'localMinter()(address)')"
check "TokenMinter maps Stellar USDC to Arc USDC" "$ARC_USDC" \
  "$(call "$minter" 'getLocalToken(uint32,bytes32)(address)' 27 "$stellar_usdc_hex")"
check "Arc USDC has 6 decimals" "6" "$(call "$ARC_USDC" 'decimals()(uint8)' | awk '{print $1}')"

echo "Stellar ($SOROBAN_RPC)"
stellar_remote="$(stellar contract invoke --id "$STELLAR_TOKEN_MESSENGER" \
  --rpc-url "$SOROBAN_RPC" --network-passphrase "$PASSPHRASE" \
  --source-account "${STELLAR_READ_ACCOUNT:-alice}" --send no \
  -- get_remote_token_messenger --domain 26 | tr -d '"')"
check "Stellar knows Arc's TokenMessengerV2 as domain 26 (left-padded)" "$(pad32 "$ARC_TOKEN_MESSENGER")" "0x$stellar_remote"

echo "Iris ($IRIS)"
fees="$(curl -fsS -m 20 "$IRIS/v2/burn/USDC/fees/27/26")"
check "Iris quotes 27 -> 26 for both finality thresholds" "2" \
  "$(echo "$fees" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"

if [ "$fail" -ne 0 ]; then
  echo; echo "DRIFT: at least one Arc corridor constant no longer matches the chain." >&2
  echo "Do not deploy. Re-read the values and update packages/network-config." >&2
  exit 1
fi
echo; echo "Arc corridor constants agree with the live chains."
