"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";

/**
 * Scroll-entry choreography.
 *
 * Elements arrive: 18px up, out of a 6px blur, over 800ms on the haptic curve, staggered by
 * `delay`. Nothing mounts statically.
 *
 * `IntersectionObserver`, never a scroll listener — a listener fires on every frame of every
 * scroll and forces layout each time, which is how a one-card page ends up dropping frames
 * on a phone. The observer disconnects after the first crossing; this content does not
 * re-animate on the way back up.
 *
 * # The no-JavaScript case
 *
 * The hidden state is in the server-rendered markup, because the alternative — render
 * visible, then hide on mount, then reveal — flashes the entire page on every load. The
 * cost is that a client with no JavaScript would see nothing, so `app/layout.tsx` ships a
 * `<noscript>` rule that force-shows every `[data-reveal]`. Keep the attribute and that rule
 * in step.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  /** Milliseconds of stagger. Keep steps at 60-90ms; more reads as lag, less as simultaneous. */
  delay?: number;
  className?: string;
  as?: "div" | "section" | "header" | "footer";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as React.Ref<never>}
      data-reveal=""
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "transition-[opacity,transform,filter] duration-800 ease-haptic will-change-[opacity,transform]",
        shown ? "translate-y-0 opacity-100 blur-0" : "translate-y-[18px] opacity-0 blur-[6px]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
