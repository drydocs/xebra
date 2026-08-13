import { hashTypedData } from "viem";

/**
 * The Arc contract's exact EIP-712 domain and type layout (contracts/arc-evm/src/XebraEscrow.sol
 * `INTENT_TYPEHASH` + `EIP712("Xebra", "1")`). Kept byte-for-byte in sync with that frozen
 * contract — this is what lets a caller compute the same intent hash the contract will, before
 * ever submitting a transaction.
 */
const ARC_INTENT_TYPES = {
  Intent: [
    { name: "user", type: "address" },
    { name: "sourceToken", type: "address" },
    { name: "sourceAmount", type: "uint256" },
    { name: "destAsset", type: "bytes32" },
    { name: "minDestAmount", type: "uint256" },
    { name: "destAddress", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface ArcLegacyIntent {
  user: `0x${string}`;
  sourceToken: `0x${string}`;
  sourceAmount: bigint;
  destAsset: `0x${string}`;
  minDestAmount: bigint;
  destAddress: `0x${string}`;
  expiry: bigint;
  nonce: bigint;
}

/**
 * Reproduces `XebraEscrow.hashIntent()` off-chain. Safe to reimplement independently because
 * EIP-712 is a published, versioned standard — unlike Soroban's XDR encoding (see
 * `stellarIntentHashNotReimplemented` below), there's no risk of silently drifting from the
 * contract's own computation as long as the domain/types above stay in sync with the .sol file.
 */
export function hashArcIntent(
  intent: ArcLegacyIntent,
  chainId: number,
  verifyingContract: `0x${string}`,
): `0x${string}` {
  return hashTypedData({
    domain: { name: "Xebra", version: "1", chainId, verifyingContract },
    types: ARC_INTENT_TYPES,
    primaryType: "Intent",
    message: intent,
  });
}

/**
 * Stellar-source intent hashes are computed ON-CHAIN by `XebraEscrow.hash_intent()`
 * (contracts/stellar-soroban/src/lib.rs) — `keccak256` over the intent's Soroban-XDR encoding.
 * That encoding is an internal `soroban-sdk` implementation detail, not a published wire format
 * the way EIP-712 is, so a hand-rolled TypeScript reimplementation of it could silently drift
 * from the contract's actual bytes with no compiler or test to catch it.
 *
 * Deliberately not reimplemented here. Callers needing this hash before submission should
 * simulate `hash_intent` against Soroban RPC (a free, read-only call) rather than trust a
 * parallel JS computation of it. See docs/architecture.md §1's "verify at build time" note.
 */
export function stellarIntentHashNotReimplemented(): never {
  throw new Error(
    "Stellar-source intent hashes come from XebraEscrow.hash_intent() via Soroban RPC simulate, " +
      "not from a TypeScript reimplementation — see packages/intent-schema/src/hash.ts",
  );
}
