import { cn } from "../ui/cn";

/**
 * Each chain's own mark, as the chain publishes it.
 *
 * These used to be redrawn abstractions in a single stroke weight, to keep the monochrome plate
 * monochrome. People do not recognise an abstraction of a chain; they recognise its logo, and on a
 * screen that moves money the recognition is worth more than the palette. Each mark sits in a round
 * (Arc: rounded-square, as its icon is drawn) tile so three different backgrounds read as three
 * badges instead of three stray rectangles.
 *
 * Files are 96px PNGs in /public/chains, sized for a 24px slot at 2x. Sources: Solana and Stellar
 * from the Trust Wallet assets repository, Arc from arc.network's own site icon.
 */
export type Chain = "stellar" | "solana" | "arc";

const SRC: Record<Chain, string> = {
  stellar: "/chains/stellar.png",
  solana: "/chains/solana.png",
  arc: "/chains/arc.png",
};

export function ChainGlyph({ chain, className }: { chain: Chain; className?: string }) {
  return (
    <img
      src={SRC[chain]}
      alt=""
      width={24}
      height={24}
      aria-hidden="true"
      draggable={false}
      className={cn(
        "h-5 w-5 shrink-0 select-none object-cover",
        chain === "arc" ? "rounded-[22%]" : "rounded-full",
        className,
      )}
    />
  );
}

export const CHAIN_NAMES: Record<Chain, string> = {
  stellar: "Stellar",
  solana: "Solana",
  arc: "Arc",
};
