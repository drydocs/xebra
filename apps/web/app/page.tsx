"use client";

import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { XebraMark } from "../components/brand/xebra-mark";
import { RouteTrack } from "../components/bridge/route-track";
import { SiteFooter } from "../components/site/site-footer";
import { TopBar } from "../components/site/top-bar";
import { Eyebrow } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { DataRow } from "../components/ui/data-row";
import { Field, Input } from "../components/ui/field";
import { GlassCard, InsetTray } from "../components/ui/glass-card";
import { ArrowRight, Check, Copy, Fingerprint, Spark, Vault } from "../components/ui/icons";
import { Notice } from "../components/ui/notice";
import { Reveal } from "../components/ui/reveal";
import { Skeleton } from "../components/ui/skeleton";
import { StripeRule } from "../components/ui/stripe-rule";
import {
  type BridgeChainConfig,
  type BridgeQuote,
  approveUsdcForCctp,
  formatUsdc,
  getCircleMinFee,
  getUsdcAllowance,
  getUsdcBalance,
  parseUsdc,
  quoteBridge,
  submitBridge,
  submitDirectBurn,
  waitForTx,
} from "../lib/cctp-bridge";
import { env, isCctpRailConfigured } from "../lib/env";
import { formatError, reportError } from "../lib/format-error";
import {
  type RelayDelivery,
  type RelayHandoff,
  getRelayDelivery,
  handOffToRelay,
} from "../lib/relay";
import {
  type RecipientResolution,
  checkSolanaAddress,
  resolveRecipient,
} from "../lib/solana-address";
import { createStellarWalletKit } from "../lib/stellar-wallet";

/**
 * One job: move USDC from Stellar to Solana over Circle's CCTP.
 *
 * # What is deliberately not asked
 *
 * There is no destination-asset field. CCTP is burn-and-mint of the *same* asset, so the
 * destination is native USDC by definition — asking which token would be asking which dollar.
 * It previously was a free-text SPL mint box, which was worse than redundant: the value
 * silently selected the routing rail, so a typo quietly became a different product, and the
 * placeholder was mainnet USDC even on testnet.
 *
 * The amount and the destination address are the only two things only the user can know.
 *
 * # Fee figures come from the contract
 *
 * The breakdown is read by simulating the wrapper's own `quote()`. Recomputing the fee in
 * TypeScript would drift the moment a `commit_params` lands, and the 10-stroop flooring
 * (7-decimal Stellar USDC vs CCTP's 6-decimal canonical form) is easy to get subtly wrong.
 *
 * # Where the design lives
 *
 * Nothing here styles itself from scratch. The plate, the fields, the rules and the buttons
 * are `components/ui/*`, so the one screen that handles money cannot drift away from the one
 * that reports on it (`app/intent/[hash]`). See `tailwind.config.ts` for the tokens.
 */

/** Fast Transfer. Circle treats anything above 1000 as Standard. */
const FAST_FINALITY_THRESHOLD = 1000;
/** How long a signed request stays valid. The contract caps this at one hour. */
const REQUEST_TTL_SECONDS = 600;
/** Headroom over Circle's quoted minimum, so a fee tick between quote and submit
 *  doesn't downgrade a Fast transfer to Standard. Bounded on-chain by `check_max_fee`. */
const CIRCLE_FEE_BUFFER_BPS = 150n;

/** Offered as one tap each. Not a "max" button: this screen never reads a balance, and a
 *  max that guesses is a max that overdraws the reserve. */
const QUICK_AMOUNTS = ["1", "10", "100"];

