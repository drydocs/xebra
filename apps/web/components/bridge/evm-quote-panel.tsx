import type { FeePlan } from "../../lib/evm-forward-fee";
import { formatUsdc6 } from "../../lib/usdc6";
import { cn } from "../ui/cn";
import { DataRow } from "../ui/data-row";
import { InsetTray } from "../ui/glass-card";
import { Notice } from "../ui/notice";
import { Skeleton } from "../ui/skeleton";
import { StripeRule } from "../ui/stripe-rule";

/**
 * What a transfer from an EVM chain costs and what arrives.
 *
 * The Stellar panel reads its figures from the wrapper contract. There is no contract on this
 * route, so these come from Circle's own quote (`lib/evm-forward-fee.ts`), and for the same reason
 * there is no wallet to wait for: the price is the same for everyone, and is shown before anyone
 * connects.
 *
 * Fees are taken out of the amount, not added to it. The wallet is debited exactly "Amount" and
 * the recipient is minted "Recipient gets"; Circle keeps the difference.
 */
export function EvmQuotePanel({
  amount,
  plan,
  error,
  sourceName,
  destinationName,
}: {
  amount: bigint | null;
  /** Null while Circle's quote is loading or there is no amount to price. */
  plan: FeePlan | null;
  /** A reason the route cannot be priced at all, already in a sentence. */
  error: string | null;
  sourceName: string;
  destinationName: string;
}) {
  if (error) {
    return (
      <Notice tone="alarm" title="Could not price this transfer" className="mt-6">
        {error}
      </Notice>
    );
  }

  if (!plan?.ok || amount === null) {
    // The same skeleton as the Stellar panel: the shape of what is coming, so the plate does not
    // resize under the cursor when the quote lands.
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
        <DataRow label="Amount" value={`${formatUsdc6(amount)} USDC`} />
        <DataRow
          label="Delivery"
          value={`−${formatUsdc6(plan.deliveryFee)} USDC`}
          hint={`Circle mints it on ${destinationName} for you. Nothing more to pay there.`}
        />
        {plan.speedFee > 0n && (
          <DataRow
            label="Fast transfer"
            value={`−${formatUsdc6(plan.speedFee)} USDC`}
            hint={`Circle's fee for not waiting on ${sourceName} to finalise.`}
          />
        )}
        <div className="pt-3">
          <StripeRule className="mb-3 opacity-50" />
          <DataRow
            label="Recipient gets"
            value={`${formatUsdc6(plan.received)} USDC`}
            emphasis
            hint="After every fee."
          />
        </div>
      </dl>
    </InsetTray>
  );
}
