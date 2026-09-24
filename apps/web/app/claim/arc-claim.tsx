"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice } from "../../components/ui/notice";
import {
  type ArcClaimTarget,
  type Eip1193Provider,
  connectEvmWallet,
  ensureArcNetwork,
  getInjectedProvider,
  isAlreadyMinted,
  sendClaim,
  waitForClaim,
} from "../../lib/claim-arc";
import { reportError } from "../../lib/format-error";

/**
 * The Arc half of `/claim`: complete an attested transfer from your own EVM wallet.
 *
 * Deliberately parallel to the Solana flow on the same page rather than folded into it. The two
 * share a promise — the attestation is public, anyone may submit the mint — but nothing else: no
 * token account to create, no owner to be told, no rent. Arc's whole claim is connect, switch
 * network, sign once, and its cost is gas in USDC, well under a cent.
 */
export function ArcClaim({
  message,
  attestation,
  target,
}: {
  message: `0x${string}`;
  attestation: `0x${string}`;
  target: ArcClaimTarget;
}) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [alreadyMinted, setAlreadyMinted] = useState(false);

  useEffect(() => setProvider(getInjectedProvider()), []);

  const connect = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      setWallet(await connectEvmWallet(provider));
    } catch (err) {
      setError(reportError("wallet connect failed", err));
    }
  }, [provider]);

  async function claim() {
    if (!provider || !wallet) return;
    setError(null);
    try {
      setBusy("Checking the transfer…");
      // The likeliest reason to be here with a valid attestation is that Circle's forwarding
      // service already delivered it. Say so, instead of letting the wallet warn that a transaction "will fail".
      if (await isAlreadyMinted(provider, target, message)) {
        setAlreadyMinted(true);
        return;
      }

      setBusy("Switching to Arc…");
      await ensureArcNetwork(provider, target);

      setBusy("Confirm in your wallet…");
      const sent = await sendClaim(provider, target, wallet, message, attestation);

      setBusy("Waiting for Arc…");
      const outcome = await waitForClaim(provider, sent);
      if (outcome !== "success") throw new Error(`the transaction ${sent} reverted on chain`);
      setHash(sent);
    } catch (err) {
      setError(reportError("claim failed", err));
    } finally {
      setBusy(null);
    }
  }

  if (alreadyMinted) {
    return (
      <Notice tone="signal" title="Already minted">
        Circle has already delivered this transfer — most likely its forwarding service got there
        first. Nothing is owed and there is nothing to claim.
      </Notice>
    );
  }

  if (hash) {
    return (
      <Notice tone="signal" title="Minted">
        <p className="break-all font-mono text-[0.75rem] text-bone/60">{hash}</p>
        <a
          href={`${target.explorerUrl}/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[0.8125rem] text-signal underline underline-offset-2"
        >
          View on Arc Explorer
        </a>
      </Notice>
    );
  }

  return (
    <>
      <Notice tone="signal" title="Attested and claimable on Arc">
        The funds are waiting. Submitting the mint costs you Arc gas, which is paid in USDC and is
        well under a cent — this is the cost Circle&rsquo;s delivery fee normally covers.
      </Notice>

      <section className="rounded-tray bg-bone/[0.03] px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium uppercase tracking-wider text-bone/40">
            Paying wallet
          </span>
          {wallet ? (
            <span className="break-all font-mono text-xs text-signal">{wallet}</span>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={!provider}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:opacity-40"
            >
              {provider ? "Connect wallet" : "No EVM wallet detected"}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-bone/35">
          This wallet pays the gas and needs a little USDC on Arc for it. The USDC goes to whoever
          the burn named, which may be someone else entirely — that is how a stuck transfer can be
          rescued by a third party.
        </p>
      </section>

      <button
        type="button"
        onClick={claim}
        disabled={!wallet || Boolean(busy)}
        className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
      >
        {busy ?? "Claim it"}
      </button>

      {error && (
        <Notice tone="alarm" title="That did not go through">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
            {error}
          </pre>
        </Notice>
      )}
    </>
  );
}