export default function HomePage() {
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  // Deliberately small. This is mainnet: the field's default is the amount someone will send
  // if they don't think about it. Direct mode has no minimum (the 10 USDC floor is Xebra's
  // contract, not Circle's), so a first transfer can be a single dollar.
  const [amountInput, setAmountInput] = useState("1");
  const [destination, setDestination] = useState("");
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // `null` while the handoff is still in flight, so the receipt can say "handing off" rather
  // than implying either outcome before one is known.
  const [handoff, setHandoff] = useState<RelayHandoff | null>(null);
  const [delivery, setDelivery] = useState<RelayDelivery | null>(null);
  const [recipient, setRecipient] = useState<RecipientResolution | null>(null);
  /** Null while unknown — an unread balance must not read as "you have nothing". */
  const [balance, setBalance] = useState<bigint | null>(null);
  const [resolving, setResolving] = useState(false);

  // StellarWalletsKit touches `window` at construction time (wallet detection), so it must
  // only ever be created client-side, after mount — never during Next.js's server render pass
  // (even for a "use client" component, React still renders once on the server for SSR/SSG).
  useEffect(() => {
    setKit(createStellarWalletKit());
  }, []);

  // Always present. When the fee wrapper is not deployed, `wrapperContractId` is null and
  // the flow bridges directly through Circle's live contract — no fee, but a real transfer.
  const config: BridgeChainConfig = useMemo(
    () => ({
      wrapperContractId: env.cctpWrapperContractId,
      horizonUrl: env.horizonUrl,
      cctpTokenMessengerId: env.cctpTokenMessengerId,
      usdcSacAddress: env.usdcSacAddress,
      sorobanRpcUrl: env.sorobanRpcUrl,
      networkPassphrase: env.stellarNetworkPassphrase,
      destinationDomain: env.destinationDomain,
    }),
    [],
  );

  const amount = useMemo(() => {
    try {
      return parseUsdc(amountInput);
    } catch {
      return null;
    }
  }, [amountInput]);

  const amountError = useMemo(() => {
    if (amountInput.trim() === "") return null;
    try {
      const parsed = parseUsdc(amountInput);
      return parsed <= 0n ? "Enter an amount greater than zero." : null;
    } catch (err) {
      return formatError(err);
    }
  }, [amountInput]);

  const destinationCheck = useMemo(() => checkSolanaAddress(destination), [destination]);

  // Quote is debounced: every keystroke would otherwise be a Soroban simulation.
  /**
   * Whether the destination has no USDC account yet.
   *
   * With the wrapper deployed this is a *price*, not a blocker: the quote adds the account fee,
   * the burn records that it was paid, and the sponsor creates the account when it mints. One
   * transaction, no second step for the user.
   *
   * Direct mode has no fee and no sponsor, so there is nobody to pay that rent — a missing
   * account still blocks there, because burning would produce a mint nobody can land.
   */
  const recipientNeedsAccount = recipient?.status === "missing";
  const blockedOnMissingAccount = recipientNeedsAccount && !isCctpRailConfigured;

  useEffect(() => {
    if (!address || !amount || amount <= 0n) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      quoteBridge(config, address, amount, recipientNeedsAccount)
        .then((result) => {
          if (cancelled) return;
          setQuote(result);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(reportError("quote failed", err));
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setQuoting(false);
    };
    // `recipientNeedsAccount` is a dependency, not just an argument: it flips once the recipient
    // lookup resolves, and it changes the price. Without it here the user would be shown a quote
    // taken before the answer was known and then charged a different amount — which the contract
    // rejects via `max_wrapper_fee`, so it would surface as an unexplained failure at signing.
  }, [config, address, amount, recipientNeedsAccount]);

  // Poll until the mint lands.
  //
  // Without this the receipt could only ever say "waiting", with nothing to end it — a spinner
  // that never resolves, which is a worse thing to show someone than a wrong error. The relay
  // takes up to a minute on the watcher path, so this asks every five seconds and stops as soon
  // as there is an answer.
  useEffect(() => {
    if (!txHash) {
      setDelivery(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const result = await getRelayDelivery(txHash);
      if (cancelled) return;
      setDelivery(result);
      if (result.status !== "minted") timer = setTimeout(poll, 5_000);
    };
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [txHash]);

  // Read the wallet's USDC once it is connected.
  //
  // Without this the app would prepare a transfer against an empty wallet and let the user reach
  // the signing prompt, where the failure arrives from inside the USDC contract as an opaque
  // error code. Knowing the balance turns that into a disabled button and a plain sentence.
  //
  // `txHash` is a dependency without being read: it is the signal that a transfer completed,
  // which is precisely when the balance on screen has gone stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch after a completed transfer.
  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getUsdcBalance(config, address)
      .then((b) => {
        if (!cancelled) setBalance(b);
      })
      .catch(() => {
        // A failed read must not look like a zero balance — that mistake has its own history in
        // this codebase. Leave it unknown and let the contract be the judge.
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [config, address, txHash]);

  // CCTP's mintRecipient on Solana is the TOKEN ACCOUNT, not the wallet. Resolve it as soon
  // as the typed address is valid, so the burn never carries a wallet address.
  useEffect(() => {
    if (!destinationCheck.ok) {
      setRecipient(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    resolveRecipient(destination.trim())
      .then((r) => {
        if (!cancelled) setRecipient(r);
      })
      .catch(() => {
        if (!cancelled) setRecipient(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destination, destinationCheck.ok]);

  const connect = useCallback(async () => {
    if (!kit) return;
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address: connected } = await kit.getAddress();
        setAddress(connected);
      },
    });
  }, [kit]);

  // Only a *known* shortfall blocks. An unread balance is not a zero balance.
  const shortfall =
    balance !== null && quote !== null && balance < quote.amount ? quote.amount - balance : null;

  const ready =
    Boolean(kit && address && quote && destinationCheck.ok && !blockedOnMissingAccount) &&
    shortfall === null &&
    Boolean(recipient) &&
    !submitting &&
    !quoting &&
    !resolving;

  async function bridge() {
    if (!kit || !address || !quote || !recipient) return;
    setSubmitting(true);
    setSubmitError(null);
    setTxHash(null);
    try {
      // Circle's own minimum for this burn, read live — the min-fee controller can change it,
      // so a hardcoded value would eventually revert with InsufficientMaxFee.
      const circleMin = await getCircleMinFee(config, address, quote.netBurned);
      const maxFee = circleMin + (circleMin * CIRCLE_FEE_BUFFER_BPS) / 10_000n;

      const common = {
        config,
        userAddress: address,
        amount: quote.amount,
        // The TOKEN ACCOUNT, never the wallet address. Circle enforces
        // recipient_token_account.key() == mint_recipient; a wallet address here strands
        // the transfer permanently.
        mintRecipient: recipient.tokenAccountBytes,
        recipientNeedsAccount,
        maxFee,
        minFinalityThreshold: FAST_FINALITY_THRESHOLD,
        ttlSeconds: REQUEST_TTL_SECONDS,
      };

      let hash: string;
      if (isCctpRailConfigured) {
        // The wrapper approves and burns inside one invocation, so this stays one signature.
        setStep("Confirm the transfer in your wallet");
        ({ txHash: hash } = await submitBridge(kit, {
          ...common,
          // Pin the fee the user was actually shown. If params change between quote and
          // signing, the contract rejects rather than charging more than was displayed.
          maxWrapperFee: quote.fee,
        }));
      } else {
        // Direct mode needs two signatures: Circle pulls the principal with `transfer_from`,
        // which consumes an allowance, and a Soroban transaction carries only one contract
        // invocation — so approve and burn cannot be batched from the client.
        const allowance = await getUsdcAllowance(config, address);
        if (allowance < quote.netBurned) {
          setStep("Step 1 of 2 — approve USDC in your wallet");
          const approval = await approveUsdcForCctp(kit, config, address, quote.netBurned);
          setStep("Waiting for the approval to confirm…");
          await waitForTx(config, approval.txHash);
        }
        setStep("Step 2 of 2 — confirm the transfer in your wallet");
        ({ txHash: hash } = await submitDirectBurn(kit, common));
      }
      setTxHash(hash);

      // The burn is on chain and irreversible from here. Telling the relay is what gets the
      // mint paid for; if it fails the transfer is still fine, it just needs claiming from
      // /recover, so this runs after the receipt is already on screen and never throws.
      setHandoff(null);
      setHandoff(await handOffToRelay(hash));
    } catch (err) {
      setSubmitError(reportError("transfer failed", err));
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  }

  return (
    <>
      <TopBar
        address={address}
        walletReady={Boolean(kit)}
        network={env.network}
        onConnect={connect}
      />

      <main className="mx-auto w-full max-w-xl px-4 pt-16 sm:px-5 sm:pt-24">
        <Reveal as="header" className="px-1">
          <Eyebrow>Native USDC · one route</Eyebrow>
          <h1 className="mt-6 text-display font-semibold text-bone [text-wrap:balance]">
            Two chains.
            <br />
            <span className="text-bone/45">One signature.</span>
          </h1>
          <p className="mt-6 max-w-[36ch] text-[0.9375rem] leading-relaxed text-bone/45">
            Circle burns your USDC on Stellar and mints the same dollars on Solana. No wrapped
            asset, no bridge token, and nobody holds your funds in between.
          </p>
        </Reveal>

        {!isCctpRailConfigured && (
          <Reveal delay={80} className="mt-10">
            <DirectModeNotice />
          </Reveal>
        )}

        <Reveal delay={140} className="mt-12">
          <GlassCard id="bridge" labelledBy="bridge-heading" className="scroll-mt-24">
            <h2 id="bridge-heading" className="sr-only">
              Bridge USDC from Stellar to Solana
            </h2>

            <div className="px-5 py-5 sm:px-6">
              <RouteTrack
                from="stellar"
                to="solana"
                active={submitting}
                fromDetail={
                  address ? (
                    <span className="tabular font-mono">
                      {address.slice(0, 4)}…{address.slice(-4)}
                    </span>
                  ) : (
                    "No wallet connected"
                  )
                }
                toDetail={destinationCheck.ok ? "Address checks out" : "Native USDC"}
              />
            </div>

            <StripeRule />

            <div className="px-5 py-6 sm:px-6">
              <Field
                id="amount"
                label="You send"
                error={amountError}
                trailing={
                  <div className="flex items-center gap-1">
                    {QUICK_AMOUNTS.map((preset) => (
                      <QuickAmount
                        key={preset}
                        value={preset}
                        active={amountInput.trim() === preset}
                        onSelect={setAmountInput}
                      />
                    ))}
                  </div>
                }
              >
                <div className="relative">
                  <Input
                    id="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    invalid={Boolean(amountError)}
                    aria-invalid={amountError ? "true" : undefined}
                    aria-describedby={amountError ? "amount-error" : undefined}
                    className="tabular h-16 pr-24 text-[1.75rem] font-medium tracking-[-0.02em]"
                  />
                  <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-[0.8125rem] font-medium tracking-[0.02em] text-bone/35">
                    USDC
                  </span>
                </div>
              </Field>

              <Field
                id="destination"
                label="Solana address"
                className="mt-6"
                error={destinationCheck.error}
                hint="Check this carefully. A CCTP transfer cannot be reversed or refunded once signed."
              >
                <Input
                  id="destination"
                  spellCheck={false}
                  autoComplete="off"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="Recipient wallet"
                  invalid={Boolean(destinationCheck.error)}
                  aria-invalid={destinationCheck.error ? "true" : undefined}
                  aria-describedby={
                    destinationCheck.error ? "destination-error" : "destination-hint"
                  }
                  className="h-14 font-mono text-sm placeholder:font-sans"
                />
              </Field>

              <RecipientPanel
                resolving={resolving}
                recipient={recipient}
                accountFee={quote?.accountFee ?? null}
                sponsored={isCctpRailConfigured}
                addressValid={destinationCheck.ok}
              />

              <QuotePanel
                quote={quote}
                loading={quoting}
                error={quoteError}
                hasAddress={Boolean(address)}
              />

              {shortfall !== null && (
                <Notice tone="alarm" title="Not enough USDC" className="mt-5">
                  This wallet holds <span className="tabular">{formatUsdc(balance ?? 0n)}</span>{" "}
                  USDC, and this transfer needs{" "}
                  <span className="tabular">{formatUsdc(quote?.amount ?? 0n)}</span> including the
                  fee — <span className="tabular">{formatUsdc(shortfall)}</span> short.
                </Notice>
              )}

              {submitError && (
                <Notice tone="alarm" title="The transfer did not go through" className="mt-5">
                  {/* A Soroban failure's useful part is its diagnostic event log, which is
                      long and multi-line. Rendered as flowing text it collapses into an
                      unreadable run-on, so it gets a scrollable monospace block instead. */}
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75rem] leading-relaxed text-bone/60">
                    {submitError}
                  </pre>
                  <p className="mt-2 text-bone/35">
                    No funds have moved unless a transaction hash is shown. Full detail is in the
                    browser console under <code className="font-mono">[xebra]</code>.
                  </p>
                </Notice>
              )}

              {txHash ? (
                <SubmittedNotice txHash={txHash} handoff={handoff} delivery={delivery} />
              ) : (
                <Button
                  size="lg"
                  className="mt-6 w-full"
                  disabled={Boolean(address) && !ready}
                  onClick={address ? bridge : connect}
                  trailing={<ArrowRight className="h-4 w-4" />}
                >
                  {!address
                    ? "Connect a Stellar wallet"
                    : submitting
                      ? (step ?? "Working…")
                      : "Bridge USDC"}
                </Button>
              )}
            </div>
          </GlassCard>
        </Reveal>

        <Reveal delay={220}>
          <Assurances />
        </Reveal>
      </main>

      <SiteFooter wrapperContractId={env.cctpWrapperContractId} />
    </>
  );
}

/** A preset amount. Sits on the label line, so it never competes with the primary action. */
function QuickAmount({
  value,
  active,
  onSelect,
}: {
  value: string;
  active: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "tabular rounded-full px-2.5 py-1 text-[0.6875rem] font-medium",
        "transition-colors duration-400 ease-haptic",
        active
          ? "bg-bone/[0.12] text-bone"
          : "text-bone/35 hover:bg-bone/[0.06] hover:text-bone/70",
      )}
    >
      {value}
    </button>
  );
}

function QuotePanel({
  quote,
  loading,
  error,
  hasAddress,
}: {
  quote: BridgeQuote | null;
  loading: boolean;
  error: string | null;
  hasAddress: boolean;
}) {
  if (!hasAddress) {
    return (
      <div className="mt-6 flex items-center justify-center gap-2.5 rounded-tray border border-dashed border-bone/[0.09] px-4 py-6 text-center">
        <XebraMark className="h-4 w-4 text-bone/25" />
        <p className="text-[0.8125rem] text-bone/35">Connect a wallet to see the fee breakdown.</p>
      </div>
    );
  }

  if (error) {
    return (
      <Notice tone="alarm" title="Could not price this transfer" className="mt-6">
        {error}
      </Notice>
    );
  }

  if (loading || !quote) {
    // Skeleton matching the real panel's shape, rather than a spinner that tells you nothing
    // about what is coming — and, more practically, so the plate does not resize under the
    // cursor the moment a quote lands.
    return (
      <InsetTray className="mt-6 space-y-3.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className={cn("h-3", i === 2 ? "w-28" : "w-20")} />
            <Skeleton className={cn("h-3", i === 2 ? "w-24" : "w-16")} />
          </div>
        ))}
      </InsetTray>
    );
  }

  return (
    <InsetTray className="mt-6">
      <dl className="tabular space-y-3">
        <DataRow label="Amount" value={`${formatUsdc(quote.amount)} USDC`} />
        <DataRow label="Xebra fee" value={`−${formatUsdc(quote.fee)} USDC`} />
        {quote.remainder > 0n && (
          <DataRow
            label="Not sent"
            value={`${formatUsdc(quote.remainder)} USDC`}
            hint="Below Solana's smallest USDC unit, so it stays in your wallet."
          />
        )}
        <div className="pt-3">
          <StripeRule className="mb-3 opacity-50" />
          <DataRow
            label="Recipient gets"
            value={`${formatUsdc(quote.netBurned)} USDC`}
            emphasis
            hint="Before Circle's network fee, charged on delivery."
          />
        </div>
      </dl>
    </InsetTray>
  );
}

