"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { env } from "../lib/env";
import { trpc } from "../lib/trpc";

/**
 * `WagmiProvider` used to wrap this tree. It has been removed.
 *
 * Wagmi existed solely for corridor 1 (Arc, an EVM chain), which is not in scope: the product
 * is a USDC bridge over CCTP, Stellar → Solana. The Stellar flow uses Stellar Wallets Kit and
 * never touched wagmi.
 *
 * Keeping it was actively harmful. Wagmi requires at least one chain, and with the Arc
 * variables unset the config fell back to a fabricated chain with `rpcUrls.default.http: []`
 * and `transports: { 1: http() }` — and `http()` with no URL resolves to
 * `rpcUrls.default.http[0]`, i.e. `undefined`. That is a provider that cannot serve a single
 * request, mounted on every page, in service of a chain the product does not use.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      // Must match apps/api's router transformer (superjson) — see apps/api/README.md.
      // apps/api backs the intent-rail status pages only; the CCTP bridge flow talks to
      // Soroban directly. When NEXT_PUBLIC_API_URL is unset the client is still constructed
      // (tRPC's provider requires one) but points at a path that fails loudly if anything
      // ever calls it, rather than silently succeeding against the wrong origin.
      links: [httpBatchLink({ url: env.apiUrl ?? "/api-not-configured", transformer: superjson })],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
