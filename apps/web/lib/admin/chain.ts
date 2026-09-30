import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import {
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { type BridgeChainConfig, submitSigned, waitForTx } from "../cctp-bridge";
import { formatError } from "../format-error";
import { humanizeAdminError } from "./errors";
import type { Action, DomainCfg, Params } from "./policy";

/**
 * Reading and writing the v2 wrapper for the admin panel.
 *
 * # Reads come straight from instance storage
 *
 * The contract has no getter for a pending change, and simulating five `get_*` calls needs a funded
 * source account that a signed-out viewer does not have. Everything the panel shows lives in the
 * contract's instance entry (that is by design: "all state is instance storage"), and
 * `getLedgerEntries` reads it in one call with no account, and returns the entry's TTL with it. The
 * code entry's TTL comes in the same call, which is what the rent countdown needs.
 *
 * # Writes are ordinary signed invocations
 *
 * Nothing here holds a key. The connected wallet signs; the contract checks `require_auth` against
 * the stored admin or pauser, so the panel's own role check only decides which buttons to show.
 */

export interface PendingChange<T> {
  value: T;
  /** Unix seconds after which it may be committed. */
  eta: bigint;
}

export interface WrapperState {
  contractId: string;
  admin: string;
  pauser: string;
  feeRecipient: string;
  paused: boolean;
  accruedFees: bigint;
  params: Params;
  domains: DomainCfg[];
  pendingParams: PendingChange<Params> | null;
  pendingDomain: PendingChange<DomainCfg> | null;
  pendingAdmin: PendingChange<string> | null;
  pendingPauser: PendingChange<string> | null;
  pendingFeeRecipient: PendingChange<string> | null;
  /** Ledger the instance entry (state) and the code entry live until. */
  instanceLiveUntil: number;
  codeLiveUntil: number | null;
  latestLedger: number;
  wasmHash: string | null;
}

type Native = Record<string, unknown>;

const asBig = (v: unknown) => BigInt(v as string | number | bigint);

export function decodeParams(n: Native): Params {
  return {
    feeBps: Number(n.fee_bps),
    minFee: asBig(n.min_fee),
    minTransfer: asBig(n.min_transfer),
    maxTransfer: asBig(n.max_transfer),
    maxCctpFeeBps: Number(n.max_cctp_fee_bps),
    accountFee: asBig(n.account_fee),
  };
}

export function decodeDomain(n: Native): DomainCfg {
  return {
    domain: Number(n.domain),
    evmStyle: Boolean(n.evm_style),
    forward: Boolean(n.forward),
    maxForwardFee: asBig(n.max_forward_fee),
    accountCreation: Boolean(n.account_creation),
    maxForwardFeeNewAccount: asBig(n.max_forward_fee_new_account),
  };
}

/** `Map<u32, DomainCfg>` decodes to a Map or a plain object depending on the SDK path; take both. */
function domainValues(raw: unknown): Native[] {
  if (raw instanceof Map) return [...raw.values()] as Native[];
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, Native>);
  return [];
}

/** Pure: turns the instance storage entries (already decoded to native) into `WrapperState` fields. */
export function decodeInstanceStorage(
  entries: Array<{ key: string; value: unknown }>,
): Omit<
  WrapperState,
  "contractId" | "instanceLiveUntil" | "codeLiveUntil" | "latestLedger" | "wasmHash"
