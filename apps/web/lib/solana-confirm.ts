import type { Connection, SignatureStatus } from "@solana/web3.js";

/**
 * Waits for a Solana transaction by polling its status.
 *
 * `connection.confirmTransaction(sig, commitment)` waits on a websocket subscription, and the
 * browser reaches Solana through `/api/solana-rpc`, a plain HTTP route that cannot serve one, so
 * the wait can run out with an error for a transaction that landed. It also resolves, rather than
 * throws, for a transaction that landed and failed. `getSignatureStatuses` is on the proxy's
 * allow-list and reports both.
 *
 * A timeout does not mean the transaction failed, only that it was not seen in time, so the error
 * says to look it up before trying again.
 */
export async function waitForSignature(
  connection: Connection,
  signature: string,
  { timeoutMs = 90_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: SignatureStatus | null = null;
    try {
      status = (await connection.getSignatureStatuses([signature])).value[0] ?? null;
    } catch {
      // A dropped poll is not a verdict on the transaction; the next one decides.
    }
    if (status?.err) {
      throw new Error(`Solana rejected transaction ${signature}: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Transaction ${signature} was not confirmed within ${Math.round(timeoutMs / 1000)} seconds. It may still land: look it up on Solscan before trying again.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
