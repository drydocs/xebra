# What I'd tell myself at the start

Fifteen defects, one unrecoverable dollar, and a working corridor. These are the lessons, ranked
by how much they cost.

## 1. A green test suite is evidence about the tests, not the system

Two hundred-odd tests passed continuously, start to finish. They never went red while the contract
was undeployable, the deploy script could not run, the transaction was too large to submit, and
every transfer would have failed authorization.

The bugs that mattered lived in the seams: between simulation and execution, between a script and
the shell running it, between a transaction and the packet size limit. Nothing in a unit test
reaches those.

**Ask what class of bug your mocks make invisible, and write one test that goes the other way.**

## 2. The first real execution finds things nothing else can

Every single defect that mattered was found by running the thing, once, for real:

- deploy script died on an unbound variable — first run
- confirmation gate exited silently — second run
- transaction never included — third run
- ScVal encoding wrong on 9 of 10 fields — first real `bridge()` call
- transaction 32 bytes too large — first real mint
- failed jobs never retried — second minute of the first real mint

Not one of these was found by reading, reviewing, or testing. **Get to a real execution as early as
you can afford to, on the smallest amount of money you are willing to lose.**

## 3. "Cannot test on testnet" costs more than testnet

We skipped it. Every bug above then got found on mainnet, with real money in flight, under time
pressure. The first user-facing transfer failed four separate ways in sequence.

None of it lost funds, because the architecture made that structurally hard. But the debugging
happened in the worst possible conditions and it did not have to.

## 4. Refuse rather than guess, and distinguish "no" from "don't know"

Three separate bugs were the same mistake:

- an RPC failure reported to the user as "this wallet has no USDC account"
- an unread balance treated as a zero balance
- another contract's error code translated through our own error table

Every one turned *I could not find out* into *the answer is no*, confidently. Users act on
confident answers.

## 5. Fix environmental bugs everywhere, not where you found them

The 100-stroop inclusion fee cost a mainnet burn, was diagnosed, and was fixed — in the frontend.
Weeks later it cost a failed contract deployment, because the deploy script did the same thing and
nobody grepped.

**When you fix something about the environment — a fee, a timeout, a retry, an encoding — search
for every other place doing the same thing, immediately.**

## 6. Design so that mistakes are survivable

This is why the dollar is the only money that was ever lost.

- The contract never custodies principal. USDC moves from user to Circle inside one transaction; if
  any part fails the whole thing reverts and the user still has their money.
- `destination_caller` is 32 zero bytes, which makes every attested message mintable by **anyone**.
  A relay outage is an inconvenience, not a loss.
- `withdraw_fees` can only ever move the accrued-fee counter, so a stolen admin key cannot reach a
  transfer in flight.

Four separate failures happened to real transfers after that design was in place. All four were
recoverable. **Spend the design effort on the blast radius, not on being right.**

## 7. Say the number

Not "the relay is running low" — *"about 2 more transfers."* Not "rent" — *"867,621 lamports,
permanently, and nobody can ever reclaim it."*

Every good decision in this project came after someone measured something. The fee schedule, the
wasm optimization, the compute budget, the transaction size. Every bad one came from a plausible
assumption nobody had checked.

## The scoreboard

| | |
|---|---|
| Money permanently lost | **$1.00** |
| Money recovered that looked lost | $0 — it really was gone |
| Transfers completed | 3 (one manual, two fully automatic) |
| Defects found by tests | several, all minor |
| Defects found by running it for real | **every one that mattered** |
