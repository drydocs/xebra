/**
 * Thin client for Circle's Iris attestation API (CCTP V2). Injectable `fetchImpl` so callers
 * (and this package's own tests) never depend on a live network call.
 */

export interface IrisMessage {
  message: `0x${string}`;
  attestation: `0x${string}` | null;
  eventNonce: string;
  status: "pending_confirmations" | "complete";
}

export interface IrisClient {
  /** Fetches CCTP messages emitted by `transactionHash` on `sourceDomainId`. Attestation is
   *  `null` until Circle's attestation service has signed off — poll until `status === "complete"`. */
  getMessages(sourceDomainId: number, transactionHash: string): Promise<IrisMessage[]>;
}

export class IrisApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Iris API error ${status}: ${body}`);
    this.name = "IrisApiError";
  }
}

export function createIrisClient(baseUrl: string, fetchImpl: typeof fetch = fetch): IrisClient {
  return {
    async getMessages(sourceDomainId, transactionHash) {
      const url = `${baseUrl}/v2/messages/${sourceDomainId}?transactionHash=${transactionHash}`;
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new IrisApiError(res.status, await res.text());
      }
      const body = (await res.json()) as { messages?: IrisMessage[] };
      return body.messages ?? [];
    },
  };
}
