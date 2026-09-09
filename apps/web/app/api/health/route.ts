import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/**
 * Whether the relay can currently do its job. Point a free uptime monitor at this.
 *
 * # Why an HTTP endpoint and not just the Convex cron
 *
 * The cron throws when the balance is critical, which surfaces in the Convex dashboard. That is
 * only useful to someone already looking at it. This returns **503**, which is the one signal
 * every uptime monitor understands and will email or text you about without configuration.
 *
 * The failure it exists for is the hot wallet running dry. That stalls every transfer at once, and
 * stalls them *silently* — a job that cannot be paid for is indistinguishable from a job waiting on
 * Circle's attestation, so nothing errors and nobody notices until a user complains.
 *
 * # Why it is unauthenticated
 *
 * It reports a balance and a threshold. Both are already public: the hot wallet is an address on a
 * public chain. Requiring a secret would mean only things holding secrets can check it, which rules
 * out every free monitor — and an alert nobody receives is not an alert.
 */

export const dynamic = "force-dynamic";

const health = makeFunctionReference<"action">("relay:health");

export async function GET(): Promise<Response> {
  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return Response.json(
      { ok: false, level: "critical", message: "no relay is configured for this deployment" },
      { status: 503 },
    );
  }

  try {
    const result = (await new ConvexHttpClient(convexUrl).action(health, {})) as {
      ok: boolean;
      level: string;
      message: string;
    };
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (err) {
    // Unreachable Convex means the relay is not running at all, which is exactly what should page.
    return Response.json(
      {
        ok: false,
        level: "critical",
        message: `could not reach the relay: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 503 },
    );
  }
}
