"use client";

import type { Rent } from "../../lib/admin/chain";
import { formatDuration, ledgersToSeconds, rentLevel } from "../../lib/admin/policy";
import { Cell, Cells, type Tone } from "./primitives";
import { Panel } from "./primitives";

const TONE: Record<string, Tone> = { ok: "ok", soon: "warn", urgent: "danger" };

function toneOf(secs: number | null): Tone {
  return secs === null ? "neutral" : (TONE[rentLevel(secs)] ?? "neutral");
}

function left(latest: number, until: number | null) {
  if (until === null) return null;
  return ledgersToSeconds(Math.max(0, until - latest));
}

function When({ secs }: { secs: number | null }) {
  if (secs === null) return "UNKNOWN";
  return secs <= 0 ? "ARCHIVED" : formatDuration(secs);
}

/**
 * Soroban rent. State and code expire unless someone pays to extend them; anyone can. Lapsed
 * entries are archived and restorable, not lost, but a restore costs money and stops transfers in
 * the meantime, so the console shows the countdown instead of waiting for a failure.
 */
export function RentPanel({
  current,
  legacy,
  wasmHash,
}: {
  current: Rent;
  legacy: Rent | null;
  wasmHash: string | null;
}) {
  const rows = [
    { name: "WRAPPER V2", r: current },
    ...(legacy ? [{ name: "WRAPPER V1 (RETIRED)", r: legacy }] : []),
  ];
  return (
    <Panel code="06" title="Contract rent">
      <div className="space-y-4">
        {rows.map(({ name, r }) => {
          const code = left(r.latestLedger, r.codeLiveUntil);
          const state = left(r.latestLedger, r.instanceLiveUntil);
          const worst = Math.min(
            code ?? Number.POSITIVE_INFINITY,
            state ?? Number.POSITIVE_INFINITY,
          );
          const tone = TONE[rentLevel(worst)] ?? "neutral";
          return (
            <div key={r.contractId}>
              <p className="mb-2 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
                {name} · {r.contractId.slice(0, 8)}…{r.contractId.slice(-6)}
              </p>
              <Cells cols={2}>
                <Cell
                  label="Code lifetime"
                  value={<When secs={code} />}
                  tone={toneOf(code)}
                  sub="Runs out first"
                />
                <Cell
                  label="State lifetime"
                  value={<When secs={state} />}
                  tone={toneOf(state)}
                  sub="Bumped by every admin call"
                />
              </Cells>
              {tone !== "ok" && r.wasmHash ? (
                <pre className="mt-2 overflow-x-auto border border-bone/20 bg-obsidian-sunken p-3 font-mono text-[0.6875rem] leading-relaxed text-bone/70">
                  {`stellar contract extend --wasm-hash ${r.wasmHash} \\\n  --ledgers-to-extend 1555200 --durability persistent \\\n  --source-account xebra-deployer --network mainnet`}
                </pre>
              ) : null}
            </div>
          );
        })}
        {wasmHash ? (
          <p className="break-all font-mono text-[0.625rem] uppercase tracking-[0.06em] text-bone/35">
            WASM {wasmHash}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
