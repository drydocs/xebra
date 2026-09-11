# The lost dollar

One dollar. It is still out there, burned on Stellar, attested by Circle, addressed to somewhere
nobody can reach. It will be there forever.

## What happened

The first real transfer this project ever attempted. Burn
`ca70f32ee85cda4c24b4d4909da660d86e7f86ffd0c7eae5a63a6da728eef54b` went through on Stellar
mainnet. Circle attested it. Everything looked right.

Then the mint would not land, and the reason turned out to be one line of thinking.

CCTP's `mintRecipient` on Solana is **not the recipient's wallet**. It is the recipient's *token
account*. Circle's program enforces this literally:

```rust
require_keys_eq!(recipient_token_account.key(), mint_recipient);
```

The burn named the wallet, `2GiJjxyCM296G3aAxrz826m8JZjeoqMAKuushBE19ouL`. For that mint to
succeed, a token account would have to exist *at that exact address*.

## Why that is permanent

Solana addresses are either on the ed25519 curve or off it. Wallet addresses are on the curve —
that is what makes them signable. Program-derived addresses, which token accounts are, are
deliberately off it.

`2GiJjx…` is on the curve. A token account can therefore never exist there. Not "does not yet" —
*cannot*. The mint has no valid destination and never will.

The usual escape hatch does not apply either. CCTP's guarantee is that an attested message can be
submitted by anyone, so funds are never hostage to one relayer. That is true and it did not help:
the message was fine, the destination was impossible.

The second escape hatch — have the owner sign something — did not apply because the address was a
**centralised exchange deposit address**. Nobody available held that key. Not the user, not the
exchange in any practical sense.

So: burned, attested, addressed to a void. Recoverable by nobody.

## What made it possible

The frontend accepted a Solana address and passed it straight through as `mintRecipient`. That is
the entire bug. It is one missing derivation:

```ts
const [tokenAccount] = PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM,
);
```

Every subsequent safeguard in this codebase exists because of that dollar:

- the UI derives the associated token account and **displays it**, so the thing being funded is
  visible before signing
- `scripts/preflight-bridge.mjs` refuses to let a burn proceed if the destination is unreachable
- the contract rejects an all-zero recipient and checks the address *shape* per destination chain
- a test asserts the derivation against a known mainnet pair

The contract cannot fully protect you here, and it is worth being honest about that. Whether a
32-byte value on Solana is a token account is a fact about Solana. A Stellar contract cannot see
it. The protection has to live in the client, and it does.

## The part that felt like closure

Much later, with the wrapper deployed and the relay running, a transfer went to
`B8vQF8ESWbGcYLmH7veQPyshVH7XfDHPg2pAPk4RjV7d`.

That is the USDC token account **of the same exchange address that ate the dollar.** Same
destination. Addressed correctly this time — the derived token account rather than the wallet.

Burn `edb52d3a52833a0ec52fccca27fbcb0e9c3ebb52479d88ac8da26951d542ed2f`, mint
`4eLxMjX4RoGwHDiPpi7uD2ydHuaaUqhrZiJq2T7uU3mK3KeqT5TC32yRmpMCndZzWiLGZ3DsZ1iwhB4mgX3oBkdb`,
9.7 USDC delivered. Nobody touched it. The relay did it inside a minute.

The dollar is not coming back. But the address that swallowed it now gets paid.

## The lesson

**"It looks like an address" is not the same as "it can receive this asset."**

Every chain has a version of this. On Solana it is wallet-versus-token-account. On EVM it is
sending ERC-20 to a contract that cannot move them. The mistake is treating an address as a
destination when it is really a *claim* that some specific account exists and is able to accept
that specific asset.

Check the claim. Show the user what you checked. And when the check fails, refuse — do not let
the transaction proceed and hope.