function SubmittedNotice({
  txHash,
  handoff,
  delivery,
}: {
  txHash: string;
  handoff: RelayHandoff | null;
  delivery: RelayDelivery | null;
}) {
  return (
    <div className="mt-6">
      <Notice tone="signal" title="Burn submitted">
        Circle attests the transfer, then it is minted on Solana. This usually takes under a minute.
        Your funds are claimable by anyone with the attestation, including you, if our relay is
        unavailable.
      </Notice>
      <InsetTray className="mt-2.5 py-3">
        <div className="flex items-center gap-3">
          <span className="tabular min-w-0 flex-1 truncate font-mono text-xs text-bone/45">
            {txHash}
          </span>
          <CopyButton value={txHash} label="transaction hash" />
        </div>
        <HandoffStatus handoff={handoff} delivery={delivery} txHash={txHash} />
      </InsetTray>
    </div>
  );
}

/**
 * Whether anyone is paying for the mint yet.
 *
 * Worth its own line because the two outcomes ask different things of the reader. Queued means
 * do nothing. Unavailable means the dollars are waiting and one more signature collects them —
 * which the receipt above already promises, so the link has to actually be here rather than
 * left as an idea.
 *
 * The reason string is shown rather than smoothed into "something went wrong": whoever reads it
 * is about to either wait or click through to /recover, and "no relay is configured" and "relay
 * returned 503" call for different amounts of patience.
 */
