import { type CircleHealth, checkCircle } from "@xebra/cctp-client";
import { CCTP_DOMAIN } from "@xebra/network-config";
import { irisBaseUrl, irisBudget, irisFetch, stellarDomainId } from "../../../lib/server/iris";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * Is Circle answering well enough to start a transfer? The page asks before it lets anyone sign.
 *
 * A transfer is a burn on Stellar followed by Circle minting on the destination. With no relay to
 * fall back on, a burn made while Circle is down is USDC the owner has to claim by hand, paying gas
 * on a chain they may hold nothing on. Declining to *start* is free; this is what makes it possible.
 *
 * `down` means do not sign. `degraded` means signing is fine and something is worth saying (slow,
 * or our own rate limit is holding back status reads). See `checkCircle` for what is probed, what
 * deliberately is not, and the one failure no pre-flight can see.
 *
 * Public and unauthenticated: it reports public facts about Circle's API. Answers are cached for
 * thirty seconds per route, so page loads do not become Iris calls.
 */

export const dynamic = "force-dynamic";

const DESTINATIONS = { solana: CCTP_DOMAIN.solana, arc: CCTP_DOMAIN.arc } as const;
type Destination = keyof typeof DESTINATIONS;

const cached = createTtlCache<CircleHealth>(30_000);

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const dest = params.get("dest");
  if (dest !== "solana" && dest !== "arc") {
    return Response.json({ error: "dest must be one of: solana, arc" }, { status: 400 });
  }
  // Only a Solana recipient can need a token account created for it.
  const newAccount = dest === "solana" && params.get("newAccount") === "1";
  const destDomain = DESTINATIONS[dest satisfies Destination];

  const health = await cached(`${dest}:${newAccount}`, () =>
    checkCircle({
      baseUrl: irisBaseUrl(),
      sourceDomain: stellarDomainId(),
      destDomain,
      includeRecipientSetup: newAccount,
      fetch: irisFetch,
      store: irisBudget(),
    }),
  );

  // Which counter is actually in use. `shared` is the intended state; `local` means the shared store is
  // unreachable or its secret does not match Convex's, and each instance is counting alone. The
  // smoke test (`scripts/smoke-prod.sh`) fails on it.
  const budgetBackend = irisBudget().backend?.() ?? "local";

  return Response.json({ ...health, budgetBackend }, { headers: { "cache-control": "no-store" } });
}
