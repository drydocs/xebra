import { initTRPC } from "@trpc/server";
import { AssetKind, ChainId } from "@xebra/intent-schema";
import superjson from "superjson";
import { z } from "zod";
import type { Context } from "./context.js";
import { resolveQuote } from "./quote.js";
import { getActiveCorridors, getChains, getIntentByHash, getUsdcAssets } from "./repositories.js";

/**
 * apps/api — tRPC + thin REST facade over Postgres (docs/architecture.md §8). This is the
 * *only* thing apps/web talks to; the frontend never hits Arc/Stellar/Solana RPC or Horizon
 * directly. Route handlers stay thin: real logic lives in quote.ts (pure, unit-tested) and
 * repositories.ts (the only Drizzle call sites).
 */

const t = initTRPC.context<Context>().create({ transformer: superjson });

const chainIdSchema = z.nativeEnum(ChainId);
const assetRefSchema = z.object({
  chainId: chainIdSchema,
  kind: z.nativeEnum(AssetKind),
  assetId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as unknown as z.ZodType<`0x${string}`>,
});

export const appRouter = t.router({
  chains: t.procedure.query(async ({ ctx }) => getChains(ctx.db)),

  corridors: t.procedure.query(async ({ ctx }) => getActiveCorridors(ctx.db)),

  /** The authoritative CCTP-direct-vs-intent/swap routing decision (docs/architecture.md §6). */
  quote: t.procedure
    .input(
      z.object({
        sourceChain: chainIdSchema,
        destChain: chainIdSchema,
        destAsset: assetRefSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const [corridorRows, usdcRows] = await Promise.all([
        getActiveCorridors(ctx.db),
        getUsdcAssets(ctx.db),
      ]);
      return resolveQuote(input, corridorRows, usdcRows);
    }),

  /** Public verify/status endpoint — same data a challenger or the frontend's status page
   *  reads. Also exposed over the thin REST facade (docs/architecture.md §8) for non-tRPC
   *  consumers. */
  intentStatus: t.procedure
    .input(z.object({ intentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }))
    .query(async ({ ctx, input }) => {
      const result = await getIntentByHash(ctx.db, input.intentHash);
      if (!result) {
        throw new Error(`no intent found for hash ${input.intentHash}`);
      }
      return result;
    }),
});

export type AppRouter = typeof appRouter;
