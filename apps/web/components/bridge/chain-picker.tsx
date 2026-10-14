import { cn } from "../ui/cn";
import { type Chain, ChainGlyph } from "./chain-glyph";

/**
 * Which chain, out of several.
 *
 * `DestinationPicker` settled the form for two: a real radio group with both options on show.
 * This is the same control for more. Up to three sit in a row as mark-and-name, as that one does.
 * Past three there is no room for names beside marks at phone width, so each becomes a small tile
 * with the mark above its name, four to a row (six on a wider screen once there are more than
 * eight), which keeps every chain visible and one press away without a dropdown to open first. People find a chain by its logo before they read a word.
 *
 * Still a radio group, for the reason given there: choosing a chain is a value for the transfer,
 * not navigation, and the browser's own arrow-key movement and announcement are the ones to have.
 *
 * Not rendered with fewer than two options: a control with one choice is just a delay.
 */
export interface ChainOption<T extends Chain> {
  id: T;
  name: string;
}

/** Written out, because Tailwind only ships a class it can read as a literal. */
const COLUMNS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-3",
  7: "grid-cols-4",
  8: "grid-cols-4",
};
/** Past eight there are rows to spare: four across on a phone, six once the plate is wide. */
const MANY_COLUMNS = "grid-cols-4 sm:grid-cols-6";

export function ChainPicker<T extends Chain>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Read to a screen reader as the group's name: "Source chain". */
  legend: string;
  /** The radio group's form name. Unique among the pickers on a screen. */
  name: string;
  options: readonly ChainOption<T>[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  if (options.length < 2) return null;
  const tiles = options.length > 3;

  return (
    <fieldset
      disabled={disabled}
      className={cn(
        "grid min-w-0 gap-1 rounded-tray border-0 bg-obsidian-sunken p-1 ring-1 ring-inset ring-bone/[0.06] disabled:opacity-50",
        COLUMNS[options.length] ?? MANY_COLUMNS,
      )}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <label
            key={option.id}
            className="relative block min-w-0 cursor-pointer has-[:disabled]:cursor-not-allowed"
          >
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={chosen}
              onChange={() => onChange(option.id)}
              className="peer sr-only"
            />
            <span
              className={cn(
                "flex items-center justify-center rounded-[0.875rem] font-medium tracking-[-0.01em]",
                "transition-colors duration-400 ease-haptic active:scale-[0.99]",
                "peer-focus-visible:ring-1 peer-focus-visible:ring-bone/40",
                tiles
                  ? "flex-col gap-1.5 px-1 py-2.5 text-[0.6875rem]"
                  : "gap-2 px-3 py-2.5 text-sm",
                chosen
                  ? "bg-bone/[0.1] text-bone"
                  : "text-bone/40 hover:bg-bone/[0.04] hover:text-bone/70",
              )}
            >
              <ChainGlyph
                chain={option.id}
                className={cn(
                  "transition-opacity duration-400 ease-haptic",
                  tiles ? "h-6 w-6" : "h-5 w-5",
                  !chosen && "opacity-60",
                )}
              />
              <span className="max-w-full truncate">{option.name}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** The eyebrow a picker sits under, matching `Field`'s label so the plate reads as one column. */
export function PickerLabel({ children }: { children: string }) {
  return (
    <span className="mb-2.5 block text-eyebrow font-medium uppercase text-bone/40">{children}</span>
  );
}
