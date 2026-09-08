import { Badge } from "./ui/badge";

/**
 * An intent's lifecycle state.
 *
 * The palette carries exactly two meanings — confirmed (`signal`) and failed (`alarm`) — so
 * the in-flight states stay neutral and pulse instead. Giving `open` and `claimed` their own
 * hues, as this used to (blue and amber), meant five colours on a page whose product is
 * monochrome, and it made "claimed" look like a warning when it is simply progress.
 */
const TONES = {
  open: { tone: "neutral", live: true },
  claimed: { tone: "neutral", live: true },
  challenged: { tone: "alarm", live: false },
  finalized: { tone: "signal", live: false },
  refunded: { tone: "neutral", live: false },
} as const satisfies Record<string, { tone: "neutral" | "signal" | "alarm"; live: boolean }>;

export function StatusBadge({ status }: { status: string }) {
  const { tone, live } = TONES[status as keyof typeof TONES] ?? { tone: "neutral", live: false };
  return (
    <Badge tone={tone} dot pulse={live}>
      {status}
    </Badge>
  );
}
