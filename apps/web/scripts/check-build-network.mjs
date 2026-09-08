#!/usr/bin/env node
/**
 * Build-time network validation for apps/web. Chained into the `build` script (NOT a
 * `prebuild` hook — pnpm leaves enable-pre-post-scripts false by default, so a hook would
 * never run and the guard would be silently inert).
 *
 * It lives here rather than inside the bundle for two reasons:
 *
 * 1. **It cannot be defeated by client/server bundling differences.** Plain Node, plain
 *    `process.env`, before webpack is involved. An earlier version relied on a check inside
 *    lib/env.ts and hit exactly that problem: webpack only inlines `NEXT_PUBLIC_*` for
 *    literal member expressions, so a dynamic lookup was `undefined` in the browser while
 *    working perfectly on the server.
 *
 * 2. **It keeps @xebra/network-config out of the client bundle.** Importing the validator
 *    into lib/env.ts dragged the whole PRESETS table in — contract addresses, RPC URLs and
 *    passphrases shipped to every browser. All public values, so not a secret leak, but it
 *    meant a bundle's target network could not be determined by inspecting it.
 *
 * This is a mainnet-only build. `EXPECTED_NETWORK` is no longer needed to catch a shadowed
 * `.env.local` — that file, and testnet support generally, has been removed.
 */

import { assertNetwork } from "@xebra/network-config";

const actual = process.env.NEXT_PUBLIC_NETWORK?.trim();

function die(message) {
  console.error(`\nFAIL: ${message}\n`);
  process.exit(1);
}

if (!actual) {
  die(
    "NEXT_PUBLIC_NETWORK is not set.\n" +
      "  NEXT_PUBLIC_* values are inlined at BUILD time, so they must be present when the\n" +
      "  bundle is compiled — as Docker build args in CI, or via `pnpm build` / `pnpm dev`,\n" +
      "  which load .env.production through scripts/with-env.mjs.",
  );
}

if (actual !== "mainnet") {
  die(
    `NEXT_PUBLIC_NETWORK="${actual}". This is a mainnet-only build; testnet support was removed.`,
  );
}

// Coherence of the values that will actually be baked into the bundle: a mainnet build
// pointed at a devnet RPC, or carrying a testnet passphrase, fails here.
try {
  assertNetwork("mainnet", {
    NETWORK: actual,
    STELLAR_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
    SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    STELLAR_USDC_ADDRESS: process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS,
  });
} catch (err) {
  die(`the NEXT_PUBLIC_* chain values are not coherent.\n\n  ${err.message}`);
}

console.log("  build-network: mainnet, values coherent");
