/**
 * Decides whether to sponsor a mint for a burn somebody handed us by hash.
 *
 * # The problem this solves
 *
 * Until the wrapper contract is deployed, the app burns straight through Circle's
 * TokenMessengerMinter, which serves *every* CCTP user on Stellar. A burn made through our app
 * and a burn made by a stranger are indistinguishable on chain, so an endpoint that accepts a
 * hash and pays for the mint will happily sponsor anyone's transfers. Each one costs us 867,621
 * lamports of permanent rent plus fees, and up to 2,039,280 more if the recipient has no token
 * account — with no fee revenue against it.
 *
 * A shared secret is the clean answer, and it is what the wrapper-less ops path uses. It is not
 * available to a browser: anything the page can send, anyone can read out of the page.
 *
 * # What is done instead, and what it does not do
 *
 * Two bounds, neither of which identifies the caller:
 *
 *   - **Recency.** A burn older than `maxAgeMs` is refused, so nobody can dump a backlog of
 *     historical burns into the queue. Legitimate use submits a burn seconds after signing it.
 *   - **A spend cap.** Beyond `maxMintsPerWindow` relayed mints in `windowMs`, the endpoint stops
 *     sponsoring. This is the bound that actually limits the loss, and it is needed regardless of
 *     abuse, because the hot wallet is finite and running it dry strands nothing but does stall
 *     every transfer until someone notices.
 *
 * Be clear about the residual risk: a determined griefer inside the window can still have a
 * bounded number of their own transfers sponsored. The bound is the mitigation, not prevention.
 * Deploying the wrapper removes the vector entirely, because then the watcher only ever sees
 * burns we were paid a fee on — which is the actual fix and is on the launch path.
 *
 * Refusal is never a loss of funds. The burn stays claimable by anyone holding Circle's
 * attestation, so the worst case for a refused caller is that they pay their own mint gas.
 */

export type AdmissionVerdict =
  | { admit: true; reason?: undefined; retryable?: undefined }
  | {
      admit: false;
      reason: string;
      /**
       * True when the answer could change on its own — the burn exists, we just cannot see it
       * yet. Distinct from a refusal on the merits, because the two deserve opposite responses:
       * one is "wait", the other is "this will never be sponsored".
       */
      retryable?: boolean;
    };

export interface AdmissionPolicy {
  /** Refuse a burn older than this. */
  maxAgeMs: number;
  /** Refuse once this many mints have been sponsored within `windowMs`. */
  maxMintsPerWindow: number;
  windowMs: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  maxAgeMs: 60 * 60 * 1000,
  maxMintsPerWindow: 200,
  windowMs: 24 * 60 * 60 * 1000,
};

export interface AdmissionDeps {
  /**
   * When the burn transaction closed, or `undefined` if it cannot be found.
   *
   * Not-found is reported as *retryable*, not as a flat refusal. A burn submitted a second ago
   * has not reached Horizon's index yet, and the frontend calls this immediately after signing —
   * so on the happy path this lookup loses a race it should not be allowed to lose. Treating
   * that as a refusal told a user their transfer had not been picked up while the watcher was
   * about to mint it.
   */
  burnClosedAt(txHash: string): Promise<number | undefined>;
  /** How many mints have been sponsored since `since`. */
  countSponsoredSince(since: number): Promise<number>;
  now?: () => number;
}

export async function checkBurnAdmission(
  deps: AdmissionDeps,
  txHash: string,
  policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
): Promise<AdmissionVerdict> {
  const now = (deps.now ?? Date.now)();

  const sponsored = await deps.countSponsoredSince(now - policy.windowMs);
  if (sponsored >= policy.maxMintsPerWindow) {
    return {
      admit: false,
      reason:
        "the relay has reached its sponsorship limit for now — your USDC is burned and still " +
        "claimable by anyone holding the attestation",
    };
  }

  const closedAt = await deps.burnClosedAt(txHash);
  if (closedAt === undefined) {
    return {
      admit: false,
      retryable: true,
      reason: "this burn has not reached Horizon's index yet",
    };
  }

  // A future timestamp means clock skew between us and Horizon, not a problem with the burn.
  const age = Math.max(0, now - closedAt);
  if (age > policy.maxAgeMs) {
    return {
      admit: false,
      reason: `that burn is ${Math.round(age / 60_000)} minutes old; the relay only sponsors recent ones`,
    };
  }

  return { admit: true };
}
