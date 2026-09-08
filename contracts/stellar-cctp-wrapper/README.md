# XebraCctpWrapper (Soroban)

Fee-taking front door to Circle's CCTP V2 on Stellar. Takes a basis-points-plus-floor fee in
USDC and forwards the remainder to `TokenMessengerMinter::deposit_for_burn`.

Source chain: Stellar (CCTP domain **27**). First destination: Solana (domain **5**).

## Live mainnet facts this contract is built against

Verified with `stellar contract info interface` and read-only invokes against mainnet, not
from documentation:

| Fact | Value |
|---|---|
| TokenMessengerMinter | `CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL` |
| MessageTransmitter | `CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV` |
| USDC SAC | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `get_token_decimal_config` | `{canonical_decimals: 6, local_decimals: 7}` |
| `get_max_burn_amount_per_message` | `100000000000000` (10M USDC) |
| `get_min_fee(USDC)` | `0` — controller-settable, never hardcode |
| `paused()` | `false` |

`MAX_TRANSFER_CEILING` is 250k USDC, two orders of magnitude inside Circle's burn cap.

## The invariant

**No USDC belonging to a user is ever held by this contract between transactions.** Either
the fee is collected and the burn happens in the same transaction, or the whole transaction
reverts and the user keeps every stroop.

This is why `bridge` is one function and not a deposit/bridge pair, and why Circle's call is
`deposit_for_burn` and never `try_deposit_for_burn` — a caught panic is the one change that
would convert an atomic failure into permanently stuck funds.

## Why the user, not the wrapper, is `caller`

Circle's `deposit_for_burn` moves USDC out of `caller` via the USDC SAC, one frame deeper
than the frame this contract directly invokes:

```
[wrapper] -> [TokenMessengerMinter::deposit_for_burn] -> [USDC SAC::burn]
```

Soroban's implicit invoker-contract authorization covers only the directly-invoked frame.
Passing the wrapper's own address as `caller` would require `authorize_as_curr_contract`
with an entry matching Circle's *internal* call byte-for-byte — an undocumented detail of a
contract we do not control, which can change on any Circle redeploy.

Passing `req.user` instead means the user signs one authorization tree covering the fee
transfer and the burn together. Consequences:

- No dependency on Circle's private call shape, and no standing allowance anywhere.
- The wrapper never custodies principal, so `withdraw_fees` structurally cannot reach user
  money. A bug's blast radius is accrued fees only.
- The user's authorization is argument-bound *inside Circle's contract*, pinning destination
  domain, mint recipient and net amount. A fully compromised admin here cannot redirect
  anyone's burn — altering any of those invalidates the signature and the transaction fails
  closed.
- Circle's `is_denylisted` applies to the actual user rather than to this contract as a
  single shared point of failure.

## Decimals

Stellar USDC is 7-decimal; CCTP's canonical representation is 6-decimal. Circle computes
`local_burn_amount = amount - (amount % 10)` and leaves the residual with `caller`.

This contract rounds `net` down to a 10-stroop boundary *before* calling, so
`local_burn_amount == net` exactly and the residual is identically zero. Without it, the
emitted `net_burned` would not equal the stroops actually burned and the user would be told
they bridged more than they did. The 0..=9 stroop remainder is never transferred — the user
is debited `fee + net`, never `amount`.

## Fee model

```
fee = max(amount * fee_bps / 10_000, min_fee)
net = (amount - fee) rounded down to a multiple of 10
```

Fee-then-normalize, not normalize-then-fee: normalizing first hands Circle a value it
silently truncates. The bps step truncates, so the protocol under-collects by <1 stroop
rather than rounding against the user.

The `min_fee` floor is not cosmetic — the relay pays Solana SOL gas for every mint, and the
floor is what keeps small transfers from being loss-making. Derive it from measured mint
cost.

## Operational controls

Hard-coded ceilings, unreachable by any admin (compile-time constants, no upgrade
entrypoint):

| Constant | Value |
|---|---|
| `MAX_FEE_BPS_CEILING` | 100 (1.00%) |
| `MAX_MIN_FEE_CEILING` | 5 USDC |
| `MIN_TRANSFER_FLOOR` | 10 USDC |
| `MAX_TRANSFER_CEILING` | 250,000 USDC |
| `MAX_CCTP_FEE_BPS_CEILING` | 50 (0.50%) |
| `TIMELOCK_SECS` | 172,800 (48h) |

