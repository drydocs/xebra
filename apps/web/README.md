# @xebra/web

Next.js (App Router) frontend for the Stellar→Solana corridor. See docs/architecture.md §9.

- `/` — connect a Stellar wallet (Freighter, via Stellar Wallets Kit), enter the destination
  asset (Solana SPL mint) and address, see the routing decision (`cctp-direct` vs `intent-swap`,
  from apps/api's `quote` procedure — same call the backend re-validates on submission), sign
  and submit `open()` on the Stellar-source XebraEscrow, then redirect to the status page.
- `/intent/[hash]` — shareable per-intent status page, polling apps/api's `intentStatus`
  procedure until the intent reaches a terminal state.

`lib/build-open-intent-params.ts` holds the one piece of pure, testable logic (amount/decimal
conversion) extracted out of the form component — 6 tests, no rendering or wallet needed.
`lib/open-intent.ts` is real `open()`/`hash_intent()` transaction building + signing code
(compiled against `@stellar/stellar-sdk`'s real API) not exercised against a live Soroban RPC in
this build — same caveat as apps/solver's `stellar-claim.ts`.

## Build

```bash
pnpm build
```

Verified: this produces a real, successful production build (not just a typecheck) — including
fixing two build-breaking issues found only by actually running it:

- wagmi's default connector barrel pulls in every connector it ships (Coinbase Smart Wallet →
  `@coinbase/cdp-sdk`'s optional x402 payments feature → peer deps that aren't installed and
  aren't needed, since this app only uses `injected()`). Fixed via a webpack `IgnorePlugin` in
  `next.config.ts`, documented there.
- `StellarWalletsKit` touches `window` at construction time; constructing it in a plain
  `useMemo` broke Next's server-side prerender pass (`ReferenceError: window is not defined`).
  Fixed by lazy-constructing it in a `useEffect` (client-only, post-mount) in `app/page.tsx`.

## Run

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000 \
NEXT_PUBLIC_SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc \
NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID=C... \
NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS=C... \
  pnpm dev
```
