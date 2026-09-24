import type { Destination, DestinationId } from "../../lib/destinations";
import { cn } from "../ui/cn";
import { ChainGlyph } from "./chain-glyph";

/**
 * Which chain the dollars land on.
 *
 * Two options do not need a dropdown: both stay visible, the choice is one press, and the route
 * plate above already shows the result. It is a real radio group, not a tab strip — choosing one
 * is a value for the transfer, not navigation — so the browser gives it arrow-key movement and
 * announces it as one, with nothing here to get subtly wrong.
 *
 * Not rendered at all with a single destination: a control with one choice is just a delay.
 */
export function DestinationPicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Destination[];
  value: DestinationId;
  onChange: (id: DestinationId) => void;
  disabled?: boolean;
}) {
  if (options.length < 2) return null;

  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 grid-cols-2 gap-1 rounded-tray border-0 bg-obsidian-sunken p-1 ring-1 ring-inset ring-bone/[0.06] disabled:opacity-50"
    >
      <legend className="sr-only">Destination chain</legend>
      {options.map((option) => (
        <label
          key={option.id}
          className="relative block cursor-pointer has-[:disabled]:cursor-not-allowed"
        >
          <input
            type="radio"
            name="destination-chain"
            value={option.id}
            checked={option.id === value}
            onChange={() => onChange(option.id)}
            className="peer sr-only"
          />
          <span
            className={cn(
              "flex items-center justify-center gap-2 rounded-[0.875rem] px-3 py-2.5 text-sm font-medium tracking-[-0.01em]",
              "transition-colors duration-400 ease-haptic active:scale-[0.99]",
              "peer-focus-visible:ring-1 peer-focus-visible:ring-bone/40",
              option.id === value
                ? "bg-bone/[0.1] text-bone"
                : "text-bone/40 hover:bg-bone/[0.04] hover:text-bone/70",
            )}
          >
            <ChainGlyph chain={option.id} className="h-4 w-4 shrink-0" />
            {option.name}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
