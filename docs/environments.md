# Environment

**Mainnet only.** There is one network, one env file, one code path. Testnet and local
presets were removed — every extra network was a second set of addresses that could be mixed
into the first.

| File | Network | Corridor |
|---|---|---|
| `.env.production` | `mainnet` | Stellar mainnet → Solana mainnet-beta |

It is **committed**. It holds only public chain constants — contract addresses, RPC URLs,
CCTP domain ids. Secrets are never in it.

```bash
pnpm dev      # mainnet
pnpm build    # mainnet
pnpm check:env
pnpm check:cctp
```

`pnpm dev` points the UI at real money. That is safe to *browse* — quotes are Soroban
simulations and nothing moves until a signature — but a signed transaction spends real USDC.

## Why this exists

Network identity used to be ~20 uncorrelated free-form strings with nothing cross-checking
them. Two concrete hazards followed:

1. **Incoherent mixes started cleanly.** A mainnet Soroban RPC paired with a testnet network
   passphrase parsed, booted, and would have signed against the wrong network.
2. **Missing variables produced working testnet builds.** `apps/web` defaulted to anvil chain
   id `9001`, `http://localhost:8545`, and the Stellar *testnet* passphrase. A missing build
   arg gave you a healthy-looking frontend pointed at the wrong chain — and because
   `NEXT_PUBLIC_*` is inlined at build time, nothing at runtime could correct it.

`packages/network-config` replaces both with a single pinned mainnet preset plus a validator
that refuses to boot on an incoherent mix. Every address in it was read from the live chain,
not from documentation.

## What is enforced

`packages/network-config` rejects, with every problem reported at once:

- `NETWORK` missing — **there is no default**, deliberately.
- `NETWORK` set to anything but `mainnet` (a stale `NETWORK=testnet` fails loudly).
- A network passphrase that is not the mainnet one.
- Any endpoint containing `testnet`, `devnet`, `sandbox`, `localhost`, `127.0.0.1`.
- An overridden Circle contract address (they are pinned).
- A wrong CCTP domain id (Stellar 27, Solana 5).
- Anything but production Iris — attest against the sandbox and burns stay "pending" forever.
- Any empty CCTP address.

Legitimate overrides (a paid RPC endpoint, say) are allowed and recorded in `overrides`,
which `describeNetworkConfig()` prints in the startup log line.

## Never index `process.env` in client code

Webpack's `NEXT_PUBLIC_*` substitution is **purely textual**. It fires only for a literal
member expression:

```ts
process.env.NEXT_PUBLIC_NETWORK   // ✅ replaced with a string constant at compile time
process.env[name]                 // ❌ undefined in the browser, works fine on the server
```

A dynamic lookup cannot be statically analyzed, so in the **client** bundle it resolves
against an empty `process.env` shim and yields `undefined` for everything — while behaving
perfectly on the server. That asymmetry is what makes it confusing: the variable *is* set,
the server sees it, and only the browser throws.

This actually happened here. `apps/web/lib/env.ts` had a `required(name)` helper doing
`process.env[name]`, and `next dev` threw `NEXT_PUBLIC_NETWORK is not set` in the browser
while the value was correctly set in the process the whole time.

The file now declares every variable once in a literal `RAW` table.
`scripts/check-env-files.sh` fails on any dynamic `process.env[...]` in client-bundled code.

This is also why the authoritative build check lives in
`apps/web/scripts/check-build-network.mjs` — plain Node, before the bundler runs, immune to
client/server bundling differences.

## Verification

```bash
pnpm check:env     # no secrets, tracked, coherent, client-bundle hygiene
pnpm check:cctp    # our trait vs the live mainnet Circle contract
```

`check-env-files.sh` blocks secret-shaped keys (`*SECRET*`, `*PRIVATE_KEY*`, `*KEYPAIR*`,
`*_TOKEN`, Stellar `S...` seeds, `user:pass@host` URLs) from the committed file. Note that
`TOKEN` is matched as a *suffix* only — matching it anywhere would flag
`STELLAR_TOKEN_MESSENGER_ADDRESS`, and a check that cries wolf is a check people learn to
ignore.

## Secrets

Never in these files. They come from AWS Secrets Manager at runtime:

`RELAY_SOLANA_KEYPAIR`, `SOLVER_SOLANA_KEYPAIR`, `SOLVER_STELLAR_SECRET`, `DATABASE_URL`,
and any credential-bearing `REDIS_URL` / `KAFKA_BROKERS`.

Two known issues, tracked, not yet fixed:

- `apps/cctp-relay/src/config.ts:23` documents `RELAY_SOLANA_KEYPAIR` as base58 but
  `index.ts:34` decodes base64. Whoever populates that secret from the doc comment gets a
  broken keypair.
- ECS injects Secrets Manager values as **plaintext process env**, so anything that can read
  `/proc/<pid>/environ` or dump a task definition gets the relay and solver hot wallets. Only
  the arbiter uses KMS properly.

## Promotion checklist

1. `scripts/check-cctp-interface.sh` — Circle can redeploy.
2. Deploy the wrapper: `SOURCE=… ADMIN=… PAUSER=… FEE_RECIPIENT=… scripts/deploy-cctp-wrapper.sh`
   (gated on the interface check, the test suite, a release build, and a typed confirmation).
3. Fill `STELLAR_CCTP_WRAPPER_CONTRACT_ID` and `NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID`
   in `.env.production` from `deployments/mainnet.json`.
4. Build `apps/web` with `.env.production` values as **Docker build args** — runtime env is a
   no-op for `NEXT_PUBLIC_*`.
5. `scripts/check-env-files.sh`.
6. Confirm the bug-bounty period agreed as the launch gate has actually elapsed.

`ADMIN` and `PAUSER` must be different keys held by different operators. The pauser exists so
a compromised admin can still be stopped by someone else; making them the same address
removes the only check on a stolen admin key. The deploy script warns, but does not block.
