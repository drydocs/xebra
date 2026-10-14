/**
 * @xebra/cctp-client — shared client for Circle's Iris API: attestations, a burn's forward state,
 * the pre-flight check, the shared rate budget, and fields read out of an attested message. Used by
 * apps/web; apps/solver lists it as a dependency but does not import it. See docs/architecture.md §5.
 *
 * Deliberately configuration-driven rather than hardcoding Circle's domain IDs / program
 * addresses: those differ between mainnet/testnet/devnet and have changed as CCTP versions
 * ship (see docs/architecture.md's "verify at build time" note on CCTP V2 Solana program IDs
 * and Stellar/Solana domain parity). Fabricating a plausible-looking constant here would be
 * worse than requiring it as explicit config — a wrong hardcoded address fails silently until
 * funds are on the line; a required-but-missing config value fails immediately at startup.
 */

export interface CctpDomainConfig {
  /** Circle's numeric domain id for this chain in this environment. */
  domainId: number;
  /** TokenMessenger(Minter) contract/program address, chain-native encoding. */
  tokenMessengerAddress: string;
  /** MessageTransmitter contract/program address, chain-native encoding. */
  messageTransmitterAddress: string;
  /** USDC contract/mint address on this chain in this environment. */
  usdcAddress: string;
}

export interface CctpEnvironmentConfig {
  /** e.g. https://iris-api.circle.com (mainnet) or https://iris-api-sandbox.circle.com (testnet). */
  irisBaseUrl: string;
  stellar: CctpDomainConfig;
  solana: CctpDomainConfig;
}
