import type React from "react";
import { cn } from "./cn";

/**
 * A labelled control.
 *
 * The label, the control and whatever the control has to say about itself are one unit, so
 * they are one component: every field on the bridge screen wires `htmlFor`, `aria-invalid`
 * and `aria-describedby` identically, and doing that by hand at each call site is how one of
 * them eventually ships without the description attached.
 *
 * A field shows a hint *or* an error, never both — stacking them makes the user read the
 * advice they already failed to follow before reaching the thing that is actually wrong.
 */
export function Field({
  id,
  label,
  hint,
  error,
  trailing,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null | undefined;
  /** Small right-aligned content on the label line — a unit, a balance, a quick action. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-eyebrow font-medium uppercase text-bone/40">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p
          id={`${id}-error`}
          className="mt-2.5 flex items-start gap-1.5 text-[0.8125rem] text-alarm"
        >
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-2.5 text-xs leading-relaxed text-bone/35">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * The input well. Recessed rather than raised: an editable surface should look like
 * something you can put a value *into*, which means an inner shadow at the top edge and a
 * fill darker than the plate it sits on — the inverse of the lighting on a button.
 */
export function Input({
  invalid,
  className,
  ...rest
}: { invalid?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-tray bg-obsidian-sunken/80 px-4 text-bone",
        "shadow-[inset_0_1px_3px_0_hsl(228_40%_2%/0.9)]",
        "ring-1 ring-inset transition-[box-shadow,background-color] duration-400 ease-haptic",
        "placeholder:text-bone/25",
        invalid
          ? "ring-alarm/40 hover:ring-alarm/55"
          : "ring-bone/[0.07] hover:ring-bone/[0.16] focus:ring-bone/25",
        className,
      )}
      {...rest}
    />
  );
}
