"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Notice } from "../../components/ui/notice";
import { browserConnection, prepareClaim } from "../../lib/claim";
import type { ArcClaimTarget } from "../../lib/claim-arc";
import { reportError } from "../../lib/format-error";
import { ArcClaim } from "./arc-claim";

/**
 * Completes a transfer from the user's own wallet, when Circle's forwarding did not.
 *
 * # Why this page is the point
 *
 * The product promises funds cannot hang: once Circle attests a burn, the `(message, attestation)`
 * pair is public and anyone can submit `receiveMessage` to mint to the recipient. Before this page
 * that was true and unusable — if delivery failed the receipt told you to keep your hash and wait
 * for a human to run a script, which made our uptime your risk rather than your convenience.
 * There is no relay any more: a forward that fails is claimed here, by the owner.
 *
 * Distinct from `/recover`, which countersigns a transaction the relayer partly signed, for a burn
 * addressed to a wallet instead of a token account. That is a rescue from a specific past bug.
 * This is the path when a forward failed or was never requested.
 *
 * # What it costs the person clicking
 *
 * The transaction fee plus 867,621 lamports of permanent `used_nonce` rent — about 0.0009 SOL —
 * and roughly 0.002 SOL more if the recipient has no USDC account yet. None of it is recoverable
 * by anyone. That is what Circle's delivery fee normally covers, stated rather than hidden, because
 * the person paying it is about to approve it in a wallet prompt that will not explain it.
 */

type PhantomProvider = {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction<T>(tx: T): Promise<T>;
};

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null) ?? null;
}

type Attestation =
  | {
      status: "complete";
      message: string;
      attestation: string;
      usdcMint: string;
      sourceDomainId: number;
      /** Read from the message itself, so it is the destination Circle will enforce. */
      destinationDomain: number;
      /** Present only for an Arc-bound message. */
      arc?: ArcClaimTarget;
    }
  | { status: "pending" }
  | { status: "unknown"; reason?: string };

const TX_HASH = /^[0-9a-f]{64}$/;

export default function ClaimPage() {
  return (
    <Suspense fallback={null}>
      <Claim />
    </Suspense>
  );
}

