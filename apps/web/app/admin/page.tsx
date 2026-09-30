"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeRequest } from "../../components/admin/context";
import { ControlsPanel } from "../../components/admin/controls-panel";
import { DomainsPanel } from "../../components/admin/domains-panel";
import { FeesPanel } from "../../components/admin/fees-panel";
import { PendingPanel } from "../../components/admin/pending-panel";
import { Btn, Cell, Cells, Panel } from "../../components/admin/primitives";
import { RentPanel } from "../../components/admin/rent-panel";
import { useWallets } from "../../components/wallet/wallet-provider";
import {
  type AdminCall,
  type Rent,
  type WrapperState,
  readRent,
  readWrapperState,
  sendAdminCall,
} from "../../lib/admin/chain";
import { humanizeAdminError } from "../../lib/admin/errors";
import { formatDuration, ledgersToSeconds, rentLevel, roleOf } from "../../lib/admin/policy";
import { shortAddr, stroopsToField } from "../../lib/admin/units";
import type { BridgeChainConfig } from "../../lib/cctp-bridge";
import { env } from "../../lib/env";
import { formatError } from "../../lib/format-error";

const REFRESH_MS = 30_000;

const CONFIG: BridgeChainConfig = {
  horizonUrl: env.horizonUrl,
  wrapperContractId: env.cctpWrapperContractId,
  cctpTokenMessengerId: env.cctpTokenMessengerId,
  usdcSacAddress: env.usdcSacAddress,
  sorobanRpcUrl: env.sorobanRpcUrl,
  networkPassphrase: env.stellarNetworkPassphrase,
  destinationDomain: env.destinationDomain,
};

/** The panel does not know the signer until the change is confirmed, so requests carry a blank. */
function withCaller(call: AdminCall, signer: string): AdminCall {
  return "caller" in call ? { ...call, caller: signer } : call;
}