> {
  const byKey = new Map(entries.map((e) => [e.key, e.value]));
  const need = (k: string) => {
    const v = byKey.get(k);
    if (v === undefined) throw new Error(`Contract storage has no ${k}; is this the v2 wrapper?`);
    return v;
  };
  const pending = <T>(k: string, pick: (n: Native) => T): PendingChange<T> | null => {
    const v = byKey.get(k) as Native | undefined;
    return v ? { value: pick(v), eta: asBig(v.eta) } : null;
  };
  return {
    admin: String(need("Admin")),
    pauser: String(need("Pauser")),
    feeRecipient: String(need("FeeRecipient")),
    paused: Boolean(byKey.get("Paused") ?? false),
    accruedFees: asBig(byKey.get("AccruedFees") ?? 0n),
    params: decodeParams(need("Params") as Native),
    domains: domainValues(byKey.get("Domains"))
      .map(decodeDomain)
      .sort((a, b) => a.domain - b.domain),
    pendingParams: pending("PendingParams", (n) => decodeParams(n.params as Native)),
    pendingDomain: pending("PendingDomain", (n) => decodeDomain(n.cfg as Native)),
    pendingAdmin: pending("PendingAdmin", (n) => String(n.addr)),
    pendingPauser: pending("PendingPauser", (n) => String(n.addr)),
    pendingFeeRecipient: pending("PendingRecipient", (n) => String(n.addr)),
  };
}

async function readInstanceEntry(server: rpc.Server, contractId: string) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await server.getLedgerEntries(key);
  const entry = res.entries[0];
  if (!entry) throw new Error(`Contract ${contractId} was not found on chain (archived?).`);
  return {
    entry,
    instance: entry.val.contractData().val().instance(),
    latestLedger: res.latestLedger,
  };
}

async function readCodeLiveUntil(server: rpc.Server, instance: xdr.ScContractInstance) {
  const exec = instance.executable();
  if (exec.switch().name !== "contractExecutableWasm")
    return { wasmHash: null, codeLiveUntil: null };
  const hash = exec.wasmHash();
  const code = await server.getLedgerEntries(
    xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })),
  );
  return {
    wasmHash: Buffer.from(hash).toString("hex"),
    codeLiveUntil: code.entries[0]?.liveUntilLedgerSeq ?? null,
  };
}

export interface Rent {
  contractId: string;
  instanceLiveUntil: number;
  codeLiveUntil: number | null;
  latestLedger: number;
  wasmHash: string | null;
}

/** Just the TTLs. Works for any Soroban contract, so it also covers the retired v1 wrapper. */
export async function readRent(config: BridgeChainConfig, contractId: string): Promise<Rent> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const { entry, instance, latestLedger } = await readInstanceEntry(server, contractId);
  const code = await readCodeLiveUntil(server, instance);
  return { contractId, instanceLiveUntil: entry.liveUntilLedgerSeq ?? 0, latestLedger, ...code };
}

export async function readWrapperState(
  config: BridgeChainConfig,
  contractId: string,
): Promise<WrapperState> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const { entry, instance, latestLedger } = await readInstanceEntry(server, contractId);
  const decoded = (instance.storage() ?? []).map((kv) => {
    const key = scValToNative(kv.key()) as unknown;
    return {
      key: Array.isArray(key) ? String(key[0]) : String(key),
      value: scValToNative(kv.val()) as unknown,
    };
  });
  const { wasmHash, codeLiveUntil } = await readCodeLiveUntil(server, instance);
  return {
    contractId,
    ...decodeInstanceStorage(decoded),
    instanceLiveUntil: entry.liveUntilLedgerSeq ?? 0,
    codeLiveUntil,
    latestLedger,
    wasmHash,
  };
}

// ---- Writes ----------------------------------------------------------------------------------

const PARAMS_TYPES = {
  fee_bps: ["symbol", "u32"],
  min_fee: ["symbol", "i128"],
  min_transfer: ["symbol", "i128"],
  max_transfer: ["symbol", "i128"],
  max_cctp_fee_bps: ["symbol", "u32"],
  account_fee: ["symbol", "i128"],
};

const DOMAIN_TYPES = {
  domain: ["symbol", "u32"],
  evm_style: ["symbol", "bool"],
  forward: ["symbol", "bool"],
  max_forward_fee: ["symbol", "i128"],
  account_creation: ["symbol", "bool"],
  max_forward_fee_new_account: ["symbol", "i128"],
};

type NativeOpts = Parameters<typeof nativeToScVal>[1];

/** `#[contracttype]` structs are maps keyed by symbol with explicit integer widths. See the note on
 *  `encodeBridgeRequest`: the SDK's guesses are wrong for both keys and values. */
