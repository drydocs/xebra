# The tests that lied

The contract had 41 passing tests. They covered fee arithmetic across the full `i128` range,
every parameter ceiling a compromised admin cannot exceed, the reentrancy guard, the solvency
invariant, every revert path.

They could not have caught the bug that would have failed **100% of transfers**.

## One line

```rust
env.mock_all_auths();
```

That is in the test fixture, so every test ran with the host's authorization checks disabled.
Which is reasonable — it is how you test business logic without constructing signature trees by
hand. It also meant the entire authorization surface was untested, and that is where the bug was.

## The bug

`bridge()` calls the USDC contract's `approve` so Circle can pull the principal with
`transfer_from`. The expiry was computed the obvious way:

```rust
usdc_client.approve(&req.user, &messenger, &q.net_burned,
                    &(env.ledger().sequence() + APPROVAL_TTL_LEDGERS));
```

Soroban matches every sub-invocation against the signed authorization tree **argument by
argument**. That expiry gets computed twice: once during *simulation*, when the wallet builds and
signs the tree, and again during *execution*, when the host verifies it.

Those are different ledgers. Always. Simulation runs against the last closed ledger; the
transaction is applied in a later one. The two values can never agree, so the host rejects the
call with an authorization error that names nothing about the cause.

Every transfer. Every time. Not flaky — deterministic failure, with a useless error message.

## Why it survived so long

- **The tests skipped auth matching.** By design, and reasonably. But it meant nothing in the
  suite could see it.
- **The contract had never executed on any network.** Not mainnet, not testnet. Unit tests were
  the only evidence it worked.
- **It is invisible by reading.** The line looks correct. It *is* correct, in the sense that the
  value is sensible. What is wrong is that it is non-deterministic across two evaluations the
  developer never thinks of as separate.

## The fix

Make the expiry part of the signed request:

```rust
pub approval_expiration_ledger: u32,
```

Now every argument in the tree comes from data the user signed, and the contract bounds it at
execution: not already past, not further ahead than the TTL ceiling. Deterministic, so the tree
matches.

## The test that would have caught it

Not another `mock_all_auths` test. One that reads the *recorded* tree:

```rust
#[test]
fn approval_expiry_comes_from_the_request_not_the_ledger() {
    let s = setup();
    s.env.ledger().set_sequence_number(500);
    let r = req(&s, 1_000_0000000);   // built once, as a wallet would sign it once

    s.wrapper.bridge(&r);
    let first = recorded_approve_expiration(&s.env, &s.usdc);

    s.env.ledger().set_sequence_number(507);
    s.wrapper.bridge(&r);
    let second = recorded_approve_expiration(&s.env, &s.usdc);

    assert_eq!(first, second, "the auth tree must not move with the ledger");
}
```

Reverting the fix makes it fail with `left: Some(560), right: Some(530)` — the exact mismatch that
would have failed on chain. That is the standard worth holding a regression test to: it should
reproduce the production failure, not merely exercise the fixed code.

## The lesson

**A mock that makes tests possible also makes a class of bug invisible.** Know which class.

`mock_all_auths()` is not wrong. Using it everywhere and concluding "the contract is tested" is.
For anything that only manifests through the mock — authorization trees, signature verification,
replay protection — you need at least one test that goes the other way.

And the broader version: **a test suite tells you about the code it exercises, not about the
system.** Forty-one tests said the contract was correct. What they actually said was that the
contract's arithmetic was correct, which was never in doubt.
