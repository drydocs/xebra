import { cn } from "./cn";

/**
 * A loading bar shaped like the thing that is loading. Skeletons beat spinners here because
 * the fee panel's height is known in advance — a spinner would let the plate resize under
 * the cursor the moment a quote arrives, right where the user is about to press.
 *
 * The sheen is a translated gradient rather than an animated background-position, so it
 * stays on the compositor.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-full bg-bone/[0.06]", className)}>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -left-full w-1/2 animate-sheen bg-gradient-to-r from-transparent via-bone/[0.13] to-transparent"
      />
    </div>
  );
}
