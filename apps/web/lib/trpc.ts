import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@xebra/api/router";

/**
 * apps/web's only backend touchpoint (docs/architecture.md §8/§9: the frontend never hits Arc/
 * Stellar/Solana RPC or Horizon directly). Type-only import of AppRouter from apps/api — no
 * runtime dependency on the API package, just its type, for end-to-end type safety.
 */
export const trpc = createTRPCReact<AppRouter>();
