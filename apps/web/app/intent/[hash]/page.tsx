"use client";

import { use } from "react";
import { StatusBadge } from "../../../components/status-badge";
import { trpc } from "../../../lib/trpc";

const STAGES = ["open", "claimed", "finalized"] as const;

/**
 * Shareable per-intent verification page (docs/architecture.md §9) — reads the same data a
 * challenger would use to verify a claim, via apps/api's `intentStatus` procedure. Polls while
 * the intent is still in flight so a user watching this page sees state advance without
 * refreshing.
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

  if (query.isLoading) {
    return <p className="text-slate-400">Loading…</p>;
  }

  if (query.error) {
    return <p className="text-red-400">{query.error.message}</p>;
  }

  const { intent, claim } = query.data ?? {};
  if (!intent) return null;

  const stageIndex = STAGES.indexOf(intent.status as (typeof STAGES)[number]);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-semibold">Intent</h1>
        <p className="break-all font-mono text-xs text-slate-500">{hash}</p>
      </header>

      <div className="flex items-center gap-3">
        <StatusBadge status={intent.status} />
      </div>

      <ol className="flex gap-2">
        {STAGES.map((stage, i) => (
          <li
            key={stage}
            className={`flex-1 rounded px-2 py-1 text-center text-xs uppercase ${
              i <= stageIndex ? "bg-emerald-500/30 text-emerald-300" : "bg-slate-800 text-slate-500"
            }`}
          >
            {stage}
          </li>
        ))}
      </ol>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-500">Source amount</dt>
        <dd className="font-mono">{intent.sourceAmount}</dd>
        <dt className="text-slate-500">Min dest amount</dt>
        <dd className="font-mono">{intent.minDestAmount}</dd>
        <dt className="text-slate-500">Expiry</dt>
        <dd>{new Date(intent.expiry).toLocaleString()}</dd>
      </dl>

      {claim && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-300">Solver claim</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Solver</dt>
            <dd className="break-all font-mono text-xs">{claim.solverAddress}</dd>
            <dt className="text-slate-500">Delivered amount</dt>
            <dd className="font-mono">{claim.deliveredAmount}</dd>
            <dt className="text-slate-500">Delivery tx</dt>
            <dd className="break-all font-mono text-xs">{claim.destTxRef}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}
