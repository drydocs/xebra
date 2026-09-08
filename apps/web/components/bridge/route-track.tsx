import type React from "react";
import { cn } from "../ui/cn";
import { CHAIN_NAMES, type Chain, ChainGlyph } from "./chain-glyph";

/**
 * The route, at the top of the plate.
 *
 * A bridge's first job is to answer "from where, to where" before the user reads a single
 * label, so the two chains are stated as objects with a track between them rather than as a
 * sentence. The track is a zebra stripe — the brand mark doing structural work — and it
 * crawls only while a transfer is in flight, which is the one moment the interface has
 * something to say that the copy underneath cannot.
 */
export function RouteTrack({
  from,
  to,
  fromDetail,
  toDetail,
  active,
}: {
  from: Chain;
  to: Chain;
  /** Small line under each endpoint: the connected wallet, the asset that lands. */
  fromDetail: React.ReactNode;
  toDetail: React.ReactNode;
  /** True while a burn is being signed or confirmed. */
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-4">
      <Endpoint chain={from} detail={fromDetail} />
      <div
        aria-hidden="true"
        className="relative h-3 min-w-8 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_22%,black_78%,transparent)]"
      >
        <div
          className={cn(
            "rail-stripes absolute inset-y-[5px] left-0 w-[300%] rounded-[1px]",
            active ? "animate-drift opacity-100" : "opacity-70",
          )}
        />
      </div>
      <Endpoint chain={to} detail={toDetail} align="right" />
    </div>
  );
}

function Endpoint({
  chain,
  detail,
  align = "left",
}: {
  chain: Chain;
  detail: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={cn("min-w-0", align === "right" && "text-right")}>
      <span
        className={cn(
          "flex items-center gap-2 text-sm font-medium tracking-[-0.01em] text-bone/85",
          align === "right" && "flex-row-reverse",
        )}
      >
        <ChainGlyph chain={chain} className="h-4 w-4 shrink-0 text-bone/55" />
        {CHAIN_NAMES[chain]}
      </span>
      <span className="mt-1 block truncate text-xs text-bone/35">{detail}</span>
    </div>
  );
}
