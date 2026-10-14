import { cn } from "../ui/cn";

/** Offered as one tap each. Not a "max" button: this screen never reads a balance, and a
 *  max that guesses is a max that overdraws the reserve. */
export const QUICK_AMOUNTS = ["5", "10", "100"];

/** A preset amount. Sits on the label line, so it never competes with the primary action. */
export function QuickAmount({
  value,
  active,
  onSelect,
}: {
  value: string;
  active: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "tabular rounded-full px-2.5 py-1 text-[0.6875rem] font-medium",
        "transition-colors duration-400 ease-haptic",
        active
          ? "bg-bone/[0.12] text-bone"
          : "text-bone/35 hover:bg-bone/[0.06] hover:text-bone/70",
      )}
    >
      {value}
    </button>
  );
}