export function encodeParams(p: Params): xdr.ScVal {
  return nativeToScVal(
    {
      fee_bps: p.feeBps,
      min_fee: p.minFee,
      min_transfer: p.minTransfer,
      max_transfer: p.maxTransfer,
      max_cctp_fee_bps: p.maxCctpFeeBps,
      account_fee: p.accountFee,
    },
    { type: PARAMS_TYPES } as NativeOpts,
  );
}

export function encodeDomain(d: DomainCfg): xdr.ScVal {
  return nativeToScVal(
    {
      domain: d.domain,
      evm_style: d.evmStyle,
      forward: d.forward,
      max_forward_fee: d.maxForwardFee,
      account_creation: d.accountCreation,
      max_forward_fee_new_account: d.maxForwardFeeNewAccount,
    },
    { type: DOMAIN_TYPES } as NativeOpts,
  );
}

const addr = (a: string) => nativeToScVal(new Address(a), { type: "address" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const bool = (b: boolean) => nativeToScVal(b, { type: "bool" });

/** One admin call. `caller` is the signer, passed where the contract wants an explicit caller. */
export type AdminCall =
  | { action: "pause"; caller: string }
  | { action: "unpause" }
  | { action: "tighten_params"; params: Params }
  | { action: "propose_params"; params: Params }
  | { action: "commit_params" }
  | { action: "tighten_domain"; caller: string; cfg: DomainCfg }
  | { action: "propose_domain"; cfg: DomainCfg }
  | { action: "commit_domain" }
  | { action: "remove_domain"; caller: string; domain: number }
  | { action: "cancel_pending"; caller: string }
  | { action: "withdraw_fees"; amount: bigint };

/** Pure: which contract method and arguments an `AdminCall` becomes. */
export function buildInvocation(call: AdminCall): { method: Action; args: xdr.ScVal[] } {
  switch (call.action) {
    case "pause":
      return { method: "pause", args: [addr(call.caller)] };
    case "unpause":
    case "commit_params":
    case "commit_domain":
      return { method: call.action, args: [] };
    case "tighten_params":
    case "propose_params":
      return { method: call.action, args: [encodeParams(call.params)] };
    case "propose_domain":
      return { method: call.action, args: [encodeDomain(call.cfg)] };
    case "tighten_domain":
      return {
        method: "tighten_domain",
        args: [
          addr(call.caller),
          u32(call.cfg.domain),
          bool(call.cfg.forward),
          i128(call.cfg.maxForwardFee),
          bool(call.cfg.accountCreation),
          i128(call.cfg.maxForwardFeeNewAccount),
        ],
      };
    case "remove_domain":
      return { method: "remove_domain", args: [addr(call.caller), u32(call.domain)] };
    case "cancel_pending":
      return { method: "cancel_pending", args: [addr(call.caller)] };
    case "withdraw_fees":
      return { method: "withdraw_fees", args: [i128(call.amount)] };
  }
}

/**
 * Simulates, asks the wallet to sign, submits and waits. Simulation happens first, so a change the
 * contract would refuse (timelock not elapsed, not a tightening, out of bounds) fails here with the
 * contract's own error name and nobody is asked to sign.
 */
export async function sendAdminCall(
  kit: StellarWalletsKit,
  config: BridgeChainConfig,
  contractId: string,
  signer: string,
  call: AdminCall,
): Promise<{ txHash: string }> {
  const { method, args } = buildInvocation(call);
  const server = new rpc.Server(config.sorobanRpcUrl);
  const account = await server.getAccount(signer);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();

  let prepared: Awaited<ReturnType<typeof server.prepareTransaction>>;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new Error(humanizeAdminError(formatError(err)));
  }
  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: config.networkPassphrase,
    address: signer,
  });
  const signed = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
  const { txHash } = await submitSigned(server, signed, `${method} transaction`);
  await waitForTx(config, txHash);
  return { txHash };
}
