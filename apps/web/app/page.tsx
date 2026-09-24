"use client";

import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import type { CircleHealth } from "@xebra/cctp-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { XebraMark } from "../components/brand/xebra-mark";
import { DestinationPicker } from "../components/bridge/destination-picker";
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
  formatUsdc,
  getDomainForwardConfig,
  getUsdcBalance,
  getWrapperFeeParams,
  parseUsdc,
  quoteBridge,
  submitBridge,
} from "../lib/cctp-bridge";
import { type DeliveryView, getCircleHealth, getDelivery } from "../lib/circle-status";
import {
  DESTINATIONS,
  type Destination,
  type DestinationId,
  availableDestinations,
} from "../lib/destinations";
import { env, isCctpRailConfigured } from "../lib/env";
import { formatError, reportError } from "../lib/format-error";
import {
  type DomainForwardConfig,
  type FeeParams,
  chooseMaxFee,
  minimumForwardedAmount,
  suggestedMinimum,
} from "../lib/forward-fee";
import { type RecipientResolution, resolveRecipient } from "../lib/solana-address";
import { createStellarWalletKit } from "../lib/stellar-wallet";

/**
 * One job: move USDC from Stellar to Solana or Arc over Circle's CCTP.
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

/** Standard finality, the only kind Stellar has: Fast Transfer is not available from Stellar. */
const STANDARD_FINALITY_THRESHOLD = 2000;
/** How long a signed request stays valid. The contract caps this at one hour. */
const REQUEST_TTL_SECONDS = 600;

/** Offered as one tap each. Not a "max" button: this screen never reads a balance, and a
 *  max that guesses is a max that overdraws the reserve. */
const QUICK_AMOUNTS = ["5", "10", "100"];

