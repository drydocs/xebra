import type React from "react";
import { cn } from "./cn";

/**
 * One line of a breakdown. Label left, figure right, optional sub-line under the label.
 *
 * Figures are `tabular` without exception: a fee panel that re-quotes on every keystroke
 * will visibly jitter its decimal points otherwise, which reads as instability in a screen
 * whose entire job is to be trusted with money.
 */
export function DataRow({
  label,
  value,
  hint,
  emphasis,
  tone = "default",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** The line the eye should land on — the amount that actually arrives. */
  emphasis?: boolean;
  tone?: "default" | "signal";
}) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className={cn("text-sm", emphasis ? "font-medium text-bone/85" : "text-bone/50")}>
        {label}
        {hint && <span className="mt-1 block text-xs leading-relaxed text-bone/30">{hint}</span>}
      </dt>
      <dd
        className={cn(
          "tabular shrink-0 text-sm",
          emphasis ? "text-[0.9375rem] font-semibold" : "font-medium",
          tone === "signal" ? "text-signal" : emphasis ? "text-bone" : "text-bone/70",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
