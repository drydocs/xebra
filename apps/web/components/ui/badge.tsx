import type React from "react";
import { cn } from "./cn";

type Tone = "neutral" | "signal" | "alarm";

const TONES: Record<Tone, string> = {
  neutral: "text-bone/55 ring-bone/12 bg-bone/[0.04]",
  signal: "text-signal ring-signal/25 bg-signal/[0.07]",
  alarm: "text-alarm ring-alarm/25 bg-alarm/[0.07]",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-bone/45",
  signal: "bg-signal",
  alarm: "bg-alarm",
};

/**
 * A status chip. The optional dot is the only thing on the page that pulses, which is what
 * makes "live" legible without the word.
 */
export function Badge({
  tone = "neutral",
  dot,
  pulse,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1",
        "text-[0.6875rem] font-medium uppercase tracking-[0.1em]",
        "ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 rounded-full", DOTS[tone], pulse && "animate-breathe")}
        />
      )}
      {children}
    </span>
  );
}

/**
 * The eyebrow above a headline. Not a badge: no fill, no ring — just a stripe and a whisper
 * of letter-spaced type, so it introduces the heading instead of competing with it.
 */
export function Eyebrow({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("flex items-center gap-3 text-eyebrow uppercase text-bone/40", className)}>
      <span aria-hidden="true" className="rail-stripes h-2.5 w-9 rounded-[1px] opacity-80" />
      {children}
    </span>
  );
}
