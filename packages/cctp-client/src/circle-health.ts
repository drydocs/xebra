import { type BudgetStore, type BudgetUsage, IrisUnavailable } from "./iris-budget.js";

/**
 * Is Circle answering well enough to bridge through right now?
 *
 * # What this is for
 *
 * A transfer here is a burn on Stellar followed by Circle minting on the destination. If Circle's
 * side is down when the user signs, the burn still happens and the USDC is gone from their wallet
 * until someone mints it — and with no relay, that someone is the user, paying gas on a chain they
 * may hold nothing on. Refusing to *start* a transfer while Circle is visibly unwell costs nothing
 * and avoids that.
 *
 * # What it checks
 *
 * Two live calls, both to Circle's production Iris API:
 *
 *   - the **forward-fee quote** for the route. It must answer, must offer forwarding for this route,
 *     and must return sane numbers. This is also the price the page is about to sign, so a route
 *     Circle has stopped quoting is a route the page must not send.
 *   - the **public attestation keys**. Attestations cannot be verified without them.
 *
 * # What it deliberately does not use
 *
 * Circle's status page. Its raw feed still flags the main CCTP component as a major outage with a
 * date in December 2025, while CCTP demonstrably works, so a check keyed on it would refuse every
 * transfer. The two probes above are what the transfer itself depends on.
 *
 * # What it cannot see
 *
 * A stalled attestation *indexer* — burns that succeed on Stellar but that Iris never picks up. That
 * happened to Circle's sandbox for us for a full day while its quote and key endpoints answered
 * normally. Nothing checked before a burn can detect it; only the burn's own outcome can.
 *
 * # Our own rate limit is not Circle being down
 *
 * If our budget holds a call back, or Circle has answered us 429, we cannot *read* Iris for a while.
 * That says nothing about whether Circle will mint a burn, and it must not stop anyone bridging.
 * It is reported as `degraded`, never `down`.
 */

export type HealthStatus = "ok" | "degraded" | "down";

/** A forward fee in USDC minor units (6 decimals), the tiers Circle quotes. */
export interface ForwardQuote {
  low: number;
  med: number;
  high: number;
}

export interface CircleHealth {
  status: HealthStatus;
  /** Plain-language reasons, worst first. Empty when `ok`. */
  reasons: string[];
  checkedAt: number;
  /** The route's forward fee, when readable. */
  quote: ForwardQuote | null;
  /** How long the slower of the two calls took. */
  slowestMs: number | null;
  budget: BudgetUsage;
}

/** Highest forward fee we would accept as sane: the contract's own ceiling, 2 USDC in 6 decimals. */
export const MAX_SANE_FORWARD_FEE_UNITS = 2_000_000;

export type QuoteParse = { ok: true; quote: ForwardQuote } | { ok: false; reason: string };

/**
 * Reads Circle's `GET /v2/burn/USDC/fees/{src}/{dst}?forward=true` body. Standard finality (2000) is
 * the only tier Stellar has. The live API names the middle tier `med`; Circle's published spec says
 * `medium`. Both are accepted, because we should not break on either being corrected.
 */
export function parseForwardQuote(
  body: unknown,
  maxFeeUnits: number = MAX_SANE_FORWARD_FEE_UNITS,
): QuoteParse {
  if (!Array.isArray(body))
    return { ok: false, reason: "Circle's fee service returned an unexpected response" };
  const standard = body.find(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      (row as { finalityThreshold?: unknown }).finalityThreshold === 2000,
  );
  if (!standard)
    return { ok: false, reason: "Circle is not quoting Standard transfers for this route" };
  const fee = standard.forwardFee as Record<string, unknown> | undefined;
  if (!fee || typeof fee !== "object") {
    return { ok: false, reason: "Circle is not offering delivery on this route right now" };
  }
  const low = fee.low;
  const med = fee.med ?? fee.medium;
  const high = fee.high;
  for (const [name, v] of [
    ["low", low],
    ["med", med],
    ["high", high],
  ] as const) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return {
        ok: false,
        reason: `Circle's ${name} delivery fee is missing or not a positive number`,
      };
    }
  }
  const q = { low: low as number, med: med as number, high: high as number };
  if (q.high < q.low) return { ok: false, reason: "Circle's delivery fee quote is inconsistent" };
  if (q.high > maxFeeUnits) {
    return {
      ok: false,
      reason: "Circle is quoting an unusually high delivery fee; refusing to send",
    };
  }
  return { ok: true, quote: q };
}

export interface CheckDeps {
  baseUrl: string;
  sourceDomain: number;
  destDomain: number;
  /** Quote the fee for a first-time Solana recipient (Circle creates the token account). */
  includeRecipientSetup?: boolean;
  /** Should be a budgeted fetch (`createBudgetedFetch`), so these calls count against the limit. */
  fetch: typeof fetch;
  store: BudgetStore;
  now?: () => number;
  /** Give up on a call after this long. */
  timeoutMs?: number;
  /** Call the service degraded when the slower call takes longer than this. */
  slowMs?: number;
  /** Call the budget degraded above this fraction of the limit. */
  budgetWarnAt?: number;
  maxFeeUnits?: number;
}

