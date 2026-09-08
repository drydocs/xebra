# Going live

What has to happen before anyone who is not us can connect a wallet and bridge USDC, split by
who can do it. Ordered so that nothing later depends on something earlier being skipped.

The corridor itself works. One real mainnet transfer has completed end to end: burn
`92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7` on Stellar, mint
`58dVHAebBDVHWpjRYeGn52YJB8MFsLkgJHefcNgMBgkpYN7LxzdpGNE1tnGcPzGmwFLbDTqg7C7kHzCh4Ja6HZs5` on
Solana, 1.000001 USDC delivered. That transfer's mint was submitted by hand from
`scripts/cctp-mint-solana.mjs`. The relay now does it unattended, but it has never run against
a live database, and nothing in this repo has ever been deployed anywhere.

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

- **AWS.** `infra/terraform` has never been applied — there is no state file anywhere.
- **A domain and a Route53 hosted zone.** The ACM certificates cannot validate without it; they
  stay `PENDING_VALIDATION` forever and the load balancer never comes up.
- **Redpanda Cloud** (or any managed Kafka). Terraform does not provision it; it is a required
  external input carrying the event bus.
- **Grafana Cloud** or CloudWatch, for the metrics the services already emit.
- **A GitHub repository with Actions secrets**, once there is CI to hold them.

### Secrets to generate and store

Into AWS Secrets Manager, never into `.env.production`:

- `RELAY_SUBMIT_TOKEN` — 32 bytes minimum. Shared between the relay and `apps/web`'s server-side
  route. `openssl rand -base64 32`.
- `RELAY_SOLANA_KEYPAIR` — the hot wallet secret. Base58, base64 or a keygen byte array; all
  three are accepted.
- `DATABASE_URL`, and `REDIS_URL` / `KAFKA_BROKERS` if they carry credentials.

Note the caveat in `docs/environments.md`: ECS injects Secrets Manager values as plaintext
process env, so anything that can read `/proc/<pid>/environ` or dump a task definition gets the
relay hot wallet. Only the arbiter uses KMS properly. Acceptable for a hot wallet holding a few
dollars of SOL; not acceptable for anything holding user funds, which is why the wrapper never
custodies principal.

### Legal

Taking a fee for moving other people's money is a regulated activity in most jurisdictions, and
"anyone can connect their wallet" is the version that attracts attention. That question is
outside what this repo can answer and worth settling before launch rather than after.

## 3. Things I can still do, in order

1. **Dockerfiles.** There are none, for any of the nine services, while ECS pulls
   `<ecr_url>:<tag>` from an `IMMUTABLE` repository. Nothing is deployable today. `apps/web`
   needs its `NEXT_PUBLIC_*` values as **build args** — runtime env is a no-op for them, because
   Next.js inlines at build time.
2. **CI.** No `.github/` exists. Lint, typecheck, `vitest`, `cargo test`, `forge test`, then
   build and push images tagged with the release SHA.
3. **A migration runner** as a one-off ECS task, gated before service rollout. A fresh RDS comes
   up empty and `apps/api` and `apps/projector` fail against it.
4. **Terraform gaps**: `production.tfvars`, the Route53 zone and ACM validation records, an
   `iris_base_url` with no sandbox default (attesting against the sandbox leaves burns "pending"
   forever), ECS circuit breaker and autoscaling.
5. **Seed `chains`, `assets` and `corridors`.** They have readers and no writer, so `apps/api`
   throws on every quote against an empty table. The bridge UI does not depend on this — it
   quotes from a Soroban simulation — but the API does.
6. **Alerts.** Five metrics are emitted and zero alerts are defined, so nothing pages anyone.
   At minimum: relay SOL low, attestation pending past threshold, dead-lettered jobs, wrapper
   paused, fee balance drift.
7. **The in-browser claim page.** Today, if the relay is down, the receipt tells the user to keep
   their hash and open an issue. The funds are genuinely safe — the attestation is public and
   never expires — but "someone else runs a script for you" is not a self-serve path. This is the
   difference between our uptime being your convenience and your risk.
8. **Run the relay against a live database.** Every part of it is unit-tested and none of it has
   talked to Postgres.

## 4. Sequence, once the above exists

1. `scripts/check-cctp-interface.sh` — Circle can redeploy their contracts.
2. Deploy the wrapper with parameters from §1. Record `deployments/mainnet.json`.
3. Fill `STELLAR_CCTP_WRAPPER_CONTRACT_ID` and `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID`
   in `.env.production`, plus `SOROBAN_START_LEDGER` at the deploy ledger.
4. Build and deploy. Migrations first, then services.
5. Transfer your own money through the deployed stack. Then do it with the relay stopped, and
   complete the mint by hand, and write down that you did — the same standard
   `scripts/e2e-demo/` set for the escrow.
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
