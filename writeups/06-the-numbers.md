# The numbers

Everything here was measured on mainnet, not estimated.

## What a transfer costs us

| | Lamports | Recoverable? |
|---|---|---|
| `used_nonce` account rent | **867,621** | **No.** Permanent, one per transfer, forever |
| Transaction fee | 5,000 | No |
| Recipient token account rent, first-time recipients only | **2,039,280** | **No.** `CloseAccount` needs the owner's signature, which a sponsor never has |

A repeat recipient costs **872,621 lamports**. A first-time recipient costs **2,911,901**.

Verified exactly: the relay wallet went from 5,557,099 to 4,684,478 lamports across one mint to an
existing account. A difference of 872,621, to the lamport.

At $200/SOL that is **$0.17** and **$0.58**. The second number is the one that matters, because
first-time recipients are most of a new product's users.

## What we charge

```
fee = max(amount × 0.10%, 0.30 USDC) + 0.70 USDC if the recipient has no USDC account yet
```

| Transfer | Repeat recipient | First-timer |
|---|---|---|
| $10 | $0.30 (3.0%) | $1.00 (10%) |
| $50 | $0.30 (0.6%) | $1.00 (2.0%) |
| $500 | $0.50 (0.1%) | $1.20 (0.24%) |
| $5,000 | $5.00 (0.1%) | $5.70 (0.11%) |

Splitting the account rent out of the floor is what lets the floor be 0.30 instead of 1.00. Charging
every transfer for a cost only first-time recipients cause made small transfers unattractive for no
reason.

The floor is thin at a high SOL price — at $300/SOL a mint costs about $0.26 against a $0.30
floor — and **raising it goes through a 48-hour timelock** while lowering is instant. Worth setting
with that asymmetry in mind.

## What it cost to deploy

| | |
|---|---|
| Wasm, unoptimized | 57,475 bytes |
| Wasm, after `wasm-opt` | **43,319 bytes** (−25%) |
| Simulated upload fee, unoptimized | 67.92 XLM |
| Simulated upload fee, optimized | **50.81 XLM** |
| Actual total paid (upload + instance + constructor) | **49.79 XLM** |

The actual came in under the simulated ceiling because Soroban charges measured usage rather than
the simulated maximum.

Rent recurs. The code entry needs extending periodically, priced off that same 43 KB.

## The economics problem nobody tells you about

**Revenue is USDC on Stellar. Costs are SOL on Solana.** Different assets, different chains, no
automatic conversion between them.

So a sponsoring relay must be refilled, forever, and the loop only closes if you withdraw accrued
USDC and convert it. At low volume that loop does not sustain itself: after two transfers the
contract held 0.30 USDC of fees while the relay had spent roughly $0.35 of SOL.

The alternative is not sponsoring at all — the recipient claims for themselves and pays their own
gas, which is what `/claim` is for. That has zero operational cost and a worse first-run
experience, because a user receiving USDC on Solana for the first time has no SOL to claim with.

We chose to sponsor. It is the better product and it is a real, recurring, cross-chain cost that
has to be priced in.

## Solana's hard limits, for reference

| | |
|---|---|
| Transaction packet limit | 1232 bytes |
| `receiveMessage` serialised | **1224 bytes** |
| Headroom | 8 bytes |
| Compute used by a real mint | 185,553 of 200,000 default units |

Both numbers are tight enough that they have already caused an outage. See
[Thirty-two bytes](04-thirty-two-bytes.md).
