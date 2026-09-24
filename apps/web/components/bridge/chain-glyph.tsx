import { cn } from "../ui/cn";

/**
 * Chain marks, redrawn to one weight.
 *
 * Dropping each project's official logo into the route would put three different stroke
 * weights and two brand colours inside a monochrome plate. These are abstractions at the
 * same 1.4 stroke as the rest of the icon set, inheriting `currentColor` — recognisable in
 * place (Solana's slanted bars, a stellar four-point spark, Arc's nested arch) without
 * importing anyone's brand palette.
 */
export type Chain = "stellar" | "solana" | "arc";

export function ChainGlyph({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      {chain === "stellar" ? (
        <>
          <path d="M12 3.5c.6 4.4 3.5 7.3 7.9 8-4.4.7-7.3 3.6-7.9 8-.6-4.4-3.5-7.3-7.9-8 4.4-.7 7.3-3.6 7.9-8Z" />
        </>
      ) : chain === "arc" ? (
        <>
          <path d="M4 18.5a8 8 0 0 1 16 0" />
          <path d="M8.2 18.5a3.8 3.8 0 0 1 7.6 0" opacity="0.45" />
        </>
      ) : (
        <>
          <path d="M6.6 7.4h11.2l-2.6 2.6H4z" />
          <path d="M6.6 12.2h11.2L15.2 14.8H4z" />
          <path d="M6.6 17h11.2" opacity="0.45" />
        </>
      )}
    </svg>
  );
}

export const CHAIN_NAMES: Record<Chain, string> = {
  stellar: "Stellar",
  solana: "Solana",
  arc: "Arc",
};
