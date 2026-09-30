"use client";

import { useEffect, useMemo, useState } from "react";
import { type Params, canDo, classifyParamsChange, validateParams } from "../../lib/admin/policy";
import { bpsToField, fieldToBps, fieldToStroops, stroopsToField } from "../../lib/admin/units";
import type { PanelProps } from "./context";
import { Btn, KindTag, NumField, Panel } from "./primitives";

const usdc = (s: bigint) => `${stroopsToField(s)} USDC`;

const fromParams = (p: Params) => ({
  feeBps: bpsToField(p.feeBps),
  minFee: stroopsToField(p.minFee),
  minTransfer: stroopsToField(p.minTransfer),
  maxTransfer: stroopsToField(p.maxTransfer),
  maxCctpFeeBps: bpsToField(p.maxCctpFeeBps),
  accountFee: stroopsToField(p.accountFee),
});

/**
 * Fee and limit editor.
 *
 * What the admin types is compared with what is live, and the panel says which door the change
 * takes: lowering fees or a ceiling, or raising the minimum, is `tighten_params` (instant);
 * anything that could cost a user more, or widen exposure, is `propose_params` and waits 48 hours.
 * That is the contract's rule, not the panel's, so a "raise the fee" button that did anything
 * faster would be a lie.
 */
export function FeesPanel({ state, role, busy, request }: PanelProps) {
  const live = state.params;
  const [f, setF] = useState(() => fromParams(live));
  // Follow the chain: after a commit or a tighten, the form resets to what is now live.
  useEffect(() => setF(fromParams(live)), [live]);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const parsed = useMemo(() => {
    const feeBps = fieldToBps(f.feeBps);
    const minFee = fieldToStroops(f.minFee);
    const minTransfer = fieldToStroops(f.minTransfer);
    const maxTransfer = fieldToStroops(f.maxTransfer);
    const maxCctpFeeBps = fieldToBps(f.maxCctpFeeBps);
    const accountFee = fieldToStroops(f.accountFee);
    if (
      [feeBps, minFee, minTransfer, maxTransfer, maxCctpFeeBps, accountFee].some((x) => x === null)
    ) {
      return { ok: false as const, error: "One of the fields is not a valid number." };
    }
    return validateParams({
      feeBps: feeBps as number,
      minFee: minFee as bigint,
      minTransfer: minTransfer as bigint,
      maxTransfer: maxTransfer as bigint,
      maxCctpFeeBps: maxCctpFeeBps as number,
      accountFee: accountFee as bigint,
    });
  }, [f]);

  const kind = parsed.ok ? classifyParamsChange(live, parsed.value) : "invalid";
  const action = kind === "tighten" ? "tighten_params" : "propose_params";
  const allowed = parsed.ok && kind !== "noop" && canDo(role, action);
  const pendingBlocks = kind === "propose" && state.pendingParams !== null;

  function submit() {
    if (!parsed.ok || kind === "noop" || kind === "invalid") return;
    const p = parsed.value;
    const lines = [
      `Fee ${bpsToField(live.feeBps)}% -> ${bpsToField(p.feeBps)}%`,
      `Minimum fee ${usdc(live.minFee)} -> ${usdc(p.minFee)}`,
      `Minimum transfer ${usdc(live.minTransfer)} -> ${usdc(p.minTransfer)}`,
      `Maximum transfer ${usdc(live.maxTransfer)} -> ${usdc(p.maxTransfer)}`,
      `Circle fee allowance ${bpsToField(live.maxCctpFeeBps)}% -> ${bpsToField(p.maxCctpFeeBps)}%`,
      `Account fee ${usdc(live.accountFee)} -> ${usdc(p.accountFee)}`,
    ];
    request({
      call: { action, params: p },
      title: kind === "tighten" ? "Apply now (tightening)" : "Propose (live after 48h)",
      detail:
        kind === "propose"
          ? [...lines, "Nothing changes for users until you commit it after the timelock."]
          : lines,
    });
  }

  return (
    <Panel
      code="02"
      title="Fees and limits"
      aside={<span className="text-bone/45">{parsed.ok ? "" : "INVALID"}</span>}
    >
      <div className="grid grid-cols-1 gap-px border border-bone/20 bg-bone/20 sm:grid-cols-2 lg:grid-cols-3">
        <NumField
          label="Fee"
          unit="%"
          value={f.feeBps}
          onChange={set("feeBps")}
          current={bpsToField(live.feeBps)}
          hint="Of the amount. Contract ceiling 1.00%."
          disabled={role === "viewer"}
        />
        <NumField
          label="Minimum fee"
          unit="USDC"
          value={f.minFee}
          onChange={set("minFee")}
          current={stroopsToField(live.minFee)}
          hint="Floor. Also covers Circle's delivery. Ceiling 5."
          disabled={role === "viewer"}
        />
        <NumField
          label="Account fee"
          unit="USDC"
          value={f.accountFee}
          onChange={set("accountFee")}
          current={stroopsToField(live.accountFee)}
          hint="Legacy relay path. 0 on forwarded routes. Ceiling 2."
          disabled={role === "viewer"}
        />
        <NumField
          label="Minimum transfer"
          unit="USDC"
          value={f.minTransfer}
          onChange={set("minTransfer")}
          current={stroopsToField(live.minTransfer)}
          hint="Contract floor 1."
          disabled={role === "viewer"}
        />
        <NumField
          label="Maximum transfer"
          unit="USDC"
          value={f.maxTransfer}
          onChange={set("maxTransfer")}
          current={stroopsToField(live.maxTransfer)}
          hint="Raising this is always timelocked."
          disabled={role === "viewer"}
        />
        <NumField
          label="Circle fee allowance"
          unit="%"
          value={f.maxCctpFeeBps}
          onChange={set("maxCctpFeeBps")}
          current={bpsToField(live.maxCctpFeeBps)}
          hint="Ceiling 0.50%."
          disabled={role === "viewer"}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <KindTag kind={kind} />
        <Btn tone="solid" disabled={busy || !allowed || pendingBlocks} onClick={submit}>
          {kind === "tighten" ? "Apply now" : "Propose change"}
        </Btn>
        <Btn disabled={busy} onClick={() => setF(fromParams(live))}>
          Reset
        </Btn>
      </div>
      {!parsed.ok ? (
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[#ff3b30]">
          {parsed.error}
        </p>
      ) : null}
      {pendingBlocks ? (
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[#f2b544]">
          A fee change is already pending. Commit or cancel it first (panel 04); proposing again
          would replace it and restart the 48 hour clock.
        </p>
      ) : null}
      {role !== "viewer" && parsed.ok && kind !== "noop" && !allowed ? (
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-bone/50">
          The pauser key cannot change fees. Connect the admin wallet.
        </p>
      ) : null}
    </Panel>
  );
}