function HandoffStatus({
  handoff,
  delivery,
  txHash,
}: {
  handoff: RelayHandoff | null;
  delivery: RelayDelivery | null;
  txHash: string;
}) {
  const line = "mt-2.5 flex items-center gap-2 border-t border-bone/[0.06] pt-2.5 text-[0.75rem]";

  // Delivery outranks the handoff, because it is the question the user actually has. The handoff
  // only describes whether one request succeeded; this describes whether the money arrived.
  if (delivery?.status === "minted") {
    return (
      <div className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-signal" />
        <span>
          Minted on Solana.{" "}
          {delivery.signature ? (
            <a
              href={`https://solscan.io/tx/${delivery.signature}`}
              target="_blank"
              rel="noreferrer"
              className="text-bone/70 underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50"
            >
              View it
            </a>
          ) : null}
        </span>
      </div>
    );
  }

  // Everything that is not a settled failure is one pending state, deliberately.
  //
  // The handoff has several internal outcomes — request in flight, accepted, or refused because
  // the burn is too fresh for Horizon to have indexed — and none of them are distinctions a user
  // has any use for. An earlier version surfaced the last one as "No relay picked this up", which
  // was true for about sixty seconds and sent someone to pay their own gas for a mint already on
  // its way. From here there is one honest answer until the mint lands: it is coming.
  const settledFailure = handoff?.status === "unavailable" && delivery?.status !== "pending";

  if (!settledFailure) {
    return (
      <p className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-signal animate-breathe" />
        Waiting for the relay to mint — usually under a minute.
      </p>
    );
  }

  return (
    <div className="mt-2.5 border-t border-bone/[0.06] pt-2.5 text-[0.75rem] leading-relaxed text-bone/45">
      <p className="flex items-center gap-2">
        <span className="h-1 w-1 shrink-0 rounded-full bg-alarm" />
        No relay picked this up — {handoff.reason}.
      </p>
      <p className="mt-1.5 pl-3">
        Your USDC is burned and still claimable: Circle&rsquo;s attestation is public and never
        expires, so anyone holding it can complete the mint.{" "}
        <a
          href={`/claim?tx=${encodeURIComponent(txHash)}`}
          className="text-bone/70 underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50"
        >
          Claim it yourself
        </a>{" "}
        — you pay the Solana gas, roughly 0.001 SOL, which is what we would have paid.
      </p>
    </div>
  );
}

