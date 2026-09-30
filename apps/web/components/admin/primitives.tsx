"use client";

import type React from "react";
import { cn } from "../ui/cn";

/**
 * Building blocks for the admin console: Tactical Telemetry, dark.
 *
 * Square corners, 1px seams (a grid whose gap shows the parent's colour), mono uppercase for every
 * label and figure. Red is reserved for what can hurt: pausing, removing, anything that changes
 * money. Everything else is bone on obsidian.
 */

export function Panel({
  code,
  title,
  aside,
  children,
  className,
}: {
  code: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border border-bone/20 bg-obsidian", className)}>
      <header className="flex items-center justify-between gap-4 border-b border-bone/20 px-4 py-2.5">
        <h2 className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-bone">
          <span className="text-bone/40">
            {code} {"///"}{" "}
          </span>
          {title}
        </h2>
        {aside ? (
          <div className="font-mono text-[0.6875rem] uppercase tracking-[0.1em]">{aside}</div>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Cells separated by 1px seams: the parent is the line colour, the gap is the line. */
export function Cells({ children, cols = 4 }: { children: React.ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-px border border-bone/20 bg-bone/20",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-3",
        cols === 4 && "sm:grid-cols-2 lg:grid-cols-4",
      )}
    >
      {children}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "text-bone",
  ok: "text-signal",
  warn: "text-[#f2b544]",
  danger: "text-[#ff3b30]",
};

export function Cell({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone | undefined;
}) {
  return (
    <div className="bg-obsidian p-3">
      <dt className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
        {label}
      </dt>
      <dd className={cn("tabular mt-1.5 font-mono text-lg uppercase leading-none", TONE[tone])}>
        {value}
      </dd>
      {sub ? (
        <p className="mt-1.5 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-bone/45">
          {sub}
        </p>
      ) : null}
    </div>
  );
}

export function Btn({
  children,
  tone = "neutral",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "neutral" | "danger" | "solid" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "border px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] transition-colors",
        "disabled:cursor-not-allowed disabled:border-bone/10 disabled:text-bone/25",
        tone === "neutral" && "border-bone/40 text-bone hover:bg-bone hover:text-obsidian",
        tone === "solid" &&
          "border-bone bg-bone text-obsidian hover:bg-white disabled:bg-transparent",
        tone === "danger" &&
          "border-[#ff3b30] text-[#ff3b30] hover:bg-[#ff3b30] hover:text-obsidian",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function NumField({
  label,
  unit,
  value,
  onChange,
  hint,
  disabled,
  current,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
  /** What is on chain now, shown so a change is visible as a change. */
  current?: string | undefined;
}) {
  const changed = current !== undefined && current !== value.trim();
  return (
    <label className="block bg-obsidian p-3">
      <span className="flex items-baseline justify-between gap-2 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
        <span>{label}</span>
        {current !== undefined ? <span>LIVE {current}</span> : null}
      </span>
      <span className="mt-1.5 flex items-baseline gap-2 border-b border-bone/30 focus-within:border-bone">
        <input
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "tabular w-full bg-transparent py-1 font-mono text-lg text-bone outline-none disabled:text-bone/40",
            changed && "text-[#f2b544]",
          )}
        />
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-bone/45">
          {unit}
        </span>
      </span>
      {hint ? (
        <span className="mt-1.5 block font-mono text-[0.625rem] uppercase tracking-[0.06em] text-bone/35">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Toggle({
  label,
  on,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="bg-obsidian p-3">
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className="mt-1.5 flex w-full items-center gap-3 disabled:opacity-40"
      >
        <span
          aria-hidden="true"
          className={cn("relative h-4 w-9 border", on ? "border-bone bg-bone" : "border-bone/40")}
        >
          <span
            className={cn(
              "absolute top-0 h-full w-4 transition-all",
              on ? "left-[18px] bg-obsidian" : "left-0 bg-bone/50",
            )}
          />
        </span>
        <span className="font-mono text-sm uppercase text-bone">{on ? "ON" : "OFF"}</span>
      </button>
      {hint ? (
        <span className="mt-1.5 block font-mono text-[0.625rem] uppercase tracking-[0.06em] text-bone/35">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** How a change will reach the chain, in the console's own vocabulary. */
export function KindTag({ kind }: { kind: "noop" | "tighten" | "propose" | "invalid" }) {
  const map = {
    noop: ["NO CHANGE", "border-bone/20 text-bone/40"],
    tighten: ["INSTANT · TIGHTENS", "border-signal text-signal"],
    propose: ["48H TIMELOCK · PROPOSE", "border-[#f2b544] text-[#f2b544]"],
    invalid: ["REJECTED BY CONTRACT BOUNDS", "border-[#ff3b30] text-[#ff3b30]"],
  } as const;
  const [text, cls] = map[kind];
  return (
    <span
      className={cn(
        "inline-block border px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.14em]",
        cls,
      )}
    >
      [ {text} ]
    </span>
  );
}
