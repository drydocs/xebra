/**
 * What the wrapper lets an admin do, mirrored client-side so the panel refuses a bad change
 * before anyone signs.
 *
 * The contract is the authority. Every bound below is copied from
 * `contracts/stellar-cctp-wrapper-v2/src/lib.rs` (`validate_params`, `validate_domain_cfg`,
 * `tighten_params`, `tighten_domain`), and `policy.test.ts` pins the values, so a contract change
 * that forgets this file fails a test instead of a mainnet transaction. A mismatch here can only
 * make the panel stricter or looser than the chain, never let a change through: the chain
 * re-validates everything.
 *
 * Amounts are stroops (7 decimals), like the contract.
 */

export const STROOPS_PER_USDC = 10_000_000n;
export const TIMELOCK_SECS = 172_800; // 48h

export const BOUNDS = {
  maxFeeBps: 100, // 1.00%
  maxMinFee: 5n * STROOPS_PER_USDC,
  minTransferFloor: 1n * STROOPS_PER_USDC,
  maxTransferCeiling: 100_000_000_000_000n,
  maxCctpFeeBps: 50, // 0.50%
  maxAccountFee: 2n * STROOPS_PER_USDC,
  maxForwardFee: 2n * STROOPS_PER_USDC,
} as const;

export interface Params {
  feeBps: number;
  minFee: bigint;
  minTransfer: bigint;
  maxTransfer: bigint;
  maxCctpFeeBps: number;
  accountFee: bigint;
}

export interface DomainCfg {
  domain: number;
  evmStyle: boolean;
  forward: boolean;
  maxForwardFee: bigint;
  accountCreation: boolean;
  maxForwardFeeNewAccount: bigint;
}

/** Circle's own domain ids, needed to refuse the two the wrapper must never take. */
export const DOMAIN_STELLAR = 27;

/** How a change reaches the chain. `tighten` is instant and reduces exposure; `propose` waits 48h. */
export type ChangeKind = "noop" | "tighten" | "propose";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function validateParams(p: Params): Checked<Params> {
  if (!Number.isInteger(p.feeBps) || p.feeBps < 0)
    return fail("Fee must be a whole number of bps.");
  if (p.feeBps > BOUNDS.maxFeeBps) return fail("Fee is capped at 1.00% (100 bps) in the contract.");
  if (p.minFee < 0n) return fail("Minimum fee cannot be negative.");
  if (p.minFee > BOUNDS.maxMinFee) return fail("Minimum fee is capped at 5 USDC in the contract.");
  if (p.minTransfer < BOUNDS.minTransferFloor) {
    return fail("Minimum transfer cannot go below 1 USDC (contract floor).");
  }
  if (p.maxTransfer > BOUNDS.maxTransferCeiling) {
    return fail("Maximum transfer is above the contract's hard ceiling.");
  }
  if (p.minTransfer >= p.maxTransfer)
    return fail("Minimum transfer must be below maximum transfer.");
  if (!Number.isInteger(p.maxCctpFeeBps) || p.maxCctpFeeBps < 0) {
    return fail("Circle fee allowance must be a whole number of bps.");
  }
  if (p.maxCctpFeeBps > BOUNDS.maxCctpFeeBps) {
    return fail("Circle fee allowance is capped at 0.50% (50 bps) in the contract.");
  }
  if (p.accountFee < 0n) return fail("Account fee cannot be negative.");
  if (p.accountFee > BOUNDS.maxAccountFee)
    return fail("Account fee is capped at 2 USDC in the contract.");
  return { ok: true, value: p };
}

const paramsEqual = (a: Params, b: Params) =>
  a.feeBps === b.feeBps &&
  a.minFee === b.minFee &&
  a.minTransfer === b.minTransfer &&
  a.maxTransfer === b.maxTransfer &&
  a.maxCctpFeeBps === b.maxCctpFeeBps &&
  a.accountFee === b.accountFee;

/**
 * Whether `next` can be applied instantly (`tighten_params`) or must wait 48h (`propose_params`).
 * Mirrors the contract's own test: every fee and ceiling no higher, the minimum transfer no lower.
 * Anything else, including a mix of loosening and tightening, is a proposal.
 */
export function classifyParamsChange(current: Params, next: Params): ChangeKind {
  if (paramsEqual(current, next)) return "noop";
  const tighter =
    next.feeBps <= current.feeBps &&
    next.minFee <= current.minFee &&
    next.maxTransfer <= current.maxTransfer &&
    next.maxCctpFeeBps <= current.maxCctpFeeBps &&
    next.accountFee <= current.accountFee &&
    next.minTransfer >= current.minTransfer;
  return tighter ? "tighten" : "propose";
}

