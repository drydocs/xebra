"use client";

import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { ChainId, splTokenAssetRef } from "@xebra/intent-schema";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { buildOpenIntentParams } from "../lib/build-open-intent-params";
import { getIntentHash, openStellarIntent } from "../lib/open-intent";
import { createStellarWalletKit } from "../lib/stellar-wallet";
import { trpc } from "../lib/trpc";

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "http://localhost:8000/soroban/rpc";
const STELLAR_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const ESCROW_CONTRACT_ID = process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID ?? "";
const USDC_SAC_ADDRESS = process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS ?? "";

/**
 * One page: connect Stellar wallet, enter destination asset + Stellar->Solana amount, see a
 * quote (which rail — cctp-direct or intent-swap — apps/api's router resolves this, same call
 * the backend re-validates on submission), sign, watch status. See docs/architecture.md §9.
 */
export default function HomePage() {
  const router = useRouter();
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);
  const [sourceAmount, setSourceAmount] = useState("100");
  const [destMint, setDestMint] = useState("");
  const [destAddress, setDestAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // StellarWalletsKit touches `window` at construction time (wallet detection), so it must
  // only ever be created client-side, after mount — never during Next.js's server render pass
  // (even for a "use client" component, React still renders once on the server for SSR/SSG).
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  useEffect(() => {
    setKit(createStellarWalletKit());
  }, []);

  const destAsset = useMemo(() => {
    try {
      return destMint ? splTokenAssetRef(destMint) : null;
    } catch {
      return null;
    }
  }, [destMint]);

  const quote = trpc.quote.useQuery(
    destAsset
      ? { sourceChain: ChainId.Stellar, destChain: ChainId.Solana, destAsset }
      : {
          sourceChain: ChainId.Stellar,
          destChain: ChainId.Solana,
          destAsset: splTokenAssetRef("11111111111111111111111111111111"),
        },
    { enabled: destAsset !== null, retry: false },
  );

  async function connectWallet() {
    if (!kit) return;
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address } = await kit.getAddress();
        setStellarAddress(address);
      },
    });
  }

  async function submit() {
    if (!stellarAddress || !destAsset || !kit) return;
    setSubmitting(true);
    setError(null);
    try {
      const params = buildOpenIntentParams({
        escrowContractId: ESCROW_CONTRACT_ID,
        sorobanRpcUrl: SOROBAN_RPC_URL,
        networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
        sourceTokenAddress: USDC_SAC_ADDRESS,
        userAddress: stellarAddress,
        sourceAmountHuman: sourceAmount,
        destAsset,
        destAddressBase58: destAddress,
        nowUnixSeconds: Math.floor(Date.now() / 1000),
        nonce: BigInt(Date.now()),
      });

      const intentHash = await getIntentHash(params);
      await openStellarIntent(kit, params);
      router.push(`/intent/${intentHash}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Xebra</h1>
        <p className="text-sm text-slate-400">Stellar → Solana, one signature.</p>
      </header>

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-slate-400">Stellar wallet</span>
          {stellarAddress ? (
            <span className="font-mono text-xs text-emerald-400">
              {stellarAddress.slice(0, 6)}…{stellarAddress.slice(-6)}
            </span>
          ) : (
            <button
              type="button"
              disabled={!kit}
              onClick={connectWallet}
              className="rounded bg-slate-100 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40"
            >
              Connect
            </button>
          )}
        </div>

        <label className="mb-1 block text-sm text-slate-400" htmlFor="amount">
          Amount (USDC)
        </label>
        <input
          id="amount"
          value={sourceAmount}
          onChange={(e) => setSourceAmount(e.target.value)}
          className="mb-4 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
        />

        <label className="mb-1 block text-sm text-slate-400" htmlFor="mint">
          Destination asset (Solana SPL mint)
        </label>
        <input
          id="mint"
          value={destMint}
          onChange={(e) => setDestMint(e.target.value)}
          placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          className="mb-4 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm"
        />

        <label className="mb-1 block text-sm text-slate-400" htmlFor="dest">
          Destination address (Solana)
        </label>
        <input
          id="dest"
          value={destAddress}
          onChange={(e) => setDestAddress(e.target.value)}
          className="mb-4 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm"
        />

        {destAsset && quote.data && (
          <p className="mb-4 text-sm text-slate-400">
            Rail: <span className="font-medium text-slate-200">{quote.data.rail}</span>
          </p>
        )}
        {quote.error && <p className="mb-4 text-sm text-red-400">{quote.error.message}</p>}
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="button"
          disabled={!kit || !stellarAddress || !destAsset || !destAddress || submitting}
          onClick={submit}
          className="w-full rounded bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:opacity-40"
        >
          {submitting ? "Signing…" : "Sign & Send"}
        </button>
      </section>
    </main>
  );
}
