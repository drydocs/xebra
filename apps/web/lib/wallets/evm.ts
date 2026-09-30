import type { Connection, Eip1193Provider, WalletEntry } from "./types";

/**
 * EVM wallet discovery by EIP-6963.
 *
 * Reading `window.ethereum` is the old way and it is a race: with two wallets installed, whichever
 * loaded last owns the global, and the user gets a wallet they did not choose. EIP-6963 has every
 * wallet announce itself, with a name and icon, and lets the page pick. `window.ethereum` stays as
 * a fallback for a wallet that predates the standard, listed only when nothing announced.
 *
 * No wagmi: this app connects, reads an address and, on /claim, sends one transaction. A connector
 * framework would be more code and more failure modes than the job (the previous wagmi setup was
 * removed for exactly that; see providers.tsx).
 */

export interface Eip6963Info {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963Detail {
  info: Eip6963Info;
  provider: Eip1193Provider;
}

/** Announcements keyed by rdns, so a wallet that announces twice is listed once. Pure. */
export function reduceAnnouncements(
  current: ReadonlyMap<string, Eip6963Detail>,
  detail: unknown,
): Map<string, Eip6963Detail> {
  const next = new Map(current);
  const d = detail as Partial<Eip6963Detail> | null | undefined;
  if (
    d?.info &&
    typeof d.info.rdns === "string" &&
    typeof d.info.name === "string" &&
    d.provider &&
    typeof d.provider.request === "function"
  ) {
    next.set(d.info.rdns, d as Eip6963Detail);
  }
  return next;
}

const safeIcon = (icon: unknown): string | null =>
  typeof icon === "string" && /^(data:image\/|https:\/\/)/.test(icon) ? icon : null;

export function evmEntries(
  announced: ReadonlyMap<string, Eip6963Detail>,
  legacy: Eip1193Provider | null,
): WalletEntry[] {
  const list: WalletEntry[] = [...announced.values()]
    .map((d) => ({
      key: `evm:${d.info.rdns}`,
      family: "evm" as const,
      name: d.info.name,
      icon: safeIcon(d.info.icon),
      installed: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0 && legacy) {
    list.push({
      key: "evm:injected",
      family: "evm",
      name: "Browser wallet",
      icon: null,
      installed: true,
    });
  }
  return list;
}

export function legacyProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

/** Starts listening; `onChange` gets the full map each time. Returns the unsubscribe. */
export function watchEvmWallets(onChange: (m: Map<string, Eip6963Detail>) => void): () => void {
  let map = new Map<string, Eip6963Detail>();
  const handler = (e: Event) => {
    map = reduceAnnouncements(map, (e as CustomEvent).detail);
    onChange(map);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  // Wallets that loaded before this listener announce again on request.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", handler);
}

export async function connectEvm(
  entry: WalletEntry,
  provider: Eip1193Provider,
): Promise<Connection> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new Error("The wallet did not return an address.");
  }
  return { family: "evm", walletKey: entry.key, walletName: entry.name, address: first, provider };
}