export function validateDomainCfg(cfg: DomainCfg): Checked<DomainCfg> {
  if (!Number.isInteger(cfg.domain) || cfg.domain < 0)
    return fail("Domain must be a whole number.");
  if (cfg.domain === DOMAIN_STELLAR)
    return fail("Stellar is the source domain and cannot be a destination.");
  if (cfg.maxForwardFee < 0n || cfg.maxForwardFee > BOUNDS.maxForwardFee) {
    return fail("Forward fee cap must be between 0 and 2 USDC.");
  }
  if (cfg.forward && cfg.maxForwardFee === 0n) {
    return fail("Forwarding needs a fee cap above zero, or no transfer could ever be delivered.");
  }
  if (cfg.maxForwardFeeNewAccount < 0n || cfg.maxForwardFeeNewAccount > BOUNDS.maxForwardFee) {
    return fail("New-account fee cap must be between 0 and 2 USDC.");
  }
  if (cfg.accountCreation) {
    if (!cfg.forward)
      return fail("Account creation rides on forwarding, so forwarding must be on.");
    if (cfg.evmStyle)
      return fail("Account creation is a Solana-style feature; EVM domains do not use it.");
    if (cfg.maxForwardFeeNewAccount === 0n) {
      return fail("Account creation needs its own fee cap above zero.");
    }
  } else if (cfg.maxForwardFeeNewAccount !== 0n) {
    return fail("The new-account cap must be zero while account creation is off.");
  }
  return { ok: true, value: cfg };
}

const domainEqual = (a: DomainCfg, b: DomainCfg) =>
  a.domain === b.domain &&
  a.evmStyle === b.evmStyle &&
  a.forward === b.forward &&
  a.maxForwardFee === b.maxForwardFee &&
  a.accountCreation === b.accountCreation &&
  a.maxForwardFeeNewAccount === b.maxForwardFeeNewAccount;

/**
 * Instant (`tighten_domain`) or 48h (`propose_domain`)? `tighten_domain` normalises "forward off"
 * to "creation off, no new-account cap", so the comparison does too: turning forwarding off is one
 * instant call whatever the other fields say.
 *
 * `current` is null for a domain the wrapper does not have yet; adding one is always a proposal.
 */
export function classifyDomainChange(current: DomainCfg | null, next: DomainCfg): ChangeKind {
  if (!current) return "propose";
  if (domainEqual(current, next)) return "noop";
  if (current.evmStyle !== next.evmStyle) return "propose";
  const creation = next.accountCreation && next.forward;
  const newCap = creation ? next.maxForwardFeeNewAccount : 0n;
  const tighter =
    !(next.forward && !current.forward) &&
    next.maxForwardFee <= current.maxForwardFee &&
    !(creation && !current.accountCreation) &&
    newCap <= current.maxForwardFeeNewAccount;
  if (!tighter) return "propose";
  // The instant path would produce the normalised config; if that is what is already on chain
  // the call is a no-op and the contract refuses it.
  const normalised: DomainCfg = {
    ...next,
    accountCreation: creation,
    maxForwardFeeNewAccount: newCap,
  };
  return domainEqual(current, normalised) ? "noop" : "tighten";
}

/** Who may sign what. The chain enforces it; the panel uses it to say which buttons can work. */
export type Role = "admin" | "pauser" | "viewer";

export function roleOf(address: string | null, admin: string, pauser: string): Role {
  if (address === admin) return "admin";
  if (address === pauser) return "pauser";
  return "viewer";
}

export type Action =
  | "pause"
  | "unpause"
  | "tighten_params"
  | "propose_params"
  | "commit_params"
  | "tighten_domain"
  | "propose_domain"
  | "commit_domain"
  | "remove_domain"
  | "cancel_pending"
  | "withdraw_fees";

/** Pauser can only pull levers that reduce exposure; everything else is the admin's. */
const PAUSER_ACTIONS: ReadonlySet<Action> = new Set([
  "pause",
  "tighten_domain",
  "remove_domain",
  "cancel_pending",
]);

export function canDo(role: Role, action: Action): boolean {
  if (role === "admin") return true;
  if (role === "pauser") return PAUSER_ACTIONS.has(action);
  return false;
}

/** A pending change, and whether its timelock has run out. */
export function timelockState(
  eta: bigint,
  nowSecs: number,
): { ready: boolean; secondsLeft: number } {
  const left = Number(eta) - nowSecs;
  return { ready: left <= 0, secondsLeft: Math.max(0, left) };
}

/** "1d 4h", "3h 12m", "45s" — for countdowns. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Stellar closes a ledger about every 5 seconds. Good enough for a rent countdown. */
export const SECONDS_PER_LEDGER = 5;

export function ledgersToSeconds(ledgers: number): number {
  return ledgers * SECONDS_PER_LEDGER;
}

export type RentLevel = "ok" | "soon" | "urgent";

/** Green above 60 days, amber above 21, red below. Archival is recoverable but costs a restore. */
export function rentLevel(secondsLeft: number): RentLevel {
  const days = secondsLeft / 86_400;
  if (days > 60) return "ok";
  if (days > 21) return "soon";
  return "urgent";
}
