import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@xebra/api/router";

/**
 * The intent rail's client for apps/api, used only by the `app/intent/[hash]` status page. The
 * bridge does not go through it: it talks to Soroban RPC, Horizon and the wallets directly, and to
 * this app's own `/api/*` routes for Circle and Solana. Type-only import of AppRouter from
 * apps/api — no runtime dependency on the API package, just its type, for end-to-end type safety.
 */
export const trpc = createTRPCReact<AppRouter>();
