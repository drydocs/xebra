"use client";

import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import type { Wallet } from "@wallet-standard/base";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatError } from "../../lib/format-error";
import { createStellarWalletKit } from "../../lib/stellar-wallet";
import {
  type Eip6963Detail,
  connectEvm,
  evmEntries,
  legacyProvider,
  watchEvmWallets,
} from "../../lib/wallets/evm";
import { connectSolana, solanaEntries, watchSolanaWallets } from "../../lib/wallets/solana";
import { connectStellar, stellarEntries } from "../../lib/wallets/stellar";
import type { Connection, Eip1193Provider, Family, WalletEntry } from "../../lib/wallets/types";
import { WalletModal } from "./wallet-modal";

/**
 * One place that knows which wallets exist and which are connected, across Stellar, Solana and EVM.
 *
 * A person can hold all three at once (a Stellar wallet to pay, a Solana or EVM wallet to name the
 * recipient), so connections are per family and independent; connecting one never disturbs another.
 * Nothing reconnects on load: a wallet prompt the user did not ask for is worse than one extra tap.
 */
interface WalletContextValue {
  connections: Partial<Record<Family, Connection>>;
  /** Stellar signing goes through the kit; null until the client has mounted. */
  stellarKit: StellarWalletsKit | null;
  /** Opens the modal on the given families (all three when omitted). */
  open: (families?: readonly Family[]) => void;
  disconnect: (family: Family) => Promise<void>;
}

const Ctx = createContext<WalletContextValue | null>(null);

export function useWallets(): WalletContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallets must be used inside <WalletProvider>.");
  return v;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  const [stellar, setStellar] = useState<WalletEntry[]>([]);
  const [evmMap, setEvmMap] = useState<Map<string, Eip6963Detail>>(new Map());
  const [solWallets, setSolWallets] = useState<Wallet[]>([]);
  const [connections, setConnections] = useState<Partial<Record<Family, Connection>>>({});
  const [families, setFamilies] = useState<readonly Family[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const evmCleanup = useRef<(() => void) | null>(null);

  // The kit touches `window` on construction, so it only exists after mount.
  useEffect(() => {
    setKit(createStellarWalletKit());
  }, []);

  // Freighter's "is it there" check is a round trip to the extension. Asked once at page load it often
  // answers "no" (the content script is not ready, or the wallet was unlocked afterwards), and a stale
  // "not installed" is the worst answer to keep. So it is asked again shortly after load, whenever the
  // tab regains focus, and whenever the modal opens.
  const refreshStellar = useCallback(async () => {
    if (!kit) return;
    try {
      setStellar(await stellarEntries(kit));
    } catch {
      /* keep the last answer */
    }
  }, [kit]);

  useEffect(() => {
    if (!kit) return;
    void refreshStellar();
    const timers = [600, 1800, 4000].map((ms) => setTimeout(() => void refreshStellar(), ms));
    const onFocus = () => void refreshStellar();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      for (const t of timers) clearTimeout(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [kit, refreshStellar]);
  useEffect(() => watchEvmWallets(setEvmMap), []);
  useEffect(() => watchSolanaWallets(setSolWallets), []);

  const entries = useMemo<Record<Family, WalletEntry[]>>(
    () => ({
      stellar,
      solana: solanaEntries(solWallets),
      evm: evmEntries(evmMap, legacyProvider()),
    }),
    [stellar, solWallets, evmMap],
  );

  const setConn = useCallback((c: Connection | null, family: Family) => {
    setConnections((prev) => {
      const next = { ...prev };
      if (c) next[family] = c;
      else delete next[family];
      return next;
    });
  }, []);

  const connect = useCallback(
    async (entry: WalletEntry) => {
      setError(null);
      setPending(entry.key);
      try {
        let conn: Connection;
        if (entry.family === "stellar") {
          if (!kit) throw new Error("The Stellar wallet is still loading.");
          conn = await connectStellar(kit, entry);
        } else if (entry.family === "solana") {
          const w = solWallets.find((x) => `solana:${x.name}` === entry.key);
          if (!w) throw new Error("That wallet is no longer available.");
          conn = await connectSolana(entry, w);
        } else {
          const provider: Eip1193Provider | null =
            entry.key === "evm:injected"
              ? legacyProvider()
              : (evmMap.get(entry.key.replace("evm:", ""))?.provider ?? null);
          if (!provider) throw new Error("That wallet is no longer available.");
          conn = await connectEvm(entry, provider);
          // A wallet's account changes under us when the user switches inside the extension.
          evmCleanup.current?.();
          const onAccounts = (...args: unknown[]) => {
            const first = (args[0] as string[] | undefined)?.[0];
            setConn(first ? { ...conn, address: first } : null, "evm");
          };
          provider.on?.("accountsChanged", onAccounts);
          evmCleanup.current = () => provider.removeListener?.("accountsChanged", onAccounts);
        }
        setConn(conn, entry.family);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setPending(null);
      }
    },
    [kit, solWallets, evmMap, setConn],
  );

  const disconnect = useCallback(
    async (family: Family) => {
      if (family === "evm") {
        evmCleanup.current?.();
        evmCleanup.current = null;
      }
      if (family === "solana") {
        const key = connections.solana?.walletKey;
        const w = solWallets.find((x) => `solana:${x.name}` === key);
        const off = w?.features["standard:disconnect"] as
          | { disconnect(): Promise<void> }
          | undefined;
        await off?.disconnect().catch(() => undefined);
      }
      setConn(null, family);
    },
    [connections.solana?.walletKey, solWallets, setConn],
  );

  const open = useCallback(
    (f?: readonly Family[]) => {
      setError(null);
      setFamilies(f ?? ["stellar", "solana", "evm"]);
      void refreshStellar();
    },
    [refreshStellar],
  );

  const value = useMemo<WalletContextValue>(
    () => ({ connections, stellarKit: kit, open, disconnect }),
    [connections, kit, open, disconnect],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <WalletModal
        families={families}
        entries={entries}
        connections={connections}
        pending={pending}
        error={error}
        onConnect={connect}
        onDisconnect={disconnect}
        onClose={() => setFamilies(null)}
      />
    </Ctx.Provider>
  );
}
