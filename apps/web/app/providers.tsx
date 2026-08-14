"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { WagmiProvider } from "wagmi";
import { trpc } from "../lib/trpc";
import { wagmiConfig } from "../lib/wagmi";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      // Must match apps/api's router transformer (superjson) — see apps/api/README.md.
      links: [httpBatchLink({ url: API_URL, transformer: superjson })],
    }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </WagmiProvider>
  );
}
