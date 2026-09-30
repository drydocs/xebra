"use client";

import { type Connection, FAMILIES, FAMILY_LABEL, type Family } from "../../lib/wallets/types";
import { XebraWordmark } from "../brand/xebra-mark";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";

/**
 * A floating glass pill, detached from the top edge.
 *
 * Not a full-bleed bar glued to the viewport: the plate below it is the product, and a bar
 * that spans the window competes with it for the role of "the object on screen". Detached
 * and inset, the nav reads as a control that belongs to the page rather than to the browser.
 *
 * The wallet lives here, not in the plate, because connecting is not a step of a transfer —
 * it is a property of the session. Putting it inside the card made the first field of a
 * money form be "which wallet", which is the wrong first question.
 */
export function TopBar({
  connections,
  walletReady,
  network,
  onConnect,
}: {
  connections: Partial<Record<Family, Connection>>;
  walletReady: boolean;
  network: string;
  onConnect: () => void;
}) {
  const connected = FAMILIES.map((f) => connections[f]).filter((c): c is Connection => Boolean(c));
  return (
    <header className="sticky top-4 z-30 mx-auto w-full max-w-xl px-1 sm:top-6">
      <nav
        className={cn(
          "flex items-center justify-between gap-3 rounded-full py-2 pl-4 pr-2",
          "bg-obsidian-raised/70 ring-1 ring-inset ring-bone/10 backdrop-blur-2xl",
          "shadow-[0_1px_0_0_hsl(var(--bone)/0.07)_inset,0_16px_40px_-24px_hsl(228_40%_2%/0.9)]",
        )}
      >
        <div className="flex items-center gap-3">
          <XebraWordmark />
          <Badge tone="neutral" dot pulse className="hidden sm:inline-flex">
            {network}
          </Badge>
        </div>

        {connected.length > 0 ? (
          <button
            type="button"
            onClick={onConnect}
            aria-label="Manage connected wallets"
            className="flex items-center gap-1.5"
          >
            {connected.map((c) => (
              <span
                key={c.family}
                title={`${FAMILY_LABEL[c.family]} · ${c.walletName} · ${c.address}`}
                className={cn(
                  "tabular flex items-center gap-2 rounded-full py-1.5 pl-3 pr-3.5 font-mono text-xs",
                  "bg-bone/[0.06] text-bone/75 ring-1 ring-inset ring-bone/10",
                )}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-signal" />
                <span className="sr-only">Connected {FAMILY_LABEL[c.family]} wallet </span>
                {c.address.slice(0, 4)}…{c.address.slice(-4)}
              </span>
            ))}
          </button>
        ) : (
          <Button variant="secondary" size="sm" disabled={!walletReady} onClick={onConnect}>
            {walletReady ? "Connect" : "Loading"}
          </Button>
        )}
      </nav>
    </header>
  );
}
