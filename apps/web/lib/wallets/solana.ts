import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { Connection, WalletEntry } from "./types";

/**
 * Solana wallet discovery through the Wallet Standard, which Phantom, Solflare, Backpack and the
 * rest all implement. Wallets register themselves; nothing here knows their names in advance, so a
 * new wallet appears in the list without a release.
 *
 * Only the read side is used today: connect and take the account's address, to fill a recipient
 * field and to identify who is on the page. Signing arrives with the source-chain flows.
 */

const CONNECT = "standard:connect";

/** A wallet is usable if it speaks Solana and can connect. Pure, so it is testable with a fake. */
export function isSolanaWallet(w: Pick<Wallet, "chains" | "features">): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    Object.prototype.hasOwnProperty.call(w.features, CONNECT)
  );
}

export function solanaEntries(wallets: readonly Wallet[]): WalletEntry[] {
  return wallets
    .filter(isSolanaWallet)
    .map((w) => ({
      key: `solana:${w.name}`,
      family: "solana" as const,
      name: w.name,
      icon: /^(data:image\/|https:\/\/)/.test(w.icon) ? w.icon : null,
      installed: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The first account that is on a Solana chain. Pure. */
export function pickSolanaAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  return accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? null;
}

export function watchSolanaWallets(onChange: (w: Wallet[]) => void): () => void {
  const registry = getWallets();
  const emit = () => onChange([...registry.get()]);
  emit();
  const offA = registry.on("register", emit);
  const offB = registry.on("unregister", emit);
  return () => {
    offA();
    offB();
  };
}

type ConnectFeature = {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
};

export async function connectSolana(entry: WalletEntry, wallet: Wallet): Promise<Connection> {
  const feature = wallet.features[CONNECT] as ConnectFeature | undefined;
  if (!feature) throw new Error(`${wallet.name} cannot connect.`);
  const { accounts } = await feature.connect();
  const account = pickSolanaAccount(accounts.length ? accounts : wallet.accounts);
  if (!account) throw new Error(`${wallet.name} did not share a Solana account.`);
  return {
    family: "solana",
    walletKey: entry.key,
    walletName: entry.name,
    address: account.address,
  };
}
