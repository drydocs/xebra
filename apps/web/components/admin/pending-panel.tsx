"use client";

import { useEffect, useState } from "react";
import type { PendingChange } from "../../lib/admin/chain";
import { canDo, formatDuration, timelockState } from "../../lib/admin/policy";
import { bpsToField, shortAddr, stroopsToField } from "../../lib/admin/units";
import type { PanelProps } from "./context";
import { domainName } from "./domains-panel";
import { Btn, Panel } from "./primitives";

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Everything waiting out its 48 hours, with a live countdown. Anyone with the pauser key can veto
 * all of it in one call, which is the point of the delay: a stolen admin key cannot make a change
 * the pauser has time to notice and cancel.
 */
export function PendingPanel({ state, role, busy, request }: PanelProps) {
  const now = useNow();
  const rows: Array<{
    id: string;
    label: string;
    lines: string[];
    eta: bigint;
    commit: "commit_params" | "commit_domain" | null;
  }> = [];

  const add = <T,>(
    id: string,
    label: string,
    p: PendingChange<T> | null,
    lines: (v: T) => string[],
    commit: "commit_params" | "commit_domain" | null,
  ) => {
    if (p) rows.push({ id, label, lines: lines(p.value), eta: p.eta, commit });
  };
  add(
    "params",
    "Fees and limits",
    state.pendingParams,
    (p) => [
      `Fee ${bpsToField(p.feeBps)}% · min fee ${stroopsToField(p.minFee)}`,
      `Min ${stroopsToField(p.minTransfer)} · max ${stroopsToField(p.maxTransfer)} USDC`,
      `Circle allowance ${bpsToField(p.maxCctpFeeBps)}% · account fee ${stroopsToField(p.accountFee)}`,
    ],
    "commit_params",
  );
  add(
    "domain",
    "Destination",
    state.pendingDomain,
    (d) => [
      `${domainName(d.domain)} #${d.domain} · forwarding ${d.forward ? "ON" : "OFF"}`,
      `Fee cap ${stroopsToField(d.maxForwardFee)} USDC${d.accountCreation ? ` · new account ${stroopsToField(d.maxForwardFeeNewAccount)}` : ""}`,
    ],
    "commit_domain",
  );
  // Admin, pauser and fee-recipient changes are proposed from the CLI (they are rare and worth a
  // deliberate command). The panel shows them so nobody is surprised, and lets the pauser veto.
  add("admin", "New admin", state.pendingAdmin, (a) => [shortAddr(a)], null);
  add("pauser", "New pauser", state.pendingPauser, (a) => [shortAddr(a)], null);
  add("recipient", "New fee recipient", state.pendingFeeRecipient, (a) => [shortAddr(a)], null);

  return (
    <Panel
      code="04"
      title="Pending changes"
      aside={
        rows.length > 0 && canDo(role, "cancel_pending") ? (
          <Btn
            tone="danger"
            disabled={busy}
            onClick={() =>
              request({
                call: { action: "cancel_pending", caller: "" },
                title: "Veto everything pending",
                detail: ["Cancels every pending change above, in one call."],
                danger: true,
              })
            }
          >
            Veto all
          </Btn>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <p className="font-mono text-[0.75rem] uppercase tracking-[0.1em] text-bone/45">
          [ NOTHING PENDING ] — every setting above is live.
        </p>
      ) : (
        <div className="grid gap-px border border-bone/20 bg-bone/20">
          {rows.map((r) => {
            const t = timelockState(r.eta, now);
            return (
              <div
                key={r.id}
                className="grid grid-cols-1 items-center gap-3 bg-obsidian p-3 md:grid-cols-[1fr_auto_auto]"
              >
                <div className="font-mono text-[0.75rem] uppercase leading-relaxed">
                  <p className="text-bone">{r.label}</p>
                  {r.lines.map((l) => (
                    <p key={l} className="text-bone/60">
                      {l}
                    </p>
                  ))}
                </div>
                <output
                  className={`tabular font-mono text-sm uppercase ${t.ready ? "text-signal" : "text-[#f2b544]"}`}
                >
                  {t.ready ? "[ READY ]" : `T-${formatDuration(t.secondsLeft)}`}
                </output>
                {r.commit ? (
                  <Btn
                    tone="solid"
                    disabled={busy || !t.ready || !canDo(role, r.commit)}
                    onClick={() =>
                      r.commit &&
                      request({
                        call: { action: r.commit },
                        title: "Commit (goes live now)",
                        detail: [`${r.label}:`, ...r.lines],
                      })
                    }
                  >
                    Commit
                  </Btn>
                ) : (
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-bone/40">
                    CLI ONLY
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