type Outcome<T> =
  | { kind: "ok"; value: T; ms: number }
  | { kind: "hold"; err: IrisUnavailable }
  | { kind: "fail"; why: string };

async function timed<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  now: () => number,
): Promise<Outcome<T>> {
  const start = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race our own timer as well as passing the signal: a fetch that ignores the signal must not be
  // able to hang the check, since the check gates the Bridge button.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("timed out", "TimeoutError"));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([fn(controller.signal), deadline]);
    return { kind: "ok", value, ms: now() - start };
  } catch (e) {
    if (e instanceof IrisUnavailable) return { kind: "hold", err: e };
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      kind: "fail",
      why: timedOut ? "timed out" : e instanceof Error ? e.message : "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a probe, and runs it once more if it failed outright or Circle answered 5xx.
 *
 * `down` stops people bridging, so a false `down` is expensive and a false `ok` is only as bad as
 * having no check. A cold serverless instance pays for DNS and TLS on its first call to Circle, and
 * against the live API that alone has run past the timeout once; one retry on a warm connection is
 * what separates "Circle is down" from "we just woke up". A second failure in a row is believed.
 */
async function withRetry<T extends { status: number }>(
  run: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const first = await run();
  const failed = first.kind === "fail" || (first.kind === "ok" && first.value.status >= 500);
  return failed ? run() : first;
}

export async function checkCircle(deps: CheckDeps): Promise<CircleHealth> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 4_000;
  const slowMs = deps.slowMs ?? 3_000;
  const warnAt = deps.budgetWarnAt ?? 0.75;

  const setup = deps.includeRecipientSetup ? "&includeRecipientSetup=true" : "";
  const feeUrl = `${deps.baseUrl}/v2/burn/USDC/fees/${deps.sourceDomain}/${deps.destDomain}?forward=true${setup}`;
  const keysUrl = `${deps.baseUrl}/v2/publicKeys`;

  const [feeRes, keysRes] = await Promise.all([
    withRetry(() =>
      timed(
        async (signal) => {
          const res = await deps.fetch(feeUrl, { signal });
          return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
        },
        timeoutMs,
        now,
      ),
    ),
    withRetry(() =>
      timed(
        async (signal) => {
          const res = await deps.fetch(keysUrl, { signal });
          const body = res.ok
            ? ((await res.json().catch(() => null)) as { publicKeys?: unknown } | null)
            : null;
          return {
            status: res.status,
            count: Array.isArray(body?.publicKeys) ? body.publicKeys.length : 0,
          };
        },
        timeoutMs,
        now,
      ),
    ),
  ]);

  const down: string[] = [];
  const degraded: string[] = [];
  let quote: ForwardQuote | null = null;
  const times: number[] = [];

  if (feeRes.kind === "hold") {
    degraded.push(
      "We are pausing our requests to Circle for a moment, so we cannot confirm the delivery fee",
    );
  } else if (feeRes.kind === "fail") {
    down.push(`Circle's fee service is not responding (${feeRes.why})`);
  } else {
    times.push(feeRes.ms);
    if (feeRes.value.status >= 500) down.push("Circle's fee service is returning errors");
    else if (feeRes.value.status >= 400) down.push("Circle does not currently offer this route");
    else {
      const parsed = parseForwardQuote(feeRes.value.body, deps.maxFeeUnits);
      if (parsed.ok) quote = parsed.quote;
      else down.push(parsed.reason);
    }
  }

  if (keysRes.kind === "hold") {
    if (!degraded.length) degraded.push("We are pausing our requests to Circle for a moment");
  } else if (keysRes.kind === "fail") {
    down.push(`Circle's attestation service is not responding (${keysRes.why})`);
  } else {
    times.push(keysRes.ms);
    if (keysRes.value.status !== 200 || keysRes.value.count === 0) {
      down.push("Circle's attestation keys are unavailable");
    }
  }

  const slowest = times.length ? Math.max(...times) : null;
  if (slowest !== null && slowest > slowMs) {
    degraded.push(`Circle is responding slowly (${(slowest / 1000).toFixed(1)}s)`);
  }

  const budget = await deps.store.usage(now());
  if (budget.blockedUntil !== null && !degraded.length) {
    degraded.push("We are temporarily rate limited by Circle; delivery status may be unavailable");
  } else if (budget.utilisation >= warnAt) {
    degraded.push("Our request budget for Circle is nearly used up");
  }

  return {
    status: down.length ? "down" : degraded.length ? "degraded" : "ok",
    reasons: [...down, ...degraded],
    checkedAt: now(),
    quote,
    slowestMs: slowest,
    budget,
  };
}
