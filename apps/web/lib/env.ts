/**
 * The frontend's single source of network truth.
 *
 * # Why every variable is referenced literally
 *
 * `NEXT_PUBLIC_*` values are **inlined by webpack at compile time**, and that substitution is
 * purely textual: it only fires for a literal member expression like
 * `process.env.NEXT_PUBLIC_NETWORK`. A dynamic lookup — `process.env[name]` — cannot be
 * statically analyzed, so in the **client** bundle it resolves against an empty `process.env`
 * shim and yields `undefined` for everything.
 *
 * That is not theoretical: the first version of this file used a `required(name)` helper
 * doing exactly that, and it threw "NEXT_PUBLIC_NETWORK is not set" in the browser while the
 * variable was correctly set in the server process the whole time.
 *
 * **Never** add a variable here by indexing `process.env`. Add a literal line to RAW.
 * `scripts/check-env-files.sh` fails on any dynamic access in client-bundled code.
 *
 * # Why this file does no cross-validation
 *
 * Validation lives in `scripts/check-build-network.mjs`, which runs in plain Node before the
 * bundler. Importing `@xebra/network-config` here instead dragged its entire PRESETS table
 * into the client bundle — every network's contract addresses, RPC URLs and passphrases
 * shipped in every build. All public values, so not a secret leak, but it meant a bundle's
 * target network could not be determined by inspecting it, since mainnet and testnet
 * constants were both present regardless of which one it was built for.
 *
 * Re-validating in the browser would also prove nothing: by then the values are already
 * baked in. Coherence is a build-time property, checked at build time, once.
 *
 * # Why there are no fallbacks
 *
 * Because `NEXT_PUBLIC_*` is baked in at build time, a production container cannot correct a
 * frontend built against the wrong network. The previous defaults made that dangerous:
 *
 *   lib/wagmi.ts:  process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? "9001"          // anvil
 *   app/page.tsx:  ...PASSPHRASE ?? "Test SDF Network ; September 2015"    // TESTNET
 *
 * A single missing build arg produced a *working* testnet frontend rather than a failed
 * build. Every fallback is gone: a missing variable is a hard failure.
 */

/**
 * Literal references only — see the note above. Webpack replaces each with a string constant
 * at compile time; anything not written this way is `undefined` in the browser.
 */
const RAW = {
  NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK,
  NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
  NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS: process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS,
  NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS:
    process.env.NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS,
  NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID: process.env.NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID,
  NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  NEXT_PUBLIC_SOLANA_USDC_MINT: process.env.NEXT_PUBLIC_SOLANA_USDC_MINT,
  NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID: process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID:
    process.env.NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
} as const;

type RawKey = keyof typeof RAW;

/** Mainnet-only build. Kept as a local literal so this module pulls nothing into the client
 *  bundle; `scripts/check-build-network.mjs` validates the real values before the bundler
 *  runs. */
const KNOWN_NETWORKS = ["mainnet"] as const;
export type Network = (typeof KNOWN_NETWORKS)[number];

function required(name: RawKey): string {
  const value = RAW[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is not set. NEXT_PUBLIC_* values are inlined at BUILD time, so this must be present when the bundle is compiled — as a Docker build arg in CI, or via \`pnpm dev\` which loads .env.local. See docs/environments.md.`,
    );
  }
  return value.trim();
}

function optional(name: RawKey): string | null {
  const value = RAW[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

function resolveNetwork(): Network {
  const raw = required("NEXT_PUBLIC_NETWORK");
  if (!(KNOWN_NETWORKS as readonly string[]).includes(raw)) {
    throw new Error(`NEXT_PUBLIC_NETWORK="${raw}" is not one of: ${KNOWN_NETWORKS.join(", ")}`);
  }
  return raw as Network;
}

const network = resolveNetwork();

export const env = {
  network,
  sorobanRpcUrl: required("NEXT_PUBLIC_SOROBAN_RPC_URL"),
  /** Used only for confirmation polling, which needs no XDR decoding. */
  horizonUrl: required("NEXT_PUBLIC_HORIZON_URL"),
  stellarNetworkPassphrase: required("NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE"),
  /**
   * The destination asset is NOT a user input. For the CCTP rail it is native USDC by
   * definition — burn-and-mint moves the same asset — so it is derived from config per
   * network rather than typed in. See docs/environments.md.
   */
  usdcSacAddress: required("NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS"),
  /** Circle's TokenMessengerMinter, read client-side for the live burn fee. */
  cctpTokenMessengerId: required("NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS"),
  /** CCTP domain of the destination chain. Solana is 5. */
  destinationDomain: Number(required("NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID")),
  /** Destination-chain RPC, used only to confirm the recipient token account exists. */
  solanaRpcUrl: required("NEXT_PUBLIC_SOLANA_RPC_URL"),
  /** USDC mint on the destination chain, for deriving the recipient token account. */
  usdcSolanaMint: required("NEXT_PUBLIC_SOLANA_USDC_MINT"),
  /**
   * Intent/swap-rail only, which is out of scope: the product is a USDC bridge over CCTP.
   * Optional so a mainnet build is not blocked on deploying an escrow the product does not
   * use. Absent means the intent routes are unavailable, not that the build is broken.
   */
  escrowContractId: optional("NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID"),
  /**
   * apps/api backs the intent rail's status pages only. The bridge flow talks to Soroban
   * directly and never calls it, so this is optional for the same reason.
   */
  apiUrl: optional("NEXT_PUBLIC_API_URL"),
  /**
   * Optional until the wrapper is deployed to this network. Deliberately not `required()`:
   * the alternatives are blocking the build before deployment, or inventing a placeholder —
   * and a placeholder contract id in a mainnet bundle is exactly the kind of value that
   * silently sends funds nowhere. Absent means "the CCTP rail is unavailable in this build".
   */
  cctpWrapperContractId: optional("NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID"),
} as const;

/** Whether the CCTP-direct rail can be offered in this build. */
export const isCctpRailConfigured = env.cctpWrapperContractId !== null;

/** True only for a build that will touch real money. Use it to gate destructive UI. */
export const isMainnet = network === "mainnet";
