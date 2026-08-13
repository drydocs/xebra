/**
 * @xebra/chain-adapters — Watch/Fill/Claim adapter interfaces and per-chain implementations,
 * composed by apps/solver per corridor. See docs/architecture.md §7.
 *
 * Currently implemented: the Solana memo/transfer delivery convention (§4), consumed by the
 * Solana Fill/Claim adapters once apps/solver's chain-adapter refactor lands.
 */

export * from "./solana/delivery.js";
export * from "./solana/verify.js";
