import { cn } from "../ui/cn";

/**
 * The Xebra mark: a zebra flank.
 *
 * Four stripes, no two the same width, tapering as they curve over the shoulder — a zebra's
 * stripes are individual, which is the whole reason the animal is a good name for a bridge
 * that fingerprints each transfer. Drawn as round-capped strokes that stay inside the frame
 * rather than clipped to it, so the component needs no `<clipPath>` and can therefore be
 * rendered more than once on a page without colliding ids.
 */
export function XebraMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("h-8 w-8", className)}>
      <rect
        x="0.6"
        y="0.6"
        width="30.8"
        height="30.8"
        rx="9.6"
        className="fill-bone/[0.06] stroke-bone/25"
        strokeWidth="1.2"
      />
      <g stroke="currentColor" strokeLinecap="round" fill="none">
        <path d="M6.6 25.2c2.4-6 2.6-11.4 1.2-17.6" strokeWidth="2.4" opacity="0.55" />
        <path d="M12.6 26.6c2.6-6.8 2.7-13.6 1.1-20.4" strokeWidth="3.4" />
        <path d="M19.2 26c2.5-6.5 2.6-12.9 1.2-19.6" strokeWidth="2.1" opacity="0.85" />
        <path d="M25 24.3c1.8-5.2 1.9-10.1 1.1-14.6" strokeWidth="1.3" opacity="0.5" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark. The word is set tight and heavy; the mark carries the colour. */
export function XebraWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <XebraMark className="h-7 w-7 text-bone" />
      <span className="text-[0.95rem] font-semibold tracking-[-0.02em] text-bone">Xebra</span>
    </span>
  );
}
