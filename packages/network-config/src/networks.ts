/**
 * Canonical, pinned constants for the chains Xebra touches.
 *
 * # Mainnet only
 *
 * There is exactly one network. Testnet and local presets were removed deliberately: the
 * product is a mainnet USDC bridge, and every additional "network" was a second set of
 * addresses that could be mixed into the first. A single preset makes the whole class of
 * wrong-network bug impossible rather than merely detectable.
 *
 * # Provenance
 *
 * Every address here was read from the live chain, not from documentation:
 *
 * - Stellar CCTP contract ids: `stellar contract info interface` against mainnet. The
 *   deployed `deposit_for_burn` signature was confirmed byte-identical to the trait in
 *   `contracts/stellar-cctp-wrapper/src/lib.rs` (see `scripts/check-cctp-interface.sh`).
 * - Stellar USDC SAC: derived with `stellar contract id asset` from Circle's mainnet issuer
 *   GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN, and confirmed registered with
 *   the TokenMessengerMinter: `get_token_decimal_config` -> `{canonical: 6, local: 7}`,
 *   `get_max_burn_amount_per_message` -> 10,000,000 USDC.
 * - Solana program ids and USDC mint: `getAccountInfo` against mainnet-beta; the mint is a
 *   6-decimal SPL token owned by the Token program.
 * - Solana is registered as remote domain 5 on the Stellar messenger:
 *   `get_remote_token_messenger(5)` -> `a65fc81d...` (a Solana-shaped 32-byte value, as
 *   distinct from the left-padded EVM shape returned for domains 0 and 26).
 *
 * Re-verify with `scripts/check-cctp-interface.sh` before any deploy. Circle can redeploy.
 */

export const NETWORKS = ["mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

/** CCTP domain ids. A domain identifies a *chain*, not a cluster. */
export const CCTP_DOMAIN = {
  ethereum: 0,
  solana: 5,
  arc: 26,
  stellar: 27,
} as const;

export interface StellarPreset {
  networkPassphrase: string;
  sorobanRpcUrl: string;
  horizonUrl: string;
  cctpDomainId: number;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
}

export interface SolanaPreset {
  rpcUrl: string;
  cctpDomainId: number;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
}

export interface NetworkPreset {
  network: Network;
  stellar: StellarPreset;
  solana: SolanaPreset;
  irisBaseUrl: string;
}

export const PRESETS: Record<Network, NetworkPreset> = {
  mainnet: {
    network: "mainnet",
    stellar: {
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      sorobanRpcUrl: "https://mainnet.sorobanrpc.com",
      horizonUrl: "https://horizon.stellar.org",
      cctpDomainId: CCTP_DOMAIN.stellar,
      tokenMessengerAddress: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
      messageTransmitterAddress: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
      usdcAddress: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    },
    solana: {
      rpcUrl: "https://api.mainnet-beta.solana.com",
      cctpDomainId: CCTP_DOMAIN.solana,
      tokenMessengerAddress: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
      messageTransmitterAddress: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
      usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
    irisBaseUrl: "https://iris-api.circle.com",
  },
};

/** The mainnet passphrase. A transaction signed against any other network is simply invalid,
 *  which makes this the least forgeable network fingerprint available. */
export const MAINNET_PASSPHRASE = PRESETS.mainnet.stellar.networkPassphrase;
