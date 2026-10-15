#!/usr/bin/env bash
#
# Reads and governs the deployed XebraCctpWrapper on Arc, until /admin has an EVM section.
#
# `status` only reads. Every other command sends a transaction signed by a cast keystore (ACCOUNT),
# and shows what it will send and asks for "yes" first. The contract decides who may do what:
#   admin   everything below
#   pauser  pause, cancel, tighten-domain, remove-domain
# Loosening anything is propose now, commit 48 hours later; tightening is instant.
#
# Usage:
#   NETWORK=mainnet scripts/arc-wrapper-admin.sh status
#   NETWORK=mainnet ACCOUNT=xebra-arc-pauser scripts/arc-wrapper-admin.sh pause
#   … unpause | withdraw <units> | cancel
#   … propose-domain <domain> <evmStyle> <maxForwardFee> <accountCreation> <maxForwardFeeNewAccount>
#   … commit-domain | tighten-domain <domain> <maxForwardFee> <accountCreation> <newAccountCap>
#   … remove-domain <domain>
#   … propose-params <feeBps> <minFee> <minTransfer> <maxTransfer> <maxFastFeeBps> | commit-params
#   … tighten-params <same five>
#   … propose-admin <addr> | accept-admin | propose-pauser <addr> | commit-pauser
#   … propose-fee-recipient <addr> | commit-fee-recipient
# Amounts are USDC units (6 decimals): 250000 is 0.25 USDC.
# PRIVATE_KEY_FILE (a file holding the key, readable by you only) may stand in for ACCOUNT.

set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK="${NETWORK:-mainnet}"
case "$NETWORK" in
  mainnet) RPC="${ARC_RPC_URL:-https://rpc.mainnet.arc.io}" ;;
  testnet) RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}" ;;
  *) echo "NETWORK must be mainnet or testnet" >&2; exit 1 ;;
esac
W="${WRAPPER:-$(python3 -c "import json;print(json.load(open('$REPO_ROOT/deployments/$NETWORK.json'))['arcWrapper']['address'])")}"

DOMAIN_T='(uint32,bool,uint256,bool,uint256)'
PARAMS_T='(uint16,uint256,uint256,uint256,uint16)'
call() { cast call "$W" "$@" --rpc-url "$RPC"; }

status() {
  echo "wrapper      $W ($NETWORK)"
  echo "admin        $(call 'admin()(address)')"
  echo "pauser       $(call 'pauser()(address)')"
  echo "feeRecipient $(call 'feeRecipient()(address)')"
  echo "paused       $(call 'paused()(bool)')"
  echo "accrued      $(call 'accruedFees()(uint256)')   USDC held $(cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' "$W" --rpc-url "$RPC")"
  echo "transfers    $(call 'seq()(uint64)')"
  echo "params       $(call "getParams()$PARAMS_T")   (feeBps, minFee, minTransfer, maxTransfer, maxFastFeeBps)"
  echo "domains      (domain, evmStyle, maxForwardFee, accountCreation, maxForwardFeeNewAccount)"
  call "getDomains()($DOMAIN_T[])" | tr -d '[]' | sed 's/), (/)\n(/g' | sed 's/^/             /'
  echo "pending      params        $(call "pendingParams()(($PARAMS_T,uint64))")"
  echo "             admin         $(call 'pendingAdmin()((address,uint64))')"
  echo "             pauser        $(call 'pendingPauser()((address,uint64))')"
  echo "             feeRecipient  $(call 'pendingFeeRecipient()((address,uint64))')"
  echo "             domain        $(call "pendingDomain()(($DOMAIN_T,uint64))")"
  echo "             (an eta of 0 means nothing pending; commit from the eta on)"
}

send() {
  local signer
  if [ -n "${ACCOUNT:-}" ]; then
    signer=(--account "$ACCOUNT")
  elif [ -n "${PRIVATE_KEY_FILE:-}" ]; then
    signer=(--private-key "$(cat "$PRIVATE_KEY_FILE")")
  else
    echo "set ACCOUNT (a cast keystore) or PRIVATE_KEY_FILE, for the admin or pauser" >&2; exit 1
  fi
  echo "about to send on $NETWORK: $W $*"
  if [ "${YES:-}" != 1 ]; then
    read -r -p "type yes to send: " answer
    [ "$answer" = yes ] || { echo "not sent"; exit 1; }
  fi
  cast send "$W" "$@" "${signer[@]}" --rpc-url "$RPC" | grep -E '^(status|transactionHash) '
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  status) status ;;
  pause) send 'pause()' ;;
  unpause) send 'unpause()' ;;
  cancel) send 'cancelPending()' ;;
  withdraw) send 'withdrawFees(uint256)' "$1" ;;
  propose-domain) send "proposeDomain($DOMAIN_T)" "($1,$2,$3,$4,$5)" ;;
  commit-domain) send 'commitDomain()' ;;
  tighten-domain) send 'tightenDomain(uint32,uint256,bool,uint256)' "$1" "$2" "$3" "$4" ;;
  remove-domain) send 'removeDomain(uint32)' "$1" ;;
  propose-params) send "proposeParams($PARAMS_T)" "($1,$2,$3,$4,$5)" ;;
  commit-params) send 'commitParams()' ;;
  tighten-params) send "tightenParams($PARAMS_T)" "($1,$2,$3,$4,$5)" ;;
  propose-admin) send 'proposeAdmin(address)' "$1" ;;
  accept-admin) send 'acceptAdmin()' ;;
  propose-pauser) send 'proposePauser(address)' "$1" ;;
  commit-pauser) send 'commitPauser()' ;;
  propose-fee-recipient) send 'proposeFeeRecipient(address)' "$1" ;;
  commit-fee-recipient) send 'commitFeeRecipient()' ;;
  *) echo "unknown command $cmd; see the header of $0" >&2; exit 1 ;;
esac
