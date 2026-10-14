/**
 * The EVM chains USDC moves between, as the browser knows them.
 *
 * A literal copy of `EVM_CHAINS` in `packages/network-config`, for the reason `lib/env.ts` gives:
 * importing that package into client code drags its whole preset table and validator into the
 * bundle. A second copy is only safe if a test can tell it drifted, and `evm-chains.test.ts`
 * asserts this one equals the pinned table field for field. Change them together, after
 * `pnpm check:evm` has re-read the values from the chains.
 *
 * On these routes the browser calls Circle's contracts directly. There is no Xebra contract to
 * refuse a wrong token or a wrong domain, so these rows are what a transfer is built from.
 */

export type EvmChainId =
  | "avalanche"
  | "optimism"
  | "arbitrum"
  | "base"
  | "polygon"
  | "unichain"
  | "codex"
  | "sonic"
  | "worldchain"
  | "monad"
  | "sei"
  | "xdc"
  | "hyperevm"
  | "ink"
  | "arc";

export interface EvmChain {
  id: EvmChainId;
  name: string;
  chainId: number;
  cctpDomainId: number;
  /** The 6-decimal USDC that CCTP burns and mints on this chain. */
  usdcAddress: string;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  /** Never called. Listed so a mint can be refused when it names this contract as recipient. */
  tokenMinterAddress: string;
  /** For handing a wallet a chain it has never seen. Transfers go through the wallet's own node. */
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Whether Circle offers Fast Transfer for burns made on this chain. */
  fast: boolean;
  /** The most Circle may be paid to deliver a transfer into this chain, in 6-decimal units. */
  maxForwardFeeUnits: number;
  /** What claiming by hand costs here, said plainly. */
  claimCost: string;
  /** How long a Standard burn made here takes to be attested. Circle's figures, not yet ours. */
  standardEta: string;
}

/** Circle's three contracts, at the one address they have on every chain here. */
const CIRCLE = {
  tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  tokenMinterAddress: "0xfd78EE919681417d192449715b2594ab58f5D002",
} as const;

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

