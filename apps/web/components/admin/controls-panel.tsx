"use client";

import { useState } from "react";
import { canDo } from "../../lib/admin/policy";
import { fieldToStroops, stroopsToField } from "../../lib/admin/units";
import type { PanelProps } from "./context";
import { Btn, Panel } from "./primitives";

/** The two levers that are not settings: stop everything, and take the fees. */
export function ControlsPanel({ state, role, busy, request }: PanelProps) {
  const [amount, setAmount] = useState("");
  const parsed = fieldToStroops(amount);
  const accrued = state.accruedFees;
  const okAmount = parsed !== null && parsed > 0n && parsed <= accrued;

  return (
    <Panel code="05" title="Controls">
      <div className="grid grid-cols-1 gap-px border border-bone/20 bg-bone/20 md:grid-cols-2">
        <div className="bg-obsidian p-3">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
            Kill switch
          </p>
          <p className="mt-1.5 font-mono text-[0.6875rem] uppercase leading-relaxed tracking-[0.06em] text-bone/60">
            {state.paused
              ? "Bridging is stopped. New transfers are refused by the contract."
              : "Stops every new transfer at once. Funds in flight are unaffected. Admin or pauser."}
          </p>
          <div className="mt-3">
            {state.paused ? (
              <Btn
                tone="solid"
                disabled={busy || !canDo(role, "unpause")}
                onClick={() =>
                  request({
                    call: { action: "unpause" },
                    title: "Resume bridging",
                    detail: ["New transfers will be accepted again."],
                  })
                }
              >
                Unpause
              </Btn>
            ) : (
              <Btn
                tone="danger"
                disabled={busy || !canDo(role, "pause")}
                onClick={() =>
                  request({
                    call: { action: "pause", caller: "" },
                    title: "Pause the wrapper",
                    detail: ["Every new transfer is refused until an admin unpauses."],
                    danger: true,
                  })
                }
              >
                Pause bridging
              </Btn>
            )}
          </div>
        </div>

        <div className="bg-obsidian p-3">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
            Withdraw fees
          </p>
          <p className="mt-1.5 font-mono text-[0.6875rem] uppercase leading-relaxed tracking-[0.06em] text-bone/60">
            Accrued in the contract:{" "}
            <span className="tabular text-bone">{stroopsToField(accrued)} USDC</span>. Paid to the
            fee recipient, not to the signer. Admin only.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              aria-label="Amount to withdraw"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular w-28 border-b border-bone/30 bg-transparent py-1 font-mono text-base text-bone outline-none focus:border-bone"
            />
            <Btn onClick={() => setAmount(stroopsToField(accrued))} disabled={accrued === 0n}>
              Max
            </Btn>
            <Btn
              tone="solid"
              disabled={busy || !okAmount || !canDo(role, "withdraw_fees")}
              onClick={() =>
                parsed !== null &&
                request({
                  call: { action: "withdraw_fees", amount: parsed },
                  title: "Withdraw fees",
                  detail: [`${stroopsToField(parsed)} USDC to ${state.feeRecipient}`],
                })
              }
            >
              Withdraw
            </Btn>
          </div>
        </div>
      </div>
    </Panel>
  );
}
