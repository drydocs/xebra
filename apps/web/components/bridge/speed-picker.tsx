import { cn } from "../ui/cn";

/**
 * Fast or Standard, where the source chain has both.
 *
 * Circle will attest a burn before its chain has finalised, for a small fee, or after, for none.
 * From Ethereum's rollups the difference is seconds against a quarter of an hour or more, so it is
 * the sender's call and both are stated with what they cost and how long they take, instead of a
 * toggle whose consequence is somewhere else on the screen.
 *
 * Two options, so both stay visible: the same radio group as the chain pickers, with a second
 * line under each name carrying the trade.
 */
export type Speed = "fast" | "standard";

export function SpeedPicker({
  value,
  onChange,
  fastDetail,
  standardDetail,
  disabled,
}: {
  value: Speed;
  onChange: (speed: Speed) => void;
  /** "Under a minute · +0.0325 USDC" */
  fastDetail: string;
  /** "15 to 20 minutes · no extra fee" */
  standardDetail: string;
  disabled?: boolean;
}) {
  const options: Array<{ id: Speed; name: string; detail: string }> = [
    { id: "fast", name: "Fast", detail: fastDetail },
    { id: "standard", name: "Standard", detail: standardDetail },
  ];

  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 grid-cols-2 gap-1 rounded-tray border-0 bg-obsidian-sunken p-1 ring-1 ring-inset ring-bone/[0.06] disabled:opacity-50"
    >
      <legend className="sr-only">Transfer speed</legend>
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <label
            key={option.id}
            className="relative block min-w-0 cursor-pointer has-[:disabled]:cursor-not-allowed"
          >
            <input
              type="radio"
              name="transfer-speed"
              value={option.id}
              checked={chosen}
              onChange={() => onChange(option.id)}
              className="peer sr-only"
            />
            <span
              className={cn(
                "block rounded-[0.875rem] px-3.5 py-2.5",
                "transition-colors duration-400 ease-haptic active:scale-[0.99]",
                "peer-focus-visible:ring-1 peer-focus-visible:ring-bone/40",
                chosen ? "bg-bone/[0.1]" : "hover:bg-bone/[0.04]",
              )}
            >
              <span
                className={cn(
                  "block text-sm font-medium tracking-[-0.01em]",
                  chosen ? "text-bone" : "text-bone/45",
                )}
              >
                {option.name}
              </span>
              <span
                className={cn(
                  "tabular mt-0.5 block text-[0.6875rem] leading-snug",
                  chosen ? "text-bone/55" : "text-bone/30",
                )}
              >
                {option.detail}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
