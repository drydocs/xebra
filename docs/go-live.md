# Going live

What has to happen before anyone who is not us can connect a wallet and bridge USDC, split by
who can do it. Ordered so that nothing later depends on something earlier being skipped.

The corridor itself works. The first real mainnet transfer completed end to end: burn
`92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7` on Stellar, mint
`58dVHAebBDVHWpjRYeGn52YJB8MFsLkgJHefcNgMBgkpYN7LxzdpGNE1tnGcPzGmwFLbDTqg7C7kHzCh4Ja6HZs5` on
Solana, 1.000001 USDC delivered. That transfer's mint was submitted by hand from
`scripts/cctp-mint-solana.mjs`. Since then the relay has run unattended against a live Convex
deployment (`knowing-zebra-183`) and completed a transfer — burn to mint — with nobody watching.
The frontend is deployed at [xebra-sandy.vercel.app](https://xebra-sandy.vercel.app/). See
[`writeups/`](../writeups/) for the full incident-by-incident account.

---

## 1. Decide the fee, because the current defaults lose money on some transfers

`scripts/deploy-cctp-wrapper.sh` defaults to `FEE_BPS=10` (0.10%) and `MIN_FEE=5000000`
(0.50 USDC). Measured costs per transfer, on the Solana side, paid by us:

| | Lamports | Recoverable? |
|---|---|---|
| `used_nonce` account rent | 867,621 | **No.** Permanent, one per transfer, forever |
| Transaction fee | ~5,000 | No |
| Recipient token account rent, when the recipient has none | 1,855,269–2,039,280 | **No.** `CloseAccount` needs the owner's signature, which we do not have |

So a transfer to a wallet that already holds USDC costs us ~872,621 lamports. To a first-time
recipient it costs ~2,911,901 lamports. At a SOL price of $200 that is **$0.17 and $0.58**.

Against a 0.50 USDC floor, the first case earns $0.33 and the second **loses $0.08**. First-time
recipients are not an edge case — they are most of a new product's users.

Three ways out, and this is your call:

1. **Raise `MIN_FEE` to cover the worst case.** 0.75–1.00 USDC. Simple, and it prices small
   transfers out.
2. **Charge the token-account rent only to recipients who need one.** The frontend already knows
   which case it is (`/api/recipient` returns `exists` / `missing` / `unknown`), so the quote can
   differ. More honest pricing, more contract surface.
3. **Refuse first-time recipients** and tell them to receive any USDC on Solana first. Cheapest
   to build, worst experience.

Also decide `MAX_TRANSFER`. It defaults to 100k USDC. The contract has had no external audit, so
this number is the blast radius of a bug nobody has found yet. Start far lower and raise it as
clean transfers accumulate.

## 2. Things only you can do

### Keys and identities

The deploy script requires four Stellar addresses and refuses to run without them:

- **`SOURCE`** — a `stellar` CLI identity with XLM to pay for the deploy.
- **`ADMIN`** — can change fee parameters, through a 48-hour timelock.
- **`PAUSER`** — can pause, immediately, with no timelock.
- **`FEE_RECIPIENT`** — where withdrawn fees go.

**`ADMIN` and `PAUSER` must be different keys held by different people.** The pauser exists so
that a compromised admin can still be stopped by someone who is not the attacker. If one person
holds both, that check does not exist. The script warns and continues; it cannot know who holds
what.

A Solana hot wallet for the relay. It pays every mint, and it will be drained by ordinary
operation — budget refills, not a one-time transfer. The current one
(`BswkfXXywbVo8tesK4sWkrpsaVYUy3zaJuQYTCChGpG2`, key in the git-ignored `.secrets/`) holds
enough for a handful of transfers. Its key must reach the relay through Secrets Manager and
nothing else; it must never be in an env file or a container image.

### Accounts

The deployment is Vercel for the UI and Convex for the relay. See `docs/deploying.md` for the
mechanics; this is only the list of things that need an account and a card.

- **Convex, free.** Holds relay state and runs the minute-by-minute heartbeat. 1M function calls
  a month; the relay uses a fraction of it.
- **Vercel, Pro.** $20/month. Not for the features — for the terms: Hobby is restricted to
  non-commercial use, and taking a bridge fee is commercial. Because the schedule lives in Convex,
  Hobby is functionally complete while you are still testing with your own money.
- **A domain**, if you want one that is not `*.vercel.app`. Vercel handles the certificate.

That is the whole list. There is no AWS, no container registry, no Redis and no Kafka in this
deployment: `infra/terraform` and the other eight services stay in the repo for anyone who wants
to self-host, and are not on this path.

### Secrets to generate and store

On the **Convex** deployment (`npx convex env set`), which is where the relay runs:

- `RELAY_SOLANA_KEYPAIR` — the hot wallet secret. Base58, base64 or a keygen byte array; all
  three are accepted.
- `RELAY_SUBMIT_TOKEN` — optional, and only for operations: it bypasses the relay's admission
  bounds so an old burn can be re-driven by hand.

On **Vercel**: `CONVEX_URL`, and `RELAY_SUBMIT_TOKEN` if you set one.

Both platforms encrypt these at rest and decrypt them into the function at invocation. That is
better than the ECS arrangement the Terraform describes, where secrets land as plaintext process
env.

### Legal

Taking a fee for moving other people's money is a regulated activity in most jurisdictions, and
"anyone can connect their wallet" is the version that attracts attention. That question is
outside what this repo can answer and worth settling before launch rather than after.

## 3. One more reason to deploy the wrapper early

Until it exists, nothing on chain distinguishes a burn made through this app from any other CCTP
user's burn on Stellar — Circle's contract serves everyone. So `/api/relay/burns` cannot tell whose
mint it is being asked to pay for, and it is bounded rather than authenticated: burns older than an
hour are refused, and sponsorship stops after 200 mints in 24 hours. That caps the loss; it does
not prevent a griefer inside the bounds from having their own transfers sponsored.

The wrapper removes the vector, because then the watcher only ever sees burns we were paid a fee
on. It is on this list for revenue; this is the second reason.

## 4. What was left on my side

Done since this document was first written, so you do not have to ask for them:

- The relay running unattended against a live Convex deployment — the thing this section used to
  list as the one open item. It has now picked up a burn, waited on Circle's attestation, and
  submitted the mint with nobody watching.
- The frontend deployed to Vercel, at [xebra-sandy.vercel.app](https://xebra-sandy.vercel.app/).
- The self-serve claim page (`/claim`), so a user can complete their own transfer when nobody
  sponsors the mint. This is what makes the no-hang promise usable rather than merely true.
- Hot-wallet alerting: a Convex cron that fails loudly, and `GET /api/health` returning 503 for any
  free uptime monitor to page on.
- CI, running lint, typecheck, `vitest`, `cargo test` and `forge test` on every push. `pnpm lint`
  had never passed before this; it does now.

What is still genuinely open is §7 and §8 below: the bug bounty has not been published, and
`MAX_TRANSFER` has not been raised past its cautious starting value.

Not on the deployment path: seeding `chains`, `assets` and `corridors`. They have readers and no
writer, so `apps/api` throws on every quote against an empty table — but the bridge UI quotes from
a Soroban simulation and the relay does not touch them, so nothing deployed here needs it.

## 5. Sequence

Steps 1–5 are done. 6–8 are what is still open.

1. ~~`scripts/check-cctp-interface.sh` — Circle can redeploy their contracts.~~
2. ~~Deploy the wrapper with parameters from §1. Record `deployments/mainnet.json`.~~
3. ~~Fill `STELLAR_CCTP_WRAPPER_CONTRACT_ID` and `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID`
   in `.env.production`, plus `SOROBAN_START_LEDGER` at the deploy ledger.~~
4. ~~`npx convex deploy`, then deploy the frontend. `NEXT_PUBLIC_*` are inlined at build time, so
   they must be set in Vercel before the build, not after.~~
5. ~~Transfer your own money through the deployed stack. Then do it with the relay stopped, and
   complete the mint by hand, and write down that you did — the same standard
   `scripts/e2e-demo/` set for the escrow.~~
6. Raise `MAX_TRANSFER` in steps, through the timelock, as clean transfers accumulate.
7. Publish the bug bounty. Its duration is the only audit this contract gets, so treat it as a
   real gate.
8. Open it up.

## What is not a risk

Worth being clear, because most bridge failures are custody failures and this one cannot be.

The wrapper never holds principal. The user is `caller` on `deposit_for_burn`, so USDC moves
from the user directly to Circle inside a single transaction — if any part of it fails, the whole
transaction reverts and the user still has their money. `withdraw_fees` can only ever move the
accrued-fee counter, so a stolen admin key cannot reach a transfer in flight.

And `destination_caller` is set to zero, which makes every message permissionlessly mintable.
If this company disappears mid-transfer, the burned USDC is still claimable by anyone holding
Circle's attestation, forever. That is a property of the design, not of our uptime.