- **Loosening** any parameter is timelocked 48h and emits `params_proposed` — alert on it.
- **Tightening** (lower fees/caps, higher minimum) is immediate, so incident response never
  waits 48h to reduce exposure.
- **Pause** is admin-or-pauser; **unpause** is admin-only. A pauser can stop the world but
  not restart it — hold the two keys separately.
- **`cancel_pending`** gives the pauser a veto over every pending change in one call.
- **Admin transfer** is two-step and timelocked; a proposal never accepted leaves the
  contract fully operable.
- **`withdraw_fees`** is bounded by `accrued_fees`, never by raw balance, and always pays
  the stored recipient — no entrypoint accepts a caller-supplied destination.

There is deliberately **no sweep function**. It would be the only path reading raw balance
rather than a counter, and cutting it removes that surface entirely. The cost is that USDC
transferred directly to the contract by mistake is unrecoverable.

## Verification

```bash
cargo test                                    # unit + behavioural suite
cargo build --release --target wasm32v1-none  # release wasm
../../scripts/check-cctp-interface.sh         # interface drift vs live mainnet
```

`scripts/check-cctp-interface.sh` guards the single highest-severity risk: a transposition
in the `deposit_for_burn` argument list. `amount`/`max_fee` are both `i128` and
`mint_recipient`/`destination_caller` are both `BytesN<32>`, so a swap of either pair
type-checks, deploys, and destroys funds. Run it in CI on every PR and on a schedule, so a
Circle redeploy is noticed before a user finds it.

## What the tests do NOT cover

`mock_all_auths()` bypasses the host's authorization checks. The suite therefore does not
prove that **a real wallet produces an authorization tree covering both the fee transfer and
the nested `deposit_for_burn`**. That is the highest-value pre-launch check and it can only
be done on testnet against a real signer (Freighter). It is exactly the class of bug this
repo already hit once — Soroban event topics turned out to be snake_case, silently matching
zero events until a live run proved it.

Also unreachable from the test host, and required on testnet before mainnet:

1. The generated `TokenMessengerClient` decodes against the deployed contract (partly
   covered by the interface check; finish it with one real small-value burn).
2. `indexer-stellar` matches `bridge_initiated` — extend `EVENT_TOPIC_TO_TYPE` in
   `packages/chain-adapters/src/stellar/decode-soroban-events.ts` and assert against real
   testnet events. Note `extractIntentHash` returns `null` for these events (they carry
   `transfer_id`, not `intent_hash`), so it needs `transfer_id` added to `INTENT_HASH_KEYS`
   or its own extraction path.

## Residual risks

1. **Circle migrates the TokenMessengerMinter address.** `token_messenger` is immutable by
   design — a settable messenger is the worst compromised-admin vector available — so a
   migration means redeploying and repointing the frontend. Because no funds are held
   between transactions, a redeploy strands nobody. Keep the runbook written before launch,
   not after.
2. **`mint_recipient` well-formed but wrong.** The shape check catches chain-family
   confusion; it cannot catch a correctly-shaped address the user does not control. This is
   a frontend control: derive the recipient from a connected wallet, show the decoded
   address, confirm explicitly.
3. **Admin key compromise.** Bounded: can take accrued fees, and after 48h raise fees to the
   1% ceiling, add a domain, or redirect the fee recipient. Cannot reach user principal
   (never custodied), exceed any hard ceiling, upgrade the contract, change `usdc`/
   `token_messenger`, or redirect any user's burn. Hold admin on a multisig and pauser on a
   separate key held by a different operator; alert on every `*_proposed` event; withdraw
   fees frequently so the at-risk balance stays small.
4. **Circle's per-token burn limit.** Every bridge reverts with an opaque Circle panic. No
   funds at risk, but it looks like a total outage. Monitor `get_max_burn_amount_per_message`
   and put it first in the incident runbook.
5. **`max_fee` under-quoted.** Silently downgrades Fast to Standard; the user waits longer
   than quoted. Circle's threshold is not readable on-chain from here, so quote from
   `get_min_fee_amount` with a buffer and reconcile against the emitted `max_fee`.
6. **A future two-phase API.** Every stuck-funds guarantee rests on "no principal held
   between transactions." A well-meant `deposit()`/`bridge_later()` pair, or a `try_*` added
   to make Circle's failures "graceful", destroys all of them at once. Make it the first
   item in the bug-bounty scope.
