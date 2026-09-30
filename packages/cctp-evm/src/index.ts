/**
 * @xebra/cctp-evm — CCTP V2's `receiveMessage` call for EVM destinations (Arc).
 *
 * Used by `/claim`, where a user completes their own mint when a forward did not land. Nothing
 * here signs or sends on our behalf.
 *
 * Kept out of @xebra/cctp-client for the same reason that package keeps Solana out: it has no
 * chain dependencies.
 */

export * from "./receive-message.js";
