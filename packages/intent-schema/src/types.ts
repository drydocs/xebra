/**
 * IntentV2 — the chain-agnostic intent schema. See docs/architecture.md §1.
 *
 * The Arc corridor's on-chain contract (contracts/arc-evm) is frozen and keeps its own
 * EIP-712 `Intent` struct verbatim; `adapters/arc-v1.ts` maps between that legacy shape and
 * this one so the DB/API/frontend can represent every corridor uniformly.
 */

/** Matches the on-chain `ChainId` constants in contracts/stellar-soroban/src/lib.rs. */
export enum ChainId {
  ArcEvm = 1,
  Stellar = 2,
  Solana = 3,
}

export enum AddrEncoding {
  EvmAddress20 = "evm_address_20",
  StellarEd25519_32 = "stellar_ed25519_32",
  SolanaEd25519_32 = "solana_ed25519_32",
}

export enum AssetKind {
  Native = "native",
  EvmErc20 = "evm_erc20",
  StellarClassicAsset = "stellar_classic_asset",
  StellarSorobanToken = "stellar_soroban_token",
  SplToken = "spl_token",
}

/** A 32-byte value, `0x`-prefixed, 64 hex chars. The canonical wire shape for raw address and
 *  asset-id bytes regardless of the native chain's own encoding width or alphabet. */
export type Hex32 = `0x${string}`;

export interface ChainAddress {
  chainId: ChainId;
  encoding: AddrEncoding;
  /** Normalized to a 32-byte slot — e.g. a 20-byte EVM address left-padded with zeros. */
  raw: Hex32;
}

export interface AssetRef {
  chainId: ChainId;
  kind: AssetKind;
  /**
   * Stellar classic assets: sha256(assetCode || issuerAccountId), zero for native XLM (v1
   * spec convention, unchanged). SPL tokens: the raw 32-byte mint pubkey directly — already
   * the right width, no hashing needed. EVM ERC-20s: the left-padded 20-byte contract address.
   */
  assetId: Hex32;
}

export interface IntentV2 {
  version: 2;
  /** Refund recipient on the source chain. */
  user: ChainAddress;
  sourceChain: ChainId;
  sourceAsset: AssetRef;
  sourceAmount: bigint;
  destChain: ChainId;
  destAsset: AssetRef;
  minDestAmount: bigint;
  destAddress: ChainAddress;
  /** Unix seconds. */
  expiry: bigint;
  nonce: bigint;
}