/**
 * Copies and says so. A hash long enough to need truncating is a hash nobody transcribes by
 * hand, and the confirmation has to be visible rather than implied — the clipboard gives no
 * feedback of its own.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          // A clipboard write can be refused (insecure origin, denied permission). Silently
          // doing nothing is fine here: the hash is on screen and selectable.
          () => undefined,
        );
      }}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full",
        "transition-colors duration-400 ease-haptic",
        copied ? "text-signal" : "text-bone/40 hover:bg-bone/[0.08] hover:text-bone",
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="sr-only">{copied ? `Copied the ${label}` : `Copy the ${label}`}</span>
    </button>
  );
}

/**
 * Three claims, on one hairline-separated row rather than three cards. They are supporting
 * detail; giving each its own elevated surface would put them in competition with the plate
 * that actually does the work.
 */
function Assurances() {
  const items = [
    { icon: Vault, title: "Non-custodial", body: "Funds move contract to contract." },
    { icon: Fingerprint, title: "Circle-attested", body: "Each burn carries its own proof." },
    { icon: Spark, title: "Under a minute", body: "Fast Transfer on every burn." },
  ];

  return (
    <ul className="mt-12 grid gap-px overflow-hidden rounded-tray bg-bone/[0.06] sm:grid-cols-3">
      {items.map(({ icon: Icon, title, body }) => (
        <li key={title} className="bg-obsidian/90 px-4 py-5">
          <Icon className="h-[1.125rem] w-[1.125rem] text-bone/40" />
          <h3 className="mt-3 text-[0.8125rem] font-medium tracking-[-0.01em] text-bone/80">
            {title}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-bone/35">{body}</p>
        </li>
      ))}
    </ul>
  );
}

