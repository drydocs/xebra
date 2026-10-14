import { type CircleHealth, MAX_SANE_FORWARD_FEE_UNITS, checkCircle } from "@xebra/cctp-client";
import { CCTP_DOMAIN, SOLANA_FROM_ARC, evmChainForDomain } from "@xebra/network-config";
import { irisBaseUrl, irisBudget, irisFetch, stellarDomainId } from "../../../lib/server/iris";
import { isOfferedRoute, readDomain } from "../../../lib/server/routes";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * Is Circle answering well enough to start a transfer? The page asks before it lets anyone sign.
 *
 * A transfer is a burn on the source chain (Stellar, or an EVM chain) followed by Circle minting
 * on the destination. With no relay to fall back on, a burn made while Circle is down is USDC the
 * owner has to claim by hand, paying gas on a chain they may hold nothing on. Declining to *start*
 * is free; this is what makes it possible.
 *
 * `down` means do not sign. `degraded` means signing is fine and something is worth saying (slow,
 * or our own rate limit is holding back status reads). See `checkCircle` for what is probed, what
 * deliberately is not, and the one failure no pre-flight can see.
 *
 * A route is named by its two CCTP domains, `?src=&dst=`, and only the pairs this product offers
 * are answered. A delivery fee into an EVM chain is judged against that chain's own ceiling
 * (`maxForwardFeeUnits`), because delivery honestly costs more on some chains than others. Into
 * Solana from Arc it has Solana's ceilings; from Stellar, the wrapper holds its own caps on chain and
 * the page checks the quote against them, so only the general sanity ceiling applies here.
 *
 * `?dest=solana|arc` is the older form, for Stellar to those two. The page no longer asks it, and it
 * stays because the production smoke test does (`scripts/smoke-prod.sh`), and so a page loaded
 * before a deploy keeps working through it.
 *
 * Public and unauthenticated: it reports public facts about Circle's API. Answers are cached for
 * thirty seconds per route, so page loads do not become Iris calls.
 */

export const dynamic = "force-dynamic";

const DESTINATIONS = { solana: CCTP_DOMAIN.solana, arc: CCTP_DOMAIN.arc } as const;
type Destination = keyof typeof DESTINATIONS;

const cached = createTtlCache<CircleHealth>(30_000);

function withBudget(health: CircleHealth): Response {
  // Which counter is actually in use. `shared` is the intended state; `local` means the shared store is
  // unreachable or its secret does not match Convex's, and each instance is counting alone. The
  // smoke test (`scripts/smoke-prod.sh`) fails on it.
  const budgetBackend = irisBudget().backend?.() ?? "local";
  return Response.json({ ...health, budgetBackend }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  if (params.has("src") || params.has("dst")) {
    const src = readDomain(params.get("src"));
    const dst = readDomain(params.get("dst"));
    if (src === null || dst === null || !isOfferedRoute(src, dst, stellarDomainId())) {
      return Response.json({ error: "src and dst must name a route we offer" }, { status: 400 });
    }
    // Solana is the one destination here that is not an EVM chain. Circle prices opening the
    // recipient's USDC account separately, and from Arc that price has its own ceiling.
    const toSolana = dst === CCTP_DOMAIN.solana;
    const newAccount = toSolana && params.get("newAccount") === "1";
    const maxFeeUnits = !toSolana
      ? evmChainForDomain(dst)?.maxForwardFeeUnits
      : src === stellarDomainId()
        ? MAX_SANE_FORWARD_FEE_UNITS
        : newAccount
          ? SOLANA_FROM_ARC.maxForwardFeeNewAccountUnits
          : SOLANA_FROM_ARC.maxForwardFeeUnits;
    if (maxFeeUnits === undefined) {
      return Response.json({ error: "src and dst must name a route we offer" }, { status: 400 });
    }
    const health = await cached(`${src}>${dst}:${newAccount}`, () =>
      checkCircle({
        baseUrl: irisBaseUrl(),
        sourceDomain: src,
        destDomain: dst,
        includeRecipientSetup: newAccount,
        fetch: irisFetch,
        store: irisBudget(),
        maxFeeUnits,
      }),
    );
    return withBudget(health);
  }

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

  return withBudget(health);
}
