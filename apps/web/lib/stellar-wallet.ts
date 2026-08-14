import {
  FreighterModule,
  StellarWalletsKit,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";

/**
 * Freighter only for now (Stellar Wallets Kit supports more, but auth-entry/transaction-signing
 * parity across wallets isn't independently verified here — see docs/architecture.md §2's
 * "verify at build time" note before adding more modules).
 */
export function createStellarWalletKit(network: WalletNetwork = WalletNetwork.TESTNET): StellarWalletsKit {
  return new StellarWalletsKit({
    network,
    selectedWalletId: "freighter",
    modules: [new FreighterModule()],
  });
}