function DirectModeNotice() {
  return (
    <Notice tone="info" title="Direct mode — no Xebra fee">
      Transfers go straight through Circle&apos;s CCTP contract, so this is a real bridge and costs
      you nothing beyond Circle&apos;s own network fee. It takes{" "}
      <strong className="font-medium text-bone/75">two wallet signatures</strong>: Circle pulls your
      USDC with <code className="font-mono text-[0.75rem] text-bone/65">transfer_from</code>, which
      needs an approval first, and a Soroban transaction carries only one contract call. Deploying
      Xebra&apos;s contract collapses it to one signature and adds the fee.
    </Notice>
  );
}

/**
 * Shows what the USDC will actually be delivered to.
 *
 * Users type a wallet address, but CCTP's `mintRecipient` on Solana must be the USDC **token
 * account** — Circle enforces `recipient_token_account.key() == mint_recipient`. Passing a
 * wallet address strands the transfer permanently, which is exactly what happened on the
 * first real mainnet burn through this app.
 *
 * Since the address the user types is not the address that receives, the derived one is shown
 * rather than hidden. And because CCTP does not create the token account, its absence blocks
 * the transfer instead of being discovered after the funds are burned.
 */
function RecipientPanel({
  resolving,
  recipient,
  accountFee,
  sponsored,
  addressValid,
}: {
  resolving: boolean;
  recipient: RecipientResolution | null;
  /** The surcharge the quote added for creating the account, or null before a quote exists. */
  accountFee: bigint | null;
  /** Whether anyone is paying that rent. Without the wrapper, nobody is. */
  sponsored: boolean;
  addressValid: boolean;
}) {
  if (!addressValid) return null;

  if (resolving || !recipient) {
    return <p className="mt-3 text-[0.8125rem] text-bone/40">Checking the recipient account…</p>;
  }

  // A missing account is a surcharge, not a wall — we create it during delivery and the quote
  // already includes what that costs. It only blocks in direct mode, where there is no fee and so
  // nobody to pay the rent.
  if (recipient.status === "missing") {
    if (!sponsored) {
      return (
        <Notice tone="alarm" title="This wallet has no USDC account on Solana yet" className="mt-3">
          USDC can only be delivered to a token account, and this wallet does not have one.
          Receiving any USDC on Solana once will create it. Burning now would leave the transfer
          unmintable until somebody creates the account.
          <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
            {recipient.tokenAccount}
          </p>
        </Notice>
      );
    }
    return (
      <Notice tone="info" title="We will open this wallet's USDC account" className="mt-3">
        First transfer to this wallet, so its USDC account does not exist yet. We create it as part
        of delivery
        {accountFee !== null && accountFee > 0n ? (
          <>
            {" "}
            for <span className="tabular">{formatUsdc(accountFee)}</span> USDC, already included in
            the fee above
          </>
        ) : null}
        . Nothing extra for you to do, and it is a one-off — later transfers to this wallet skip it.
        <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
          {recipient.tokenAccount}
        </p>
      </Notice>
    );
  }

  // A failed lookup must not read as "no account" — that mistake blocked a wallet that
  // plainly held USDC. Say what is actually known and let the user decide.
  if (recipient.status === "unknown") {
    return (
      <Notice tone="info" title="Could not verify the recipient account" className="mt-3">
        The Solana lookup failed{recipient.reason ? `: ${recipient.reason}` : ""}. The account below
        is where the USDC will be delivered — confirm it holds USDC already before continuing,
        because CCTP will not create it.
        <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
          {recipient.tokenAccount}
        </p>
      </Notice>
    );
  }

  return (
    <div className="mt-3 rounded-tray bg-bone/[0.03] px-4 py-3">
      <p className="text-[0.8125rem] text-bone/50">Delivered to this wallet&apos;s USDC account:</p>
      <p className="mt-1 break-all font-mono text-[0.75rem] text-bone/60">
        {recipient.tokenAccount}
      </p>
    </div>
  );
}