export default function HomePage() {
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  // Deliberately small. This is mainnet: the field's default is the amount someone will send
  // if they don't think about it. Direct mode has no minimum (the 10 USDC floor is Xebra's
  // contract, not Circle's), so a first transfer can be a single dollar.
  const [amountInput, setAmountInput] = useState("5");
  const [destination, setDestination] = useState("");
  const [destId, setDestId] = useState<DestinationId>("solana");
  // What the receipt describes. Fixed at the moment of signing, so switching the picker
  // afterwards cannot rewrite where an already-burned transfer says it is going.
  const [sentTo, setSentTo] = useState<DestinationId>("solana");
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Circle's own account of the transfer. `null` until the first answer.
  const [delivery, setDelivery] = useState<DeliveryView | null>(null);
  // Whether Circle looks able to carry a transfer right now. `null` means not checked or the check
  // could not run — which must never block anyone.
  const [healthState, setHealthState] = useState<{
    key: string;
    value: CircleHealth | null;
  } | null>(null);
  // This destination's forwarding switches and caps, read from the contract.
  const [domainCfg, setDomainCfg] = useState<DomainForwardConfig | null>(null);
  // The wrapper's fee and floor, which set how small a transfer to this destination can be.
  const [feeParams, setFeeParams] = useState<FeeParams | null>(null);
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

  const dest = DESTINATIONS[destId];
  const destinations = useMemo(() => availableDestinations(env.arcEnabled), []);

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
      destinationDomain: dest.domain,
    }),
    [dest.domain],
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

  const destinationCheck = useMemo(() => dest.checkAddress(destination), [dest, destination]);

  /**
   * Whether the destination has no USDC account yet.
   *
   * It is a *price*, not a blocker: Circle creates the account during delivery and its fee for that
   * (about twice the ordinary one) is inside the single fee the user is shown. One transaction, no
   * second step.
   *
   * Only Solana has the concept. An Arc mint credits an ERC-20 balance and creates nothing.
   */
  const recipientNeedsAccount = dest.needsAccountResolution && recipient?.status === "missing";
  // A failed or unfinished lookup is not "has an account". Pricing as if it did would quote the
  // cheaper delivery and then have Circle's forward fall short on a wallet that needs the account
  // opened, so an unverified recipient blocks the transfer instead of guessing.
  const recipientUnverified =
    dest.needsAccountResolution &&
    destinationCheck.ok &&
    (resolving || !recipient || recipient.status === "unknown");

  // Circle's fee quote depends on whether it also has to open an account, so a health reading only
  // counts for the flavour it was taken for.
  const healthKey = `${destId}:${recipientNeedsAccount}`;
  const health = healthState?.key === healthKey ? healthState.value : null;
  const healthUnavailable = healthState?.key === healthKey && healthState.value === null;

  // The contract's own switches and caps for this destination.
  useEffect(() => {
    if (!address) {
      setDomainCfg(null);
      setFeeParams(null);
      return;
    }
    let cancelled = false;
    getDomainForwardConfig(config, address)
      .then((c) => {
        if (!cancelled) setDomainCfg(c);
      })
      .catch(() => {
        if (!cancelled) setDomainCfg(null);
      });
    getWrapperFeeParams(config, address)
      .then((p) => {
        if (!cancelled) setFeeParams(p);
      })
      .catch(() => {
        if (!cancelled) setFeeParams(null);
      });
    return () => {
      cancelled = true;
    };
  }, [config, address]);

  // The delivery fee this transfer will sign: Circle's live `high` quote at 1.0x, checked against the
  // contract's caps and switches. `null` until both are known.
  const feeChoice = useMemo(
    () =>
      health?.quote && domainCfg
        ? chooseMaxFee({
            quote: health.quote,
            needsAccount: recipientNeedsAccount,
            cfg: domainCfg,
            destinationName: dest.name,
          })
        : null,
    [health, domainCfg, recipientNeedsAccount, dest.name],
  );
  const maxFee = feeChoice?.ok ? feeChoice.maxFee : null;
  const feeRefusal = feeChoice && !feeChoice.ok ? feeChoice.reason : null;

  // The contract refuses a delivery fee above a tenth of what is burned, so the smallest transfer depends on
  // the route: about 1 USDC to Arc, nearer 2 to an existing Solana account, nearer 4 to a new one. Say so
  // before the person signs, instead of surfacing the contract's error code.
  const routeMinimum =
    maxFee !== null && feeParams ? minimumForwardedAmount(maxFee, feeParams) : null;
  const routeMinimumProblem =
    routeMinimum !== null &&
    maxFee !== null &&
    amount !== null &&
    amount > 0n &&
    amount < routeMinimum
      ? `The smallest transfer to ${dest.name} right now is about ${formatUsdc(suggestedMinimum(routeMinimum))} USDC. Circle's delivery fee is ${formatUsdc(maxFee)} USDC, and it cannot be more than a tenth of what is sent.`
      : null;
  const amountProblem = amountError ?? routeMinimumProblem;

  // Quote is debounced: every keystroke would otherwise be a Soroban simulation.
  useEffect(() => {
    if (!address || !amount || amount <= 0n) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    if (feeRefusal) {
      setQuote(null);
      setQuoteError(feeRefusal);
      return;
    }
    if (routeMinimumProblem) {
      // Explained under the amount; pricing it would only produce the contract's refusal.
      setQuote(null);
      setQuoteError(null);
      return;
    }
    if (maxFee === null) {
      // Still waiting on Circle's fee or the contract's caps. Not an error unless the fee service
      // has answered that it cannot be read.
      setQuote(null);
      setQuoteError(
        healthUnavailable
          ? "We could not get Circle's delivery fee just now. Try again in a moment."
          : null,
      );
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      quoteBridge(config, address, amount, recipientNeedsAccount, maxFee)
        .then((result) => {
          if (cancelled) return;
          // A transfer the contract would not forward is a burn nobody delivers; it is not offered.
          if (!result.forwarded) {
            setQuote(null);
            setQuoteError(
              `Automatic delivery to ${dest.name} is not available for this transfer right now.`,
            );
            return;
          }
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
    // `recipientNeedsAccount` and `maxFee` are dependencies, not just arguments: both change the
    // price. Without them the user would be shown a quote taken before the answer was known and then
    // charged a different amount — which the contract rejects via `max_wrapper_fee`, so it would
    // surface as an unexplained failure at signing.
  }, [
    config,
    address,
    amount,
    recipientNeedsAccount,
    maxFee,
    feeRefusal,
    healthUnavailable,
    routeMinimumProblem,
    dest.name,
  ]);

  // Poll until Circle reports an outcome.
  //
  // Without this the receipt could only ever say "waiting", with nothing to end it — a spinner
  // that never resolves, which is a worse thing to show someone than a wrong error. It asks every
  // five seconds for the first two minutes and every fifteen after that, and stops as soon as
  // Circle reports the transfer delivered, failed, or claimable. The server budgets and caches
  // these lookups, so a long wait costs Circle's rate limit almost nothing.
  useEffect(() => {
    if (!txHash) {
      setDelivery(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    const poll = async () => {
      const result = await getDelivery(txHash);
      if (cancelled) return;
      setDelivery(result);
      const settled =
        result.status === "known" &&
        (result.state === "delivered" || result.state === "failed" || result.state === "claimable");
      if (!settled) timer = setTimeout(poll, Date.now() - startedAt < 120_000 ? 5_000 : 15_000);
    };
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [txHash]);

  // Ask whether Circle can carry this transfer before anyone is invited to sign it.
  //
  // A burn made while Circle is down is USDC the owner has to claim by hand, paying gas on a chain
  // they may hold nothing on. Declining to start is free. Re-checked every minute while the page is
  // open, and again immediately before signing.
  useEffect(() => {
    let cancelled = false;
    const key = `${destId}:${recipientNeedsAccount}`;
    const check = () =>
      getCircleHealth(destId, recipientNeedsAccount).then((h) => {
        if (!cancelled) setHealthState({ key, value: h });
      });
    void check();
    const timer = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [destId, recipientNeedsAccount]);

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
    if (!destinationCheck.ok || !dest.needsAccountResolution) {
      setRecipient(null);
      setResolving(false);
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
  }, [destination, destinationCheck.ok, dest.needsAccountResolution]);

  // What the burn names as the recipient. Solana: the resolved USDC token account, never the
  // wallet. Arc: the address itself, left-padded — an EVM mint credits the address directly.
  const mintRecipient = dest.needsAccountResolution
    ? (recipient?.tokenAccountBytes ?? null)
    : (destinationCheck.bytes ?? null);

  function chooseDestination(id: DestinationId) {
    if (id === destId) return;
    // An address valid on one chain is never valid on the other, so carrying it over could only
    // ever be a mistake waiting to be signed.
    setDestId(id);
    setDestination("");
    setSubmitError(null);
  }

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
    Boolean(kit && address && quote && destinationCheck.ok && isCctpRailConfigured) &&
    quote?.forwarded === true &&
    shortfall === null &&
    health?.status !== "down" &&
    mintRecipient !== null &&
    !recipientUnverified &&
    !submitting &&
    !quoting &&
    !resolving;

  async function bridge() {
    if (!kit || !address || !quote || !mintRecipient || !domainCfg) return;
    setSubmitting(true);
    setSentTo(destId);
    setSubmitError(null);
    setTxHash(null);
    try {
      // The check the page already ran may be a minute old. Ask again now that the user has
      // committed, because this is the last moment declining costs nothing.
      const fresh = await getCircleHealth(destId, recipientNeedsAccount);
      setHealthState({ key: healthKey, value: fresh });
      if (fresh?.status === "down") {
        setSubmitError(
          `Circle is not able to deliver to ${dest.name} right now, so nothing was sent. ${fresh.reasons[0] ?? ""}`.trim(),
        );
        return;
      }
      // With no relay, a transfer signed without a live delivery fee is one nobody can deliver.
      if (!fresh?.quote) {
        setSubmitError("We could not get Circle's delivery fee just now, so nothing was sent.");
        return;
      }

      const choice = chooseMaxFee({
        quote: fresh.quote,
        needsAccount: recipientNeedsAccount,
        cfg: domainCfg,
        destinationName: dest.name,
      });
      if (!choice.ok) {
        setSubmitError(choice.reason);
        return;
      }

      // Circle's fee drifts by a few percent over minutes. Price the transfer again at the fee about
      // to be signed, and if the total went up, stop and show it instead of signing a number the user
      // did not see. (The contract would refuse it anyway, via `max_wrapper_fee`, but as an error.)
      const latest = await quoteBridge(
        config,
        address,
        quote.amount,
        recipientNeedsAccount,
        choice.maxFee,
      );
      if (!latest.forwarded) {
        setQuote(null);
        setSubmitError(
          `Automatic delivery to ${dest.name} is not available right now, so nothing was sent.`,
        );
        return;
      }
      if (latest.fee > quote.fee) {
        setQuote(latest);
        setSubmitError(
          `Circle's delivery fee moved while you were reviewing: the fee is now ${formatUsdc(latest.fee)} USDC, was ${formatUsdc(quote.fee)}. Nothing was sent. Check the new total and confirm again.`,
        );
        return;
      }

      // The wrapper approves and burns inside one invocation, so this is one signature.
      setStep("Confirm the transfer in your wallet");
      const { txHash: hash } = await submitBridge(kit, {
        config,
        userAddress: address,
        amount: quote.amount,
        // Solana: the TOKEN ACCOUNT, never the wallet address. Circle enforces
        // recipient_token_account.key() == mint_recipient; a wallet address here strands the
        // transfer permanently. Arc: the address itself.
        mintRecipient,
        // When Circle creates the account it needs the wallet that will own it. The contract cannot
        // check that `mintRecipient` is that wallet's token account (Soroban has no curve check), so
        // the derivation happens here and Circle enforces it.
        recipientOwner: recipientNeedsAccount ? (destinationCheck.bytes ?? null) : null,
        recipientNeedsAccount,
        maxFee: choice.maxFee,
        minFinalityThreshold: STANDARD_FINALITY_THRESHOLD,
        ttlSeconds: REQUEST_TTL_SECONDS,
        // Pin the fee the user was actually shown. If it moves between quote and signing, the
        // contract rejects rather than charging more than was displayed.
        maxWrapperFee: quote.fee,
      });
      // The burn is on chain and irreversible from here. Circle attests it and its forwarding
      // service mints on the destination; the effect above watches for the outcome.
      setTxHash(hash);
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
            Circle burns your USDC on Stellar and mints the same dollars on{" "}
            {env.arcEnabled ? "Solana or Arc" : "Solana"}. No wrapped asset, no bridge token, and
            nobody holds your funds in between.
          </p>
        </Reveal>

        {!isCctpRailConfigured && (
          <Reveal delay={80} className="mt-10">
            <Notice tone="alarm" title="Bridging is not available yet">
              The bridge contract is not configured for this deployment, so no transfer can be
              started. Nothing has been sent.
            </Notice>
          </Reveal>
        )}

        <Reveal delay={140} className="mt-12">
          <GlassCard id="bridge" labelledBy="bridge-heading" className="scroll-mt-24">
            <h2 id="bridge-heading" className="sr-only">
              Bridge USDC from Stellar to {dest.name}
            </h2>

            <div className="px-5 py-5 sm:px-6">
              <RouteTrack
                from="stellar"
                to={destId}
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
                error={amountProblem}
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
                    invalid={Boolean(amountProblem)}
                    aria-invalid={amountProblem ? "true" : undefined}
                    aria-describedby={amountProblem ? "amount-error" : undefined}
                    className="tabular h-16 pr-24 text-[1.75rem] font-medium tracking-[-0.02em]"
                  />
                  <span className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-[0.8125rem] font-medium tracking-[0.02em] text-bone/35">
                    USDC
                  </span>
                </div>
              </Field>

              {destinations.length > 1 && (
                <div className="mt-6">
                  <span className="mb-2.5 block text-eyebrow font-medium uppercase text-bone/40">
                    Send to
                  </span>
                  <DestinationPicker
                    options={destinations}
                    value={destId}
                    onChange={chooseDestination}
                    disabled={submitting || Boolean(txHash)}
                  />
                </div>
              )}

              <Field
                id="destination"
                label={dest.addressLabel}
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
                  placeholder={dest.addressPlaceholder}
                  invalid={Boolean(destinationCheck.error)}
                  aria-invalid={destinationCheck.error ? "true" : undefined}
                  aria-describedby={
                    destinationCheck.error ? "destination-error" : "destination-hint"
                  }
                  className="h-14 font-mono text-sm placeholder:font-sans"
                />
              </Field>

              {dest.needsAccountResolution ? (
                <RecipientPanel
                  resolving={resolving}
                  recipient={recipient}
                  addressValid={destinationCheck.ok}
                />
              ) : (
                <ArcRecipientPanel address={destination.trim()} valid={destinationCheck.ok} />
              )}

              <QuotePanel
                quote={quote}
                loading={quoting}
                error={quoteError}
                hasAddress={Boolean(address)}
                destinationName={dest.name}
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

              {!txHash && health?.status === "down" && (
                <Notice
                  tone="alarm"
                  title={`Circle is not delivering to ${dest.name} right now`}
                  className="mt-5"
                >
                  <p>{health.reasons[0]}</p>
                  <p className="mt-1.5 text-bone/35">
                    Bridging is paused so your USDC is not burned into a transfer nobody can
                    complete. This page checks again every minute.
                  </p>
                </Notice>
              )}
              {!txHash && health?.status === "degraded" && (
                <p className="mt-5 text-[0.75rem] leading-relaxed text-bone/40">
                  {health.reasons[0]}. You can still bridge.
                </p>
              )}

              {txHash ? (
                <SubmittedNotice
                  txHash={txHash}
                  delivery={delivery}
                  destination={DESTINATIONS[sentTo]}
                />
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
  destinationName,
}: {
  quote: BridgeQuote | null;
  loading: boolean;
  error: string | null;
  hasAddress: boolean;
  destinationName: string;
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
        <DataRow
          label="Fee"
          value={`−${formatUsdc(quote.fee)} USDC`}
          hint={`Includes Circle's delivery to ${destinationName}${quote.accountCreated ? ", and opening the recipient's USDC account" : ""}. Nothing more to pay on ${destinationName}.`}
        />
        {quote.remainder > 0n && (
          <DataRow
            label="Not sent"
            value={`${formatUsdc(quote.remainder)} USDC`}
            hint={`Below USDC's smallest unit on ${destinationName}, so it stays in your wallet.`}
          />
        )}
        <div className="pt-3">
          <StripeRule className="mb-3 opacity-50" />
          <DataRow
            label="Recipient gets"
            value={`${formatUsdc(quote.netBurned - quote.forwardFee)} USDC`}
            emphasis
            hint="After every fee."
          />
        </div>
      </dl>
    </InsetTray>
  );
}

function SubmittedNotice({
  txHash,
  delivery,
  destination,
}: {
  txHash: string;
  delivery: DeliveryView | null;
  destination: Destination;
}) {
  return (
    <div className="mt-6">
      <Notice tone="signal" title="Burn submitted">
        Circle attests the transfer, then delivers it to {destination.name}. This usually takes a
        few minutes. If delivery ever fails, your USDC is still yours: anyone holding Circle&rsquo;s
        attestation can complete the mint, and you can do it yourself.
      </Notice>
      <InsetTray className="mt-2.5 py-3">
        <div className="flex items-center gap-3">
          <span className="tabular min-w-0 flex-1 truncate font-mono text-xs text-bone/45">
            {txHash}
          </span>
          <CopyButton value={txHash} label="transaction hash" />
        </div>
        <DeliveryStatus delivery={delivery} txHash={txHash} destination={destination} />
      </InsetTray>
    </div>
  );
}

const claimLink =
  "text-bone/70 underline decoration-bone/25 underline-offset-[3px] transition-colors duration-200 ease-haptic hover:text-bone hover:decoration-bone/50";

/**
 * Where the transfer is, in Circle's words.
 *
 * Three outcomes ask different things of the reader. Waiting and forwarding mean do nothing.
 * Delivered links to the destination transaction. Failed and claimable mean the dollars are burned
 * and one more signature from the owner collects them, so the link has to be here rather than left
 * as an idea. There is no relay to fall back on: a failed forward is the owner's to claim, and the
 * page says so plainly.
 *
 * `unknown` is its own line. Not being able to ask is not progress and not failure.
 */
function DeliveryStatus({
  delivery,
  txHash,
  destination,
}: {
  delivery: DeliveryView | null;
  txHash: string;
  destination: Destination;
}) {
  const line = "mt-2.5 flex items-center gap-2 border-t border-bone/[0.06] pt-2.5 text-[0.75rem]";

  if (delivery?.status === "known" && delivery.state === "delivered") {
    return (
      <div className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-signal" />
        <span>
          Delivered to {destination.name}.{" "}
          {delivery.forwardTxHash ? (
            <a
              href={destination.explorerTxUrl(delivery.forwardTxHash)}
              target="_blank"
              rel="noreferrer"
              className={claimLink}
            >
              View it
            </a>
          ) : null}
        </span>
      </div>
    );
  }

  if (
    delivery?.status === "known" &&
    (delivery.state === "failed" || delivery.state === "claimable")
  ) {
    return (
      <div className="mt-2.5 border-t border-bone/[0.06] pt-2.5 text-[0.75rem] leading-relaxed text-bone/45">
        <p className="flex items-center gap-2">
          <span className="h-1 w-1 shrink-0 rounded-full bg-alarm" />
          {delivery.state === "failed"
            ? `Circle could not deliver this to ${destination.name}${delivery.reason ? ` (${delivery.reason})` : ""}.`
            : `This transfer was not set up for automatic delivery to ${destination.name}.`}
        </p>
        <p className="mt-1.5 pl-3">
          Your USDC is burned and still yours: Circle&rsquo;s attestation is public and does not
          expire for a transfer like this, so it can be minted by anyone holding it.{" "}
          <a href={`/claim?tx=${encodeURIComponent(txHash)}`} className={claimLink}>
            Claim it yourself
          </a>{" "}
          — you pay the {destination.name} gas, {destination.claimCost}.
        </p>
      </div>
    );
  }

  if (delivery?.status === "unknown") {
    return (
      <p className={`${line} text-bone/45`}>
        <span className="h-1 w-1 shrink-0 rounded-full bg-bone/30" />
        We cannot read Circle&rsquo;s status right now. Your transfer is not affected; check{" "}
        {destination.name} for the USDC, or try again shortly.
      </p>
    );
  }

  return (
    <p className={`${line} text-bone/45`}>
      <span className="h-1 w-1 shrink-0 rounded-full bg-signal animate-breathe" />
      {delivery?.status === "known" && delivery.state === "forwarding"
        ? `Circle is delivering to ${destination.name}.`
        : "Waiting for Circle to attest the transfer."}
    </p>
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
    { icon: Spark, title: "Delivered for you", body: "Circle mints it. Usually a few minutes." },
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

/**
 * Arc's counterpart of `RecipientPanel`, and much smaller because there is less to resolve.
 *
 * Nothing needs looking up — an Arc mint credits the address directly — so this only shows the
 * one thing worth a second look before a burn nobody can undo: the address exactly as it will be
 * used, in its checksummed form. A typo that survives validation shows up as a different string
 * here, in a different case pattern, which is easier to notice than in the box it was typed into.
 */
function ArcRecipientPanel({ address, valid }: { address: string; valid: boolean }) {
  if (!valid) return null;
  return (
    <InsetTray className="mt-3 py-3">
      <p className="text-xs text-bone/40">USDC will be minted to this Arc address</p>
      <p className="tabular mt-1.5 break-all font-mono text-xs text-bone/70">
        {getAddress(address)}
      </p>
    </InsetTray>
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
  addressValid,
}: {
  resolving: boolean;
  recipient: RecipientResolution | null;
  addressValid: boolean;
}) {
  if (!addressValid) return null;

  if (resolving || !recipient) {
    return <p className="mt-3 text-[0.8125rem] text-bone/40">Checking the recipient account…</p>;
  }

  // A missing account is a price, not a wall: Circle opens it while delivering, and its fee for that
  // is already inside the fee shown above.
  if (recipient.status === "missing") {
    return (
      <Notice tone="info" title="Circle will open this wallet's USDC account" className="mt-3">
        First transfer to this wallet, so its USDC account does not exist yet. Circle creates it as
        part of delivery, and the fee above already covers that. It is a one-off — later transfers
        skip it. To move the USDC on afterwards, the wallet will need a little SOL for network fees.
        <p className="mt-2 break-all font-mono text-[0.75rem] text-bone/40">
          {recipient.tokenAccount}
        </p>
      </Notice>
    );
  }

  // A failed lookup must not read as "no account" (that blocked a wallet that plainly held USDC),
  // and it must not read as "has one" either: the price and the delivery both depend on which it
  // is, so the transfer waits until the lookup succeeds.
  if (recipient.status === "unknown") {
    return (
      <Notice tone="info" title="Could not check the recipient account" className="mt-3">
        The Solana lookup failed{recipient.reason ? `: ${recipient.reason}` : ""}. Bridging stays
        off until it succeeds, because whether this wallet already has a USDC account changes what
        delivery costs. Change the address or wait a moment and it will retry.
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
