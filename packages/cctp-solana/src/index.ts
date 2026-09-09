/**
 * @xebra/cctp-solana — the mint half of the CCTP corridor: CCTP V2's `receiveMessage`
 * instruction for Solana, and a submitter that signs and sends it.
 *
 * Extracted from apps/cctp-relay so `apps/web` can run the same code as a Vercel function.
 * There is no long-running relay process in the Vercel deployment — a cron-invoked route drives
 * the same pipeline — and duplicating an instruction whose account list was verified against
 * mainnet is exactly the kind of duplication that drifts.
 *
 * Kept out of @xebra/cctp-client on purpose: that package is pure orchestration with no runtime
 * dependencies, and it is imported by services that never touch Solana.
 */

export * from "./decode-keypair.js";
export * from "./receive-message.js";
export * from "./mint-submitter.js";
