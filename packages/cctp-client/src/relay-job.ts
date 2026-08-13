import type { IrisClient, IrisMessage } from "./iris.js";

/**
 * The CCTP relay's core state machine (docs/architecture.md §5's `apps/cctp-relay`): watch a
 * burn, wait for Circle's attestation, submit the mint on the destination chain. Kept as pure
 * orchestration logic — `advanceRelayJob` takes its dependencies as injected interfaces, so the
 * whole state machine is unit-testable without a live Iris API or Solana RPC connection. The
 * BullMQ wiring in apps/cctp-relay is a thin shell around this function.
 */

export type RelayJobStatus =
  | "queued"
  | "waiting_attestation"
  | "submitted"
  | "confirmed"
  | "failed";

export interface RelayJobState {
  id: string;
  sourceDomainId: number;
  sourceTxHash: string;
  status: RelayJobStatus;
  message?: `0x${string}`;
  attestation?: `0x${string}`;
  destTxSignature?: string;
  attempts: number;
  lastError?: string;
}

/** Submits the destination-chain `receiveMessage` call. Deliberately an injected interface,
 *  not a concrete Solana implementation, in this package — building the actual CCTP V2 Solana
 *  instruction requires that program's real account layout/IDL (see docs/architecture.md's
 *  "verify at build time" note on CCTP V2 Solana program IDs); apps/cctp-relay wires a real
 *  implementation of this interface against Circle's solana-cctp-contracts SDK. */
export interface MintSubmitter {
  submitReceiveMessage(
    message: `0x${string}`,
    attestation: `0x${string}`,
  ): Promise<{ signature: string }>;
}

export function createQueuedJob(input: {
  id: string;
  sourceDomainId: number;
  sourceTxHash: string;
}): RelayJobState {
  return { ...input, status: "queued", attempts: 0 };
}

/** Advances a job by exactly one step from its current state. Call repeatedly (e.g. on a
 *  polling/backoff schedule) until it reaches `submitted`/`confirmed`/`failed`. Idempotent by
 *  `sourceTxHash` at the caller's job-store layer — safe to retry after a crash. */
export async function advanceRelayJob(
  job: RelayJobState,
  deps: { iris: IrisClient; mint: MintSubmitter },
): Promise<RelayJobState> {
  switch (job.status) {
    case "queued":
    case "waiting_attestation":
      return advanceWaitingForAttestation(job, deps);
    default:
      return job;
  }
}

async function advanceWaitingForAttestation(
  job: RelayJobState,
  deps: { iris: IrisClient; mint: MintSubmitter },
): Promise<RelayJobState> {
  let messages: IrisMessage[];
  try {
    messages = await deps.iris.getMessages(job.sourceDomainId, job.sourceTxHash);
  } catch (err) {
    return { ...job, status: "waiting_attestation", lastError: describeError(err) };
  }

  const msg = messages[0];
  if (!msg || msg.status !== "complete" || !msg.attestation) {
    return { ...job, status: "waiting_attestation" };
  }

  try {
    const { signature } = await deps.mint.submitReceiveMessage(msg.message, msg.attestation);
    return {
      ...job,
      status: "submitted",
      message: msg.message,
      attestation: msg.attestation,
      destTxSignature: signature,
    };
  } catch (err) {
    return {
      ...job,
      status: "failed",
      attempts: job.attempts + 1,
      lastError: describeError(err),
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
