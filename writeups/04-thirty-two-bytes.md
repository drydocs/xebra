# Thirty-two bytes

The first transfer through the deployed contract burned correctly, got attested by Circle, was
picked up automatically by the relay — and then failed to mint with:

```
Transaction too large: 1264 > 1232
```

Someone's USDC was gone from Stellar and not yet on Solana, and the transaction that would deliver
it could not be submitted at all.

## The arithmetic

Solana's packet limit is **1232 bytes**. CCTP V2's `receiveMessage` serialises to **1224**. That is
eight bytes of headroom for a transaction carrying a 376-byte message, a 130-byte attestation, and
about twenty accounts at 32 bytes each.

I had added this, for safety:

```ts
.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
```

That costs 40 bytes: the ComputeBudget program id joins the account table (32) plus a compiled
instruction (8).

**1224 + 40 = 1264.** Exactly the number in the error.

The comment I wrote above it said the 200k default "leaves no margin for Circle raising its own
costs." It was a considered decision, and it was wrong, because there was no margin to spend in the
first place.

## The fix, and its honesty

Remove it. The mint now relies on the 200,000-unit default against **185,553 units** measured on a
real mainnet mint — about 7% of headroom.

That is genuinely thin, and worth stating rather than hiding. If Circle's program ever costs more,
the answer is an **address lookup table**, which replaces each 32-byte account key with a one-byte
index and would free hundreds of bytes. It is not a compute budget instruction, which cannot fit.

There is also now a guard, because the raw failure names a byte count and not the instruction
responsible:

```ts
const size = prepared.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
if (size > MAX_TRANSACTION_BYTES) {
  throw new Error(`Mint transaction is ${size} bytes, over Solana's ${MAX_TRANSACTION_BYTES}-byte
    limit. Nothing was submitted. An address lookup table is the only way to add anything to
    this transaction.`);
}
```

## The second bug underneath it

Fixing the size did not deliver the transfer. The job sat in `failed` and was rescheduled every
minute, forever, without ever being retried.

`decideNextStep` schedules a `failed` job for another attempt. `advanceRelayJob` only acted on
`queued` and `waiting_attestation` and returned everything else untouched. The two requeued each
other in a loop.

Worse: `attempts` is only incremented by a real submission failure, which never ran. So the counter
never advanced and the attempt limit never ended it either. **A transfer that failed once could
neither be retried nor given up on.**

One word in a switch statement:

```rust
case "queued":
case "waiting_attestation":
case "failed":          // <- this
  return advanceWaitingForAttestation(job, deps);
```

Retrying is safe: it re-reads the attestation and re-submits, and a mint that actually succeeded is
rejected on chain by `used_nonce` rather than paid for twice.

## The tests

Both now have regression tests that measure the real thing rather than exercising the fixed code.
The size one builds the actual instruction, serialises it, and asserts three things — that it
fits, that the headroom is under 64 bytes so nobody assumes there is room, and that adding a
compute budget instruction reproduces the production error **including its message**:

```ts
expect(() => tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
  .toThrow("Transaction too large: 1264 > 1232");
```

## The lesson

**A safety margin you cannot afford is not a safety margin.** It is a failure you have not
measured yet.

The deeper one: nothing in the suite measured the transaction. Plenty of tests asserted that the
instruction had the right accounts in the right order — all correct, all passing, all irrelevant to
whether the thing could physically be submitted. When a system has a hard physical limit, assert
against the limit.
