import {
  FreighterModule,
  StellarWalletsKit,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import { env } from "./env";

/**
 * Freighter only for now (Stellar Wallets Kit supports more, but auth-entry/transaction-signing
 * parity across wallets isn't independently verified here — see docs/architecture.md §2's
 * "verify at build time" note before adding more modules).
 *
 * # The network is derived, never defaulted
 *
 * This function used to default to `WalletNetwork.TESTNET`. On a mainnet build that meant the
 * wallet was asked to sign against the wrong network while every other part of the app was
 * correctly configured for mainnet — the exact wrong-network class of bug the whole config
 * layer exists to prevent, hiding in a default argument.
 *
 * The passphrase is the authoritative network identifier, so it is the thing mapped here
 * rather than a separate flag that could drift from it.
 */
const NETWORK_BY_PASSPHRASE: Record<string, WalletNetwork> = {
  [WalletNetwork.PUBLIC]: WalletNetwork.PUBLIC,
  [WalletNetwork.TESTNET]: WalletNetwork.TESTNET,
};

export function createStellarWalletKit(): StellarWalletsKit {
  const network = NETWORK_BY_PASSPHRASE[env.stellarNetworkPassphrase];
  if (!network) {
    throw new Error(
      `No wallet network matches the configured passphrase "${env.stellarNetworkPassphrase}". ` +
        "Refusing to guess — signing against the wrong network is unrecoverable.",
    );
  }

  return new StellarWalletsKit({
    network,
    selectedWalletId: "freighter",
    modules: [new FreighterModule()],
  });
}
