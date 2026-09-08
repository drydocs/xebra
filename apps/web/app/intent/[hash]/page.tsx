"use client";

import { use } from "react";
import { XebraWordmark } from "../../../components/brand/xebra-mark";
import { StatusBadge } from "../../../components/status-badge";
import { Eyebrow } from "../../../components/ui/badge";
import { cn } from "../../../components/ui/cn";
import { DataRow } from "../../../components/ui/data-row";
import { GlassCard, InsetTray } from "../../../components/ui/glass-card";
import { Notice } from "../../../components/ui/notice";
import { Reveal } from "../../../components/ui/reveal";
import { Skeleton } from "../../../components/ui/skeleton";
import { StripeRule } from "../../../components/ui/stripe-rule";
import { trpc } from "../../../lib/trpc";

const STAGES = ["open", "claimed", "finalized"] as const;

/**
 * Shareable per-intent verification page (docs/architecture.md §9) — reads the same data a
 * challenger would use to verify a claim, via apps/api's `intentStatus` procedure. Polls while
 * the intent is still in flight so a user watching this page sees state advance without
 * refreshing.
 *
 * It is built from the same `components/ui/*` set as the bridge screen. That is the point of
 * having the set: a page someone lands on from a shared link should not look like it belongs
 * to a different product than the one that produced the link.
 */
export default function IntentStatusPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = use(params);

  const query = trpc.intentStatus.useQuery(
    { intentHash: hash as `0x${string}` },
    {
      refetchInterval: (q) => {
        const status = q.state.data?.intent.status;
        return status === "finalized" || status === "refunded" ? false : 5000;
      },
    },
  );

  const { intent, claim } = query.data ?? {};
  const stageIndex = intent ? STAGES.indexOf(intent.status as (typeof STAGES)[number]) : -1;

  return (
    <main className="mx-auto w-full max-w-xl px-4 pb-24 pt-14 sm:px-5 sm:pt-20">
      <Reveal as="header" className="px-1">
        <a
          href="/"
          className="inline-flex transition-opacity duration-400 ease-haptic hover:opacity-70"
        >
          <XebraWordmark />
          <span className="sr-only">Back to the bridge</span>
        </a>
        <Eyebrow className="mt-10">Transfer record</Eyebrow>
        <h1 className="mt-5 text-title font-semibold text-bone">Intent</h1>
        <p className="tabular mt-2 break-all font-mono text-xs leading-relaxed text-bone/35">
          {hash}
        </p>
      </Reveal>

      <Reveal delay={100} className="mt-10">
        {query.isLoading ? (
          <GlassCard>
            <div className="space-y-4 p-6">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          </GlassCard>
        ) : query.error ? (
          <Notice tone="alarm" title="Could not load this intent">
            {query.error.message}
          </Notice>
        ) : !intent ? (
          <Notice tone="info" title="No intent at this hash">
            The link may be truncated, or the intent may not have been indexed yet.
          </Notice>
        ) : (
          <GlassCard>
            <div className="flex items-center justify-between gap-4 px-5 py-5 sm:px-6">
              <StageRail index={stageIndex} />
              <StatusBadge status={intent.status} />
            </div>

            <StripeRule />

            <div className="px-5 py-6 sm:px-6">
              <dl className="tabular space-y-3">
                <DataRow label="Source amount" value={intent.sourceAmount} />
                <DataRow label="Minimum delivered" value={intent.minDestAmount} />
                <DataRow label="Expires" value={new Date(intent.expiry).toLocaleString()} />
              </dl>

              {claim && (
                <InsetTray className="mt-6">
                  <h2 className="text-eyebrow font-medium uppercase text-bone/40">Solver claim</h2>
                  <dl className="tabular mt-4 space-y-3">
                    <DataRow
                      label="Solver"
                      value={
                        <span className="font-mono text-xs">
                          {claim.solverAddress.slice(0, 6)}…{claim.solverAddress.slice(-6)}
                        </span>
                      }
                    />
                    <DataRow label="Delivered" value={claim.deliveredAmount} emphasis />
                    <DataRow
                      label="Delivery tx"
                      value={
                        <span className="font-mono text-xs">
                          {claim.destTxRef.slice(0, 6)}…{claim.destTxRef.slice(-6)}
                        </span>
                      }
                    />
                  </dl>
                </InsetTray>
              )}
            </div>
          </GlassCard>
        )}
      </Reveal>
    </main>
  );
}

/**
 * Progress as a zebra rail rather than three coloured chips: the stages are one continuous
 * run whose completed portion is lit. Chips imply three independent things happened; a rail
 * says how far along one thing is, which is what a transfer actually is.
 */
function StageRail({ index }: { index: number }) {
  return (
    <ol className="flex min-w-0 flex-1 items-center gap-2">
      {STAGES.map((stage, i) => (
        <li key={stage} className="min-w-0 flex-1">
          <span
            aria-hidden="true"
            className={cn(
              "rail-stripes block h-1.5 rounded-[1px] transition-opacity duration-800 ease-haptic",
              i <= index ? "opacity-100" : "opacity-20",
            )}
          />
          <span
            className={cn(
              "mt-2 block truncate text-[0.6875rem] uppercase tracking-[0.12em]",
              i <= index ? "text-bone/60" : "text-bone/25",
            )}
          >
            {stage}
          </span>
        </li>
      ))}
    </ol>
  );
}
