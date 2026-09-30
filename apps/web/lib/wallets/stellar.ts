import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import type { Connection, WalletEntry } from "./types";

/**
 * The Stellar wallets this app will sign with.
 *
 * Deliberately a short list. Every transfer and every admin call carries a Soroban authorization
 * tree that the wallet must sign entry by entry, and signing parity across wallets has only been
 * checked for Freighter (see stellar-wallet.ts). Listing a wallet here is a promise that money
 * moves correctly through it, so it is added after a real transfer has gone through it, not
 * because the kit happens to support it.
 */
export const VERIFIED_STELLAR_WALLETS: ReadonlyArray<{
  id: string;
  name: string;
  installUrl: string;
}> = [{ id: "freighter", name: "Freighter", installUrl: "https://www.freighter.app" }];

export async function stellarEntries(kit: StellarWalletsKit): Promise<WalletEntry[]> {
  const supported = await kit.getSupportedWallets();
  return VERIFIED_STELLAR_WALLETS.map((w) => {
    const found = supported.find((s) => s.id === w.id);
    return {
      key: `stellar:${w.id}`,
      family: "stellar" as const,
      name: w.name,
      icon: found?.icon && /^(data:image\/|https:\/\/)/.test(found.icon) ? found.icon : null,
      installed: found?.isAvailable ?? false,
      installUrl: w.installUrl,
    };
  });
}

export async function connectStellar(
  kit: StellarWalletsKit,
  entry: WalletEntry,
): Promise<Connection> {
  kit.setWallet(entry.key.replace("stellar:", ""));
  const { address } = await kit.getAddress();
  return { family: "stellar", walletKey: entry.key, walletName: entry.name, address };
}
