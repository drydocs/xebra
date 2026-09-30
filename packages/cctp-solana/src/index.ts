/**
 * @xebra/cctp-solana — CCTP V2's `receiveMessage` instruction for Solana.
 *
 * Used by `/claim`, where a user completes their own mint when a forward did not land. Nothing
 * here signs or sends on our behalf: the account list was verified against mainnet, and the page
 * hands the transaction to the user's wallet.
 *
 * Kept out of @xebra/cctp-client on purpose: that package has no chain dependencies.
 */

export * from "./receive-message.js";
