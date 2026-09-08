"use client";

import type React from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "quiet";
type Size = "sm" | "md" | "lg";

/**
 * Xebra's one button.
 *
 * # Why the primary action is bone, not the accent colour
 *
 * The accent (`signal`) means *confirmed*. If the button that starts an irreversible mainnet
 * transfer were also green, the interface would be saying "done" before anything had
 * happened. The primary action is therefore the brightest neutral on the page — which is
 * also the correct read for a monochrome brand, and is what makes the one green thing on
 * screen mean something.
 *
 * # The nested icon
 *
 * A trailing arrow never floats next to the label. It sits in its own circular well flush
 * with the button's right padding, and on hover the well — not the button — moves. The
 * button itself only presses (`active:scale`). That split is what makes the control feel
 * like a physical thing with a part in it rather than a rectangle that animates.
 */
const VARIANTS: Record<Variant, string> = {
  primary: cn(
    "bg-bone text-obsidian shadow-pill",
    "hover:bg-white disabled:bg-bone/15 disabled:text-bone/40 disabled:shadow-none",
  ),
  secondary: cn(
    "bg-bone/[0.06] text-bone ring-1 ring-inset ring-bone/15 backdrop-blur-xl",
    "hover:bg-bone/[0.11] hover:ring-bone/25 disabled:text-bone/30 disabled:ring-bone/10",
  ),
  quiet: "text-bone/60 hover:text-bone disabled:text-bone/25",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 gap-2 px-4 text-[0.8125rem]",
  md: "h-11 gap-2.5 px-5 text-sm",
  lg: "h-14 gap-3 pl-7 pr-3 text-[0.9375rem]",
};

export function Button({
  variant = "primary",
  size = "md",
  trailing,
  className,
  children,
  ...rest
}: {
  variant?: Variant;
  size?: Size;
  /** Renders inside the nested circular well at the button's right edge. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "group/btn relative inline-flex select-none items-center justify-center overflow-hidden",
        "rounded-full font-medium tracking-[-0.01em]",
        "transition-[background-color,color,box-shadow,transform] duration-400 ease-haptic",
        "active:scale-[0.985] disabled:cursor-not-allowed disabled:active:scale-100",
        // The well moves, the button presses. Scoped to `:enabled` through an arbitrary
        // variant because `:hover` still matches a disabled button in every engine, and a
        // dead control that reacts to the cursor is worse than one that does nothing.
        "enabled:hover:[&_[data-well]]:translate-x-0.5 enabled:hover:[&_[data-well]]:-translate-y-px",
        VARIANTS[variant],
        SIZES[size],
        !trailing && size === "lg" && "px-7",
        className,
      )}
      {...rest}
    >
      <span className="relative z-10 flex-1 text-center">{children}</span>
      {trailing && (
        <span
          aria-hidden="true"
          data-well=""
          className={cn(
            "relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full",
            "transition-transform duration-400 ease-haptic",
            variant === "primary"
              ? "bg-obsidian/[0.08] text-obsidian group-disabled/btn:text-bone/40"
              : "bg-bone/10 text-bone",
          )}
        >
          {trailing}
        </span>
      )}
    </button>
  );
}
