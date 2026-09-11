# Building Xebra: a field log

A USDC bridge from Stellar to Solana, built and shipped to mainnet. These are notes written
while it happened, not reconstructed afterwards. Every hash, address and number is real and
checkable on chain.

The short version: fifteen defects, one dollar lost forever, and a corridor that now moves money
on its own. Most of the defects were invisible to a test suite that passed 200-odd tests the
whole way through. That is the story worth telling.

## The pieces

| | |
|---|---|
| Fee wrapper (Soroban, Stellar mainnet) | [`CCNWLGFM…`](https://stellar.expert/explorer/public/contract/CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ) |
| Relay + job store | Convex (`knowing-zebra-183`) |
| Frontend | Next.js on Vercel |
| Attestation | Circle CCTP V2 |

## Timeline

| Ledger | What |
|---|---|
| — | First real burn, `ca70f32e…`. $1 sent to an address that could never receive it. **Gone.** |
| — | Root cause: `mintRecipient` must be a *token account*, not a wallet |
| 64335901 | First successful transfer, `92421fa2…` — mint driven by hand from a script |
| 64350394 | Wrapper contract deployed to mainnet for 49.79 XLM |
| 64360511 | First transfer through the deployed contract, `7bc91673…`. Failed four different ways. |
| 64360511 | Same transfer, delivered: burn → attestation → relay → mint, nobody watching |
| 64381465 | `edb52d3a…` — the exchange address that ate the $1, paid correctly, delivered |

## The write-ups

1. **[The lost dollar](01-the-lost-dollar.md)** — the only money that never came back, why it was
   unrecoverable from the instant it was signed, and the day the same address got paid properly.
2. **[The tests that lied](02-the-tests-that-lied.md)** — 41 passing contract tests that could not
   have caught the bug that would have failed 100% of transfers.
3. **[The deploy script that had never run](03-the-deploy-that-had-never-run.md)** — three
   defects in the tooling around the contract, none of which any test suite would ever reach.
4. **[Thirty-two bytes](04-thirty-two-bytes.md)** — a safety margin that broke every mint.
5. **[When the error blames the wrong contract](05-the-error-that-blamed-the-wrong-contract.md)** —
   a confident, specific, completely wrong diagnosis.
6. **[The numbers](06-the-numbers.md)** — what it actually costs to run, measured rather than
   estimated.
7. **[What I'd tell myself at the start](07-what-id-tell-myself.md)** — the lessons, stated plainly.