export default function AdminPage() {
  const contractId = env.cctpWrapperContractId;
  const { connections, stellarKit: kit, open } = useWallets();
  const address = connections.stellar?.address ?? null;
  const [state, setState] = useState<WrapperState | null>(null);
  const [legacy, setLegacy] = useState<Rent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [req, setReq] = useState<ChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!contractId) return;
    try {
      setState(await readWrapperState(CONFIG, contractId));
      if (env.legacyWrapperContractId) {
        setLegacy(await readRent(CONFIG, env.legacyWrapperContractId).catch(() => null));
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(formatError(err));
    }
  }, [contractId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const connect = useCallback(() => open(["stellar"]), [open]);

  const role = state ? roleOf(address, state.admin, state.pauser) : "viewer";

  async function confirm() {
    if (!req || !kit || !address || !contractId) return;
    setBusy(true);
    setResult(null);
    try {
      const { txHash } = await sendAdminCall(
        kit,
        CONFIG,
        contractId,
        address,
        withCaller(req.call, address),
      );
      setResult({ ok: true, text: `Confirmed. ${txHash}` });
      setReq(null);
      await refresh();
    } catch (err) {
      setResult({ ok: false, text: humanizeAdminError(formatError(err)) });
    } finally {
      setBusy(false);
    }
  }

  const request = useCallback((r: ChangeRequest) => {
    setResult(null);
    setReq(r);
  }, []);

  const panelProps = useMemo(
    () =>
      state
        ? {
            state,
            role,
            busy,
            signer: address,
            request,
          }
        : null,
    [state, role, busy, address, request],
  );

  const rent: Rent | null = state
    ? {
        contractId: state.contractId,
        instanceLiveUntil: state.instanceLiveUntil,
        codeLiveUntil: state.codeLiveUntil,
        latestLedger: state.latestLedger,
        wasmHash: state.wasmHash,
      }
    : null;
  const codeSecs = rent?.codeLiveUntil
    ? ledgersToSeconds(rent.codeLiveUntil - rent.latestLedger)
    : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-obsidian text-bone">
      <div className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6">
        <header className="border-b-2 border-bone pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-bone/60">
            <span>[ XEBRA® / CONTROL ] REV 2.0</span>
            <span className="flex items-center gap-3">
              <span>{env.network}</span>
              <span className="border border-bone/30 px-2 py-1 text-bone">
                ROLE: {address ? role : "NO WALLET"}
              </span>
              {address ? (
                <span title={address}>{shortAddr(address)}</span>
              ) : (
                <Btn tone="solid" disabled={!kit} onClick={connect}>
                  {kit ? "Connect wallet" : "Loading"}
                </Btn>
              )}
            </span>
          </div>
          <h1 className="mt-4 font-sans text-[clamp(2.5rem,9vw,6.5rem)] font-black uppercase leading-[0.88] tracking-[-0.05em]">
            Wrapper
            <br />
            Control
          </h1>
        </header>

        {!contractId ? (
          <p className="mt-8 font-mono text-sm uppercase text-[#ff3b30]">
            [ NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID IS NOT SET IN THIS BUILD ]
          </p>
        ) : null}
        {loadError ? (
          <p className="mt-8 font-mono text-sm uppercase text-[#ff3b30]">
            [ READ FAILED ] {loadError}
          </p>
        ) : null}

        {state && panelProps && rent ? (
          <div className="mt-6 space-y-6">
            <Panel
              code="01"
              title="Status"
              aside={<span className="text-bone/45">POLLS EVERY 30S</span>}
            >
              <Cells>
                <Cell
                  label="Bridging"
                  value={state.paused ? "PAUSED" : "LIVE"}
                  tone={state.paused ? "danger" : "ok"}
                />
                <Cell
                  label="Accrued fees"
                  value={`${stroopsToField(state.accruedFees)}`}
                  sub="USDC in contract"
                />
                <Cell
                  label="Code rent"
                  value={codeSecs === null ? "UNKNOWN" : formatDuration(codeSecs)}
                  tone={
                    codeSecs === null
                      ? "neutral"
                      : rentLevel(codeSecs) === "ok"
                        ? "ok"
                        : rentLevel(codeSecs) === "soon"
                          ? "warn"
                          : "danger"
                  }
                  sub="Until archive"
                />
                <Cell
                  label="Destinations"
                  value={String(state.domains.filter((d) => d.forward).length)}
                  sub={`${state.domains.length} configured`}
                />
              </Cells>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone/50 sm:grid-cols-2">
                <div>
                  CONTRACT <span className="text-bone/80">{state.contractId}</span>
                </div>
                <div>
                  ADMIN <span className="text-bone/80">{shortAddr(state.admin)}</span>
                </div>
                <div>
                  PAUSER <span className="text-bone/80">{shortAddr(state.pauser)}</span>
                </div>
                <div>
                  FEE RECIPIENT{" "}
                  <span className="text-bone/80">{shortAddr(state.feeRecipient)}</span>
                </div>
              </dl>
              {address && role === "viewer" ? (
                <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[#f2b544]">
                  [ READ-ONLY ] {shortAddr(address)} is neither the admin nor the pauser. Controls
                  are disabled; the contract would refuse them anyway.
                </p>
              ) : null}
              {!address ? (
                <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-bone/50">
                  Connect the admin or pauser wallet to make changes.
                </p>
              ) : null}
            </Panel>

            <FeesPanel {...panelProps} />
            <DomainsPanel {...panelProps} />
            <PendingPanel {...panelProps} />
            <ControlsPanel {...panelProps} />
            <RentPanel current={rent} legacy={legacy} wasmHash={state.wasmHash} />
          </div>
        ) : !loadError && contractId ? (
          <p className="mt-8 font-mono text-sm uppercase text-bone/50">[ READING CHAIN… ]</p>
        ) : null}

        {result ? (
          <output
            className={`mt-6 block break-all border p-3 font-mono text-[0.75rem] uppercase ${result.ok ? "border-signal text-signal" : "border-[#ff3b30] text-[#ff3b30]"}`}
          >
            {result.ok ? "[ OK ] " : "[ FAILED ] "}
            {result.text}
          </output>
        ) : null}
      </div>

      {req ? (
        <dialog
          open
          aria-label="Confirm change"
          className="fixed inset-0 z-[60] m-0 flex h-full w-full max-w-none items-end justify-center bg-obsidian/80 p-4 text-bone sm:items-center"
        >
          <div
            className={`w-full max-w-lg border-2 bg-obsidian ${req.danger ? "border-[#ff3b30]" : "border-bone"}`}
          >
            <div className="border-b border-bone/30 px-4 py-2.5 font-mono text-[0.6875rem] uppercase tracking-[0.14em]">
              [ CONFIRM ] {req.title}
            </div>
            <ul className="space-y-1 p-4 font-mono text-[0.75rem] uppercase leading-relaxed text-bone/80">
              {req.detail.map((d) => (
                <li key={d}>&gt;&gt;&gt; {d}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-3 border-t border-bone/30 p-3">
              <Btn disabled={busy} onClick={() => setReq(null)}>
                Cancel
              </Btn>
              <Btn
                tone={req.danger ? "danger" : "solid"}
                disabled={busy || !address}
                onClick={confirm}
              >
                {busy ? "Waiting for wallet…" : "Sign and send"}
              </Btn>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