function Claim() {
  const params = useSearchParams();
  const [txHash, setTxHash] = useState("");
  const [provider, setProvider] = useState<PhantomProvider | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [recipientOwner, setRecipientOwner] = useState("");
  const [needsOwner, setNeedsOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  useEffect(() => setProvider(getPhantom()), []);

  // Arriving from the receipt carries the hash, so the common path is one click rather than a
  // copy-paste of 64 characters.
  useEffect(() => {
    const fromLink = params.get("tx")?.trim().toLowerCase();
    if (fromLink && TX_HASH.test(fromLink)) setTxHash(fromLink);
  }, [params]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const { publicKey } = await provider.connect();
      setWallet(publicKey.toBase58());
    } catch (err) {
      setError(reportError("wallet connect failed", err));
    }
  }, [provider]);

  async function lookUp() {
    const hash = txHash.trim().toLowerCase();
    if (!TX_HASH.test(hash)) {
      setError("That is not a Stellar transaction hash — expected 64 hex characters.");
      return;
    }
    setBusy("Asking Circle for the attestation…");
    setError(null);
    setAttestation(null);
    setNeedsOwner(null);
    try {
      const res = await fetch(`/api/attestation?tx=${hash}`);
      setAttestation((await res.json()) as Attestation);
    } catch (err) {
      setError(reportError("could not reach Circle", err));
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    if (!provider || !wallet || attestation?.status !== "complete") return;
    setBusy("Building the transaction…");
    setError(null);
    try {
      const connection = browserConnection();
      const prepared = await prepareClaim(connection, {
        message: attestation.message,
        attestation: attestation.attestation,
        usdcMint: attestation.usdcMint,
        sourceDomainId: attestation.sourceDomainId,
        payer: wallet,
        ...(recipientOwner.trim() ? { recipientOwner: recipientOwner.trim() } : {}),
      });

      if (prepared.status === "needs-owner") {
        setNeedsOwner(prepared.reason);
        return;
      }

      setNeedsOwner(null);
      setBusy("Confirm in your wallet…");
      const signed = await provider.signTransaction(prepared.transaction);
      setBusy("Submitting…");
      const sig = await connection.sendRawTransaction(
        (signed as { serialize(): Uint8Array }).serialize(),
      );
      await connection.confirmTransaction(sig, "confirmed");
      setSignature(sig);
    } catch (err) {
      setError(reportError("claim failed", err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-16 sm:px-5 sm:py-24">
      <header className="px-1">
        <h1 className="text-2xl font-semibold tracking-tight text-bone [text-wrap:balance]">
          Claim a transfer yourself
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-bone/50">
          Circle&rsquo;s attestation for a burn is public and never expires, so anyone holding it
          can complete the mint — including you, and including transfers that are not yours. Use
          this when Circle&rsquo;s automatic delivery failed.
        </p>
      </header>

      <section>
        <label
          htmlFor="tx"
          className="mb-2 block text-xs font-medium uppercase tracking-wider text-bone/40"
        >
          Stellar burn transaction
        </label>
        <div className="flex gap-2">
          <input
            id="tx"
            spellCheck={false}
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
            placeholder="64 hex characters"
            className="tabular min-w-0 flex-1 rounded-tray bg-obsidian-sunken px-3 py-2.5 font-mono text-xs text-bone/80 ring-1 ring-inset ring-bone/10 transition-colors duration-200 placeholder:font-sans placeholder:text-bone/25 focus:outline-none focus:ring-bone/30"
          />
          <button
            type="button"
            onClick={lookUp}
            disabled={Boolean(busy) || !txHash.trim()}
            className="shrink-0 rounded-tray px-4 py-2.5 text-sm font-medium text-bone ring-1 ring-inset ring-bone/20 transition-colors duration-200 hover:bg-bone/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Look up
          </button>
        </div>
      </section>

      {attestation?.status === "pending" && (
        <Notice tone="info" title="Circle has not signed this yet">
          Attestation usually lands within a couple of minutes of the burn. Nothing is wrong and
          nothing is lost — try again shortly.
        </Notice>
      )}

      {attestation?.status === "unknown" && (
        <Notice tone="alarm" title="No CCTP transfer found">
          {attestation.reason ?? "Circle has no message for that transaction."}
        </Notice>
      )}

      {attestation?.status === "complete" && attestation.arc && (
        <ArcClaim
          message={attestation.message as `0x${string}`}
          attestation={attestation.attestation as `0x${string}`}
          target={attestation.arc}
        />
      )}

      {attestation?.status === "complete" && !attestation.arc && !signature && (
        <>
          <Notice tone="signal" title="Attested and claimable">
            The funds are waiting. Submitting the mint costs you the Solana fee and about 0.0009 SOL
            of account rent, which nobody can reclaim — this is the cost Circle&rsquo;s delivery fee
            normally covers.
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
                  {provider ? "Connect Phantom" : "Phantom not detected"}
                </button>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-bone/35">
              This wallet pays the gas. The USDC goes to whoever the burn named, which may be
              someone else entirely — that is how a stuck transfer can be rescued by a third party.
            </p>
          </section>

          {needsOwner && (
            <section>
              <Notice tone="info" title="Who receives this?" className="mb-2.5">
                {needsOwner}. The address is checked against the burn before anything is signed.
              </Notice>
              <input
                spellCheck={false}
                value={recipientOwner}
                onChange={(e) => setRecipientOwner(e.target.value)}
                placeholder="Destination Solana wallet"
                className="w-full rounded-tray bg-obsidian-sunken px-3 py-2.5 font-mono text-xs text-bone/80 ring-1 ring-inset ring-bone/10 transition-colors duration-200 placeholder:font-sans placeholder:text-bone/25 focus:outline-none focus:ring-bone/30"
              />
            </section>
          )}

          <button
            type="button"
            onClick={claim}
            disabled={!wallet || Boolean(busy)}
            className="w-full rounded-tray bg-bone px-4 py-3 font-semibold text-obsidian transition-all duration-200 ease-haptic hover:bg-bone/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-bone/10 disabled:text-bone/30"
          >
            {busy ?? "Claim it"}
          </button>
        </>
      )}

      {error && (
        <Notice tone="alarm" title="That did not go through">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
            {error}
          </pre>
        </Notice>
      )}

      {signature && (
        <Notice tone="signal" title="Minted">
          <p className="break-all font-mono text-[0.75rem] text-bone/60">{signature}</p>
          <a
            href={`https://solscan.io/tx/${signature}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[0.8125rem] text-signal underline underline-offset-2"
          >
            View on Solscan
          </a>
        </Notice>
      )}
    </main>
  );
}