export const EVM_CHAINS: Record<EvmChainId, EvmChain> = {
  avalanche: {
    id: "avalanche",
    name: "Avalanche",
    chainId: 43114,
    cctpDomainId: 1,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    ...CIRCLE,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little AVAX for gas",
    standardEta: "under a minute",
  },
  optimism: {
    id: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    cctpDomainId: 2,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    ...CIRCLE,
    rpcUrl: "https://optimism-rpc.publicnode.com",
    explorerUrl: "https://optimistic.etherscan.io",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on OP Mainnet for gas",
    standardEta: "15 to 20 minutes",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    chainId: 42161,
    cctpDomainId: 3,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    ...CIRCLE,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Arbitrum for gas",
    standardEta: "15 to 20 minutes",
  },
  base: {
    id: "base",
    name: "Base",
    chainId: 8453,
    cctpDomainId: 6,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ...CIRCLE,
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Base for gas",
    standardEta: "15 to 20 minutes",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    chainId: 137,
    cctpDomainId: 7,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    ...CIRCLE,
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    explorerUrl: "https://polygonscan.com",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little POL for gas",
    standardEta: "under a minute",
  },
  unichain: {
    id: "unichain",
    name: "Unichain",
    chainId: 130,
    cctpDomainId: 10,
    usdcAddress: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    ...CIRCLE,
    rpcUrl: "https://mainnet.unichain.org",
    explorerUrl: "https://uniscan.xyz",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Unichain for gas",
    standardEta: "15 to 20 minutes",
  },
  codex: {
    id: "codex",
    name: "Codex",
    chainId: 81224,
    cctpDomainId: 12,
    usdcAddress: "0xd996633a415985DBd7D6D12f4A4343E31f5037cf",
    ...CIRCLE,
    rpcUrl: "https://rpc.codex.xyz",
    explorerUrl: "https://explorer.codex.xyz",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Codex for gas",
    standardEta: "15 to 20 minutes",
  },
  sonic: {
    id: "sonic",
    name: "Sonic",
    chainId: 146,
    cctpDomainId: 13,
    usdcAddress: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    ...CIRCLE,
    rpcUrl: "https://rpc.soniclabs.com",
    explorerUrl: "https://sonicscan.org",
    nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little S for gas",
    standardEta: "under a minute",
  },
  worldchain: {
    id: "worldchain",
    name: "World Chain",
    chainId: 480,
    cctpDomainId: 14,
    usdcAddress: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    ...CIRCLE,
    rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
    explorerUrl: "https://worldscan.org",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on World Chain for gas",
    standardEta: "15 to 20 minutes",
  },
  monad: {
    id: "monad",
    name: "Monad",
    chainId: 143,
    cctpDomainId: 15,
    usdcAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    ...CIRCLE,
    rpcUrl: "https://rpc.monad.xyz",
    explorerUrl: "https://monadscan.com",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little MON for gas",
    standardEta: "under a minute",
  },
  sei: {
    id: "sei",
    name: "Sei",
    chainId: 1329,
    cctpDomainId: 16,
    usdcAddress: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    ...CIRCLE,
    rpcUrl: "https://evm-rpc.sei-apis.com",
    explorerUrl: "https://seitrace.com",
    nativeCurrency: { name: "Sei", symbol: "SEI", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little SEI for gas",
    standardEta: "under a minute",
  },
  xdc: {
    id: "xdc",
    name: "XDC",
    chainId: 50,
    cctpDomainId: 18,
    usdcAddress: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
    ...CIRCLE,
    rpcUrl: "https://rpc.xdcrpc.com",
    explorerUrl: "https://xdcscan.com",
    nativeCurrency: { name: "XDC", symbol: "XDC", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little XDC for gas",
    standardEta: "under a minute",
  },
  hyperevm: {
    id: "hyperevm",
    name: "HyperEVM",
    chainId: 999,
    cctpDomainId: 19,
    usdcAddress: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    ...CIRCLE,
    rpcUrl: "https://rpc.hyperliquid.xyz/evm",
    explorerUrl: "https://hyperevmscan.io",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little HYPE for gas",
    standardEta: "under a minute",
  },
  ink: {
    id: "ink",
    name: "Ink",
    chainId: 57073,
    cctpDomainId: 21,
    usdcAddress: "0x2D270e6886d130D724215A266106e6832161EAEd",
    ...CIRCLE,
    rpcUrl: "https://rpc-gel.inkonchain.com",
    explorerUrl: "https://explorer.inkonchain.com",
    nativeCurrency: ETH,
    fast: true,
    maxForwardFeeUnits: 500_000,
    claimCost: "a little ETH on Ink for gas",
    standardEta: "about 30 minutes",
  },
  arc: {
    id: "arc",
    name: "Arc",
    chainId: 5042,
    cctpDomainId: 26,
    usdcAddress: "0x3600000000000000000000000000000000000000",
    ...CIRCLE,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    // Arc's gas token is USDC at 18 decimals; the ERC-20 interface above is the same money at 6.
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    fast: false,
    maxForwardFeeUnits: 100_000,
    claimCost: "well under a cent, paid in USDC",
    standardEta: "under a minute",
  },
};

export const EVM_CHAIN_IDS = Object.keys(EVM_CHAINS) as EvmChainId[];

/** The EVM chains that pair with Arc, both ways. Every EVM route has Arc at one end. */
export const EVM_ARC_PEERS = EVM_CHAIN_IDS.filter((id) => id !== "arc");

/**
 * Solana as a destination from Arc. Not an EVM chain: the recipient is a USDC token account, and
 * Circle can open it during delivery for a higher fee with its own ceiling. A copy of
 * `SOLANA_FROM_ARC` in `packages/network-config`, held to it by `evm-chains.test.ts`.
 */
export const SOLANA_FROM_ARC = {
  cctpDomainId: 5,
  maxForwardFeeUnits: 500_000,
  maxForwardFeeNewAccountUnits: 1_000_000,
} as const;

/** What a build can switch on: an EVM chain both ways with Arc, or Solana as a place Arc sends to. */
export type PeerId = Exclude<EvmChainId, "arc"> | "solana";

/** Where a transfer from an EVM chain can land. */
export type RouteDestinationId = EvmChainId | "solana";

export const ARC_PEERS: readonly PeerId[] = [...EVM_ARC_PEERS, "solana"];

export function isEvmChainId(value: string): value is EvmChainId {
  return Object.hasOwn(EVM_CHAINS, value);
}

export function evmChainForDomain(domain: number): EvmChain | null {
  return Object.values(EVM_CHAINS).find((c) => c.cctpDomainId === domain) ?? null;
}

export function evmChainForChainId(chainId: number): EvmChain | null {
  return Object.values(EVM_CHAINS).find((c) => c.chainId === chainId) ?? null;
}

/**
 * Where USDC can go from `source`, given what this build has switched on: Arc reaches every
 * enabled peer (Solana included), and an enabled EVM peer reaches Arc. Anything not enabled
 * reaches nothing.
 */
export function evmDestinationsFrom(
  source: EvmChainId,
  enabledPeers: readonly PeerId[],
): RouteDestinationId[] {
  if (source === "arc") return ARC_PEERS.filter((id) => enabledPeers.includes(id));
  return enabledPeers.includes(source) ? ["arc"] : [];
}

/**
 * The EVM chains a transfer can start from in this build: the enabled EVM peers, and Arc whenever
 * anything at all is enabled. Solana is never a source here.
 */
export function evmSources(enabledPeers: readonly PeerId[]): EvmChainId[] {
  const peers = EVM_ARC_PEERS.filter((id) => enabledPeers.includes(id));
  return enabledPeers.length > 0 ? [...peers, "arc"] : [];
}

/**
 * Reads `NEXT_PUBLIC_EVM_ROUTES_ENABLED`: a comma-separated list of what to switch on (an EVM
 * chain, both ways with Arc, or `solana`, as a destination from Arc), or `all`. Absent or empty
 * means none.
 *
 * A name that is not one of those throws. A typo here must fail the build, not quietly leave a
 * route off, and certainly not switch on something nobody named.
 */
export function parseEnabledPeers(raw: string | null | undefined): PeerId[] {
  const value = (raw ?? "").trim();
  if (value === "") return [];
  if (value === "all") return [...ARC_PEERS];
  const names = value.split(",").map((s) => s.trim());
  for (const name of names) {
    if (!(ARC_PEERS as readonly string[]).includes(name)) {
      throw new Error(
        `NEXT_PUBLIC_EVM_ROUTES_ENABLED names "${name}", which is not one of: ${ARC_PEERS.join(", ")}, all`,
      );
    }
  }
  return ARC_PEERS.filter((id) => names.includes(id));
}

export const explorerTxUrl = (chain: EvmChain, hash: string) => `${chain.explorerUrl}/tx/${hash}`;
