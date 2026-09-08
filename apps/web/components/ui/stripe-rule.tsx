import { cn } from "./cn";

/**
 * The divider. A zebra stripe rather than a `<hr>`: a short run of hairline bars that fades
 * out at both ends, so it never terminates in a hard stub against the plate's rounded
 * corners. `role="presentation"` because it separates nothing a screen reader needs told
 * about — the headings already do that.
 */
export function StripeRule({ className }: { className?: string }) {
  return (
    <div
      role="presentation"
      className={cn(
        "rail-stripes h-px w-full opacity-70",
        "[mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]",
        className,
      )}
    />
  );
}
