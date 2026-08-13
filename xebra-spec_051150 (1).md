# Xebra

Intent-based swap-capable cross-chain bridge. First corridor: Arc to Stellar.

## Problem

CCTP already moves USDC between chains that support it, with attestation and reasonable speed. Building another USDC-to-USDC bridge on top of it is redundant.

The actual gap: a user holding USDC on one chain who wants a non-USDC asset on another chain has no single-step path. Today that is two actions, two interfaces, two fee events, and two failure surfaces: bridge USDC over, then swap. Xebra collapses that into one signed intent. Pure USDC-to-USDC traffic should keep using CCTP directly. Xebra only matters where a swap leg is involved, and that constraint is the moat, not a limitation.

## Core idea

The user signs one message: "I have X USDC on Arc, I want at least Y of asset Z on Stellar, delivered to this address, by this deadline." They escrow the USDC on Arc and they are done. A solver fronts the destination asset on Stellar out of its own inventory, delivers it immediately, then proves delivery to the Arc escrow and claims the locked USDC plus its margin. If nobody fills the intent before expiry, the user reclaims their funds permissionlessly.

The user never touches Stellar tooling, never holds a gas asset on the destination chain, and never sequences a bridge call and a swap call. One signature, one wait, one arrival.

## Architecture

Four components. Two contracts, one bot, one thin frontend.

### 1. Intent format

Signed off-chain as EIP-712 typed data on Arc (Arc is EVM-compatible, so standard wallet signing flows apply).

```solidity
struct Intent {
    address user;           // refund recipient on Arc
    address sourceToken;    // USDC contract on Arc
    uint256 sourceAmount;   // 6 decimals
    bytes32 destAsset;      // sha256(assetCode || issuerAccountId), zero for native XLM
    uint256 minDestAmount;  // 7 decimals, Stellar native precision
    bytes32 destAddress;    // Stellar ed25519 public key, raw 32 bytes
    uint64  expiry;         // unix seconds
    uint256 nonce;          // per-user, strictly increasing
}
```

The intent hash is `keccak256` of the EIP-712 encoding. This single 32-byte value is the spine of the whole system: it identifies the escrow entry on Arc, it travels to Stellar inside the fulfillment payment's `memo_hash`, and it is what the solver's claim references. One hash binds all three legs.

Design notes:

- `minDestAmount` is the user's only price control. There is no oracle in the core path. The user (or the frontend on their behalf, via a quote) sets the floor, and any solver willing to deliver at or above it may fill. Solver margin is the spread between what the escrowed USDC is worth and what they delivered. Competition compresses it; no fee parameter needed in the protocol.
- `nonce` gives replay protection and lets a user have multiple concurrent intents.
- No partial fills in v1. One intent, one solver, one delivery. Partial fills multiply proof complexity for zero demo value.

### 2. XebraEscrow, Arc side (Solidity)

State machine per intent hash: `Open -> Claimed -> Finalized`, with `Open -> Refunded` on expiry and `Claimed -> Challenged -> (Finalized | Refunded)` on dispute.

```solidity
function open(Intent calldata intent, bytes calldata signature) external;
// verifies signature, pulls sourceAmount USDC via transferFrom, stores intent hash + expiry

function claim(bytes32 intentHash, bytes32 stellarTxHash, uint256 deliveredAmount) external payable;
// solver posts bond, asserts "I delivered on Stellar in this tx"; starts challenge window

function challenge(bytes32 intentHash) external payable;
// anyone posts a matching bond within the window; freezes the claim for resolution

function resolve(bytes32 intentHash, bool claimValid) external;
// arbiter role, v1 only; pays out escrow + loser's bond to the honest side

function finalize(bytes32 intentHash) external;
// after an unchallenged window: escrowed USDC + bond returned to solver

function refund(bytes32 intentHash) external;
// after expiry with no live claim: USDC back to user, callable by anyone
```

Concrete parameters, v1:

- Challenge window: 30 minutes on testnet for demonstration, 24 hours mainnet default. A constructor parameter, not a constant.
- Solver bond: 10% of `sourceAmount`, minimum 25 USDC equivalent. Large enough that a false claim on any realistically sized intent is unprofitable, small enough not to punish solver capital efficiency.
- Challenger bond: equal to solver bond. Symmetric stakes, loser pays winner.
- Arbiter: a single admin key in v1, held by the operator, used only when a challenge actually lands. This is the one trusted component and it is named honestly as such. The roadmap section covers its removal.

Everything else is permissionless by construction: `open`, `claim`, `challenge`, `finalize`, and `refund` have no allowlists. The solver set is open on day one even if it has one member.

### 3. Fulfillment, Stellar side

The solver's delivery is a standard Stellar transaction with two hard requirements:

1. Payment of at least `minDestAmount` of `destAsset` to `destAddress`.
2. `memo_hash` set to the intent hash.

That memo binding is what makes the proof checkable. Given an intent hash and a claimed Stellar tx hash, any observer can fetch the transaction from any Horizon instance and verify the payment, the asset, the amount, the recipient, and the memo in a few lines of code. A claim is a falsifiable statement, and challenging one is cheap.

