"use client";

import type { CircleHealth } from "@xebra/cctp-client";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "../../lib/cctp-bridge";
import { type DeliveryView, getCircleHealth, getDelivery } from "../../lib/circle-status";
import { DESTINATIONS, type DestinationId, availableDestinations } from "../../lib/destinations";
import { env, isCctpRailConfigured } from "../../lib/env";
import { formatError, reportError } from "../../lib/format-error";
import {
  type DomainForwardConfig,
  type FeeParams,
  chooseMaxFee,
  minimumForwardedAmount,
  suggestedMinimum,
} from "../../lib/forward-fee";
import { type RecipientResolution, resolveRecipient } from "../../lib/solana-address";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { ArrowRight } from "../ui/icons";
import { Notice } from "../ui/notice";
import { StripeRule } from "../ui/stripe-rule";
import { useWallets } from "../wallet/wallet-provider";
import { DestinationPicker } from "./destination-picker";
import { QUICK_AMOUNTS, QuickAmount } from "./quick-amount";
import { SubmittedNotice } from "./receipt";
import { ArcRecipientPanel, RecipientPanel, UseMyWallet } from "./recipient-panels";
import { RouteTrack } from "./route-track";
import { QuotePanel } from "./stellar-quote-panel";

/**
 * One job: move USDC from Stellar to Solana or Arc over Circle's CCTP, through Xebra's wrapper.
 * The bridge screen (`app/page.tsx`) shows this form when the source is Stellar; a transfer that
 * starts on an EVM chain is `evm-bridge-form.tsx`.
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
 * are `components/ui/*`, so the screen that sends money cannot drift away from the one
 * that reports on it (`app/intent/[hash]`). See `tailwind.config.ts` for the tokens.
 */

/** Standard finality, the only kind Stellar has: Fast Transfer is not available from Stellar. */
const STANDARD_FINALITY_THRESHOLD = 2000;
/** How long a signed request stays valid. The contract caps this at one hour. */
const REQUEST_TTL_SECONDS = 600;

export function StellarBridgeForm({
  sourcePicker,
  onBusyChange,
}: {
  /** The "Send from" control, owned by the screen because it chooses which form this is. */
  sourcePicker?: React.ReactNode;
  /** True while a transfer is being signed or its receipt is on show. */
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  // Wallets live in <WalletProvider>: Stellar signs and pays; a Solana or EVM wallet can fill in the
  // recipient. Only the Stellar connection is the sender.
  const { connections, stellarKit: kit, open: openWallets } = useWallets();
  const address = connections.stellar?.address ?? null;
  // Deliberately small. This is mainnet: the field's default is the amount someone will send
  // if they don't think about it. Five sits above the smallest transfer each destination takes at
  // today's delivery fees (see `routeMinimum` below), so a first transfer can still be small.
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

  const busy = submitting || Boolean(txHash);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const dest = DESTINATIONS[destId];
  const destinations = useMemo(() => availableDestinations(env.arcEnabled), []);

  // Always present. With no wrapper configured, `wrapperContractId` is null and nothing can be
  // sent: there is no direct path around the wrapper (see `lib/cctp-bridge.ts`).
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

  const connect = useCallback(() => openWallets(["stellar", "solana", "evm"]), [openWallets]);

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
        {sourcePicker}

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
            aria-describedby={destinationCheck.error ? "destination-error" : "destination-hint"}
            className="h-14 font-mono text-sm placeholder:font-sans"
          />
        </Field>

        <UseMyWallet
          family={destId === "solana" ? "solana" : "evm"}
          connection={connections[destId === "solana" ? "solana" : "evm"]}
          disabled={submitting || Boolean(txHash)}
          onUse={setDestination}
          onConnect={openWallets}
        />

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
            This wallet holds <span className="tabular">{formatUsdc(balance ?? 0n)}</span> USDC, and
            this transfer needs <span className="tabular">{formatUsdc(quote?.amount ?? 0n)}</span>{" "}
            including the fee — <span className="tabular">{formatUsdc(shortfall)}</span> short.
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
              No funds have moved unless a transaction hash is shown. Full detail is in the browser
              console under <code className="font-mono">[xebra]</code>.
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
              Bridging is paused so your USDC is not burned into a transfer nobody can complete.
              This page checks again every minute.
            </p>
          </Notice>
        )}
        {!txHash && health?.status === "degraded" && (
          <p className="mt-5 text-[0.75rem] leading-relaxed text-bone/40">
            {health.reasons[0]}. You can still bridge.
          </p>
        )}

        {txHash ? (
          <SubmittedNotice txHash={txHash} delivery={delivery} destination={DESTINATIONS[sentTo]} />
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
    </>
  );
}
