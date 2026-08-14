import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";

/**
 * Arc chain id/RPC are read from env rather than hardcoded — same principle as
 * packages/cctp-client's domain config: a wrong guessed chain id would silently point wallet
 * signatures at the wrong EIP-712 domain, which is worse than a loud missing-env-var failure.
 * Set NEXT_PUBLIC_ARC_CHAIN_ID / NEXT_PUBLIC_ARC_RPC_URL per environment.
 */
const arcChainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? "9001");
const arcRpcUrl = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "http://localhost:8545";

export const arc = defineChain({
  id: arcChainId,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [arcRpcUrl] },
  },
});

export const wagmiConfig = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: {
    [arc.id]: http(arcRpcUrl),
  },
});