The swap leg costs the solver nothing extra to build: if the solver holds USDC on Stellar rather than the destination asset, it delivers via `pathPaymentStrictReceive`, which performs the conversion through the Stellar DEX atomically inside the payment operation itself. Stellar's native path payments mean the "swap-capable" half of Xebra requires zero additional contract code on the destination side in v1. The solver sets its send-max, and if the DEX can't fill at acceptable cost, the operation fails atomically and the solver simply doesn't claim.

A minimal Soroban escrow (mirror of the Arc contract) is out of scope for v1 and in scope for the reverse corridor. It is listed in the roadmap, not the build.

### 4. Solver bot

TypeScript, single process, three loops:

- **Watch**: subscribes to `IntentOpened` events on the Arc escrow over WebSocket RPC. No dedicated feed infrastructure; the chain is the feed.
- **Fill**: for each open intent, quotes the delivery cost (spot via Stellar DEX orderbook for the pair, plus path payment slippage buffer), checks profitability against the escrowed amount, and if positive, submits the Stellar payment with the memo binding.
- **Claim**: after Stellar finality (about 5 seconds), submits `claim` on Arc with the tx hash, then calls `finalize` when the window elapses.

Inventory management: the solver's working capital drains on Stellar and accumulates on Arc with every fill. Rebalancing is native USDC movement from Arc back to Stellar via CCTP V2, which is exactly what Parabola does. Parabola is a dependency of the reference solver, not of the protocol. The escrow contracts know nothing about CCTP.

Capital sizing for v1: enough Stellar-side inventory to cover the largest single intent plus concurrent fills during one rebalance cycle. For a demonstration corridor, 500 to 1,000 USDC equivalent is sufficient and the number is stated so the cost of running a solver is legible to anyone considering becoming one.

### 5. Frontend

One page. Connect wallet, enter destination asset and Stellar address, see a quote, sign, watch status move through Open, Filled, Claimed, Finalized with the live Stellar tx linked. Its job is to make the one-signature UX visible, not to be a product surface. Vite + wagmi for the Arc side, Horizon polling for delivery status.

## Trust model, stated plainly

v1 has exactly two trust assumptions and both are explicit:

1. **The arbiter resolves honestly if a challenge occurs.** Mitigated by the fact that every claim is publicly verifiable against Horizon, so a dishonest resolution is provable by anyone. The arbiter can be wrong once, in public, and the system's history is permanent.
2. **The user trusts Arc and Stellar finality.** Arc has deterministic sub-second finality, Stellar closes in about 5 seconds. Neither chain has probabilistic reorg risk in the Bitcoin sense, which is what makes a short challenge window defensible at all.

What v1 does not assume: a trusted solver. The solver is bonded, its claims are falsifiable, and its role is permissionless. What replaces the arbiter later is the interesting part of the roadmap.

## Failure modes and handling

- **No solver fills**: intent expires, `refund` returns funds, callable by anyone so the user doesn't even need to come back.
- **Solver delivers but never claims**: user keeps the delivery, solver eats the loss. Solver's problem by design.
- **Solver claims without delivering**: challenge window catches it, challenger takes the bond, arbiter refunds the user.
- **Stellar DEX liquidity too thin for the path payment**: fill fails atomically on the solver's side before any claim exists. User just waits or expires.
- **Same intent claimed twice**: state machine forbids it; first valid claim moves state out of `Open`.

## Delivery plan

Four stages, each independently demonstrable:

1. **Contracts**: XebraEscrow on Arc testnet with full state machine and unit tests covering every transition including both dispute outcomes.
2. **Solver**: reference bot filling real intents against testnet, path payment delivery on Stellar testnet, memo binding verified end to end.
3. **Surface**: frontend with live status tracking, plus a scripted dispute walkthrough showing a false claim getting challenged and slashed.
4. **Hardening**: expiry and refund edge cases, concurrent intents, rebalance via CCTP, and a recorded end-to-end run: sign on Arc, receive XLM on Stellar, solver claims and finalizes.

The dispute walkthrough in stage 3 matters as much as the happy path. A bridge demo where nothing can go wrong proves nothing; showing a false claim getting caught and slashed is what makes the optimistic design credible.

## Roadmap

**Near**: reverse corridor (Stellar asset in, USDC on Arc out) via the minimal Soroban escrow. Publish the reference solver as open source so the solver set can grow by forking, not onboarding.

**Mid**: replace the v1 arbiter. The dispute problem here, a bonded assertion about an off-chain-verifiable fact, with challengers, stakes, and a resolution, is exactly the shape Tholos is built for. Xebra becomes Tholos's first production consumer, and Tholos removes Xebra's only trusted role. The two projects are designed to meet here.

**Far**: corridor generalization. A new corridor needs an escrow deployment on the source chain and a solver willing to hold both sides of the pair. The intent format, memo binding, and proof model do not change. Xebra goes wherever bridge-plus-swap is currently two user actions, and nowhere that CCTP alone already serves.
