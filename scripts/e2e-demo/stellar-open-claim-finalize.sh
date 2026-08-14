#!/usr/bin/env bash
# Reproduces the live Stellar-testnet leg of the Stellar->Solana corridor's happy path against
# a real deployed contracts/stellar-soroban instance: open (real require_auth_for_args signing)
# -> claim (solver bond) -> [wait out the challenge window] -> finalize. See README.md in this
# directory for a real run's actual transaction hashes and what this closes out.
#
# Requires: `stellar` CLI configured with a `testnet` network and three funded identities
# (see `stellar keys generate`/`stellar keys fund` for USER_IDENTITY/SOLVER_IDENTITY/
# ARBITER_IDENTITY below — ARBITER_IDENTITY only needs to be a funded account able to submit
# the permissionless `finalize` call, not literally the contract's configured arbiter).
set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:?set CONTRACT_ID to the deployed XebraEscrow contract id}"
SOURCE_TOKEN="${SOURCE_TOKEN:?set SOURCE_TOKEN to the SAC address intents must use, e.g. the native XLM SAC}"
NETWORK="${NETWORK:-testnet}"
USER_IDENTITY="${USER_IDENTITY:-e2e-user}"
SOLVER_IDENTITY="${SOLVER_IDENTITY:-e2e-solver}"
FINALIZER_IDENTITY="${FINALIZER_IDENTITY:-e2e-arbiter}"
SOURCE_AMOUNT="${SOURCE_AMOUNT:-500000000}" # 50 XLM, 7-decimal units
DEST_ASSET="${DEST_ASSET:-1111111111111111111111111111111111111111111111111111111111111111}"
DEST_ADDRESS="${DEST_ADDRESS:-2222222222222222222222222222222222222222222222222222222222222222}"
MIN_DEST_AMOUNT="${MIN_DEST_AMOUNT:-1000000}"
DEST_TX_REF_HEX="${DEST_TX_REF_HEX:-$(python3 -c "print('demo-dest-tx-ref'.encode().hex())")}"
# The contract has no public getter for this — it's whatever `challenge_window_secs` the
# instance was deployed with (see `stellar contract deploy ... -- --challenge_window_secs N`).
CHALLENGE_WINDOW_SECS="${CHALLENGE_WINDOW_SECS:?set to the value the contract was deployed with}"

USER=$(stellar keys address "$USER_IDENTITY")
SOLVER=$(stellar keys address "$SOLVER_IDENTITY")
NOW=$(date +%s)
EXPIRY=$((NOW + 3600))

echo "== 1/4: open =="
INTENT=$(cat <<JSON
{ "dest_address": "$DEST_ADDRESS", "dest_asset": "$DEST_ASSET", "dest_chain": 3, "expiry": $EXPIRY, "min_dest_amount": "$MIN_DEST_AMOUNT", "nonce": "1", "source_amount": "$SOURCE_AMOUNT", "source_token": "$SOURCE_TOKEN", "user": "$USER" }
JSON
)
INTENT_HASH=$(stellar contract invoke --id "$CONTRACT_ID" --source-account "$USER_IDENTITY" --network "$NETWORK" -- open --intent "$INTENT" | tr -d '"')
echo "intent_hash: $INTENT_HASH"

echo "== 2/4: claim (solver posts a bond and asserts delivery) =="
stellar contract invoke --id "$CONTRACT_ID" --source-account "$SOLVER_IDENTITY" --network "$NETWORK" -- claim \
  --intent_hash "$INTENT_HASH" \
  --solver "$SOLVER" \
  --dest_tx_ref "$DEST_TX_REF_HEX" \
  --delivered_amount "$MIN_DEST_AMOUNT"

echo "== 3/4: waiting out the challenge window (${CHALLENGE_WINDOW_SECS}s) =="
sleep "$((CHALLENGE_WINDOW_SECS + 10))"

echo "== 4/4: finalize (permissionless — called by a third party, not the solver) =="
stellar contract invoke --id "$CONTRACT_ID" --source-account "$FINALIZER_IDENTITY" --network "$NETWORK" -- finalize --intent_hash "$INTENT_HASH"

echo "== final status =="
stellar contract invoke --id "$CONTRACT_ID" --source-account "$USER_IDENTITY" --network "$NETWORK" --send=no -- status_of --intent_hash "$INTENT_HASH"
