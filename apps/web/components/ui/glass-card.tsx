"use client";

import type React from "react";
import { useCallback, useRef } from "react";
import { cn } from "./cn";

/**
 * The double-bezel plate.
 *
 * A premium card is never one box. This is two: an outer shell that reads as the machined
 * tray (hairline ring, blurred glass, the shoulder of zebra stripes) and an inner core that
 * reads as the plate sitting in it, with its own top-edge highlight and a radius computed to
 * stay concentric with the shell's — `rounded-shell` minus the 6px of shell padding, which
 * is what `rounded-core` is. Get that arithmetic wrong and the corners visibly "pinch",
 * which is the single most common tell of a card built by stacking two `rounded-2xl` divs.
 *
 * # What makes the glass read as glass
 *
 * `backdrop-blur` alone reads as a grey box. Real glass has an edge: a specular band along
 * the top where the light catches the bevel, and a spotlight that tracks the pointer across
 * the surface. Both are here, and both are pure paint — no layout property is animated.
 *
 * The blur lives on the shell only. It is an expensive filter and the guidance is to keep it
 * off scrolling content; one plate per screen is the budget.
 */
export function GlassCard({
  children,
  className,
  labelledBy,
  spotlight = true,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  labelledBy?: string;
  /** Pointer-tracking highlight. Off for plates that are pure readout. */
  spotlight?: boolean;
} & Omit<React.HTMLAttributes<HTMLElement>, "children" | "className">) {
  const ref = useRef<HTMLElement>(null);
  const frame = useRef(0);

  // Coalesced to one write per animation frame. `pointermove` fires far faster than the
  // compositor paints, and setting a custom property on every event is how a hover effect
  // starts costing frames on a laptop trackpad.
  const track = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (frame.current) return;
    const { clientX, clientY } = event;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const node = ref.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      node.style.setProperty("--spot-x", `${clientX - box.left}px`);
      node.style.setProperty("--spot-y", `${clientY - box.top}px`);
    });
  }, []);

  return (
    <section
      ref={ref}
      aria-labelledby={labelledBy}
      onPointerMove={spotlight ? track : undefined}
      className={cn(
        "group/plate relative rounded-shell p-1.5",
        "bg-bone/[0.035] ring-1 ring-inset ring-bone/[0.09]",
        "shadow-plate backdrop-blur-2xl",
        className,
      )}
      {...rest}
    >
      {/* The hide. Masked to fade off the bottom, so the stripes read as light falling
          across a shoulder rather than as wallpaper. */}
      <span
        aria-hidden="true"
        className="hide-stripes pointer-events-none absolute inset-0 rounded-shell opacity-60 [mask-image:linear-gradient(180deg,black,transparent_55%)]"
      />

      {/* Specular band: the bevel catching the key light from above. Inset from both edges
          and faded at the ends — a bright even line across the top would read as a border. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-bone/40 to-transparent"
      />

      {spotlight && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-shell opacity-0",
            "transition-opacity duration-600 ease-haptic group-hover/plate:opacity-100",
            "[background:radial-gradient(22rem_18rem_at_var(--spot-x,50%)_var(--spot-y,0px),hsl(var(--bone)/0.055),transparent_70%)]",
            // Fine pointers only: on touch there is no hover, and the last tap would leave a
            // highlight stuck to the surface.
            "[@media(hover:none)]:hidden",
          )}
        />
      )}

      <div
        className={cn(
          "relative rounded-core bg-obsidian-raised/80",
          "shadow-[inset_0_1px_0_0_hsl(var(--bone)/0.09)]",
          "ring-1 ring-inset ring-bone/[0.05]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A recessed tray for content that belongs *inside* the plate — the fee breakdown, a
 * submitted-transfer receipt. Darker than its parent and lit from below rather than above,
 * so it reads as milled into the surface instead of stacked on top of it.
 */
export function InsetTray({
  children,
  className,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  return (
    <div
      className={cn(
        "rounded-tray bg-obsidian-sunken/70 px-4 py-4",
        "shadow-[inset_0_1px_2px_0_hsl(228_40%_2%/0.8),0_1px_0_0_hsl(var(--bone)/0.04)]",
        "ring-1 ring-inset ring-bone/[0.05]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
