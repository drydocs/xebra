import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import {
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { formatError } from "./format-error";

/**
 * Client for `contracts/stellar-cctp-wrapper` — the CCTP-direct USDC rail, Stellar → Solana.
 *
 * # The fee breakdown is read from the contract, never recomputed here
 *
 * `quoteBridge` simulates the wrapper's own `quote()` view rather than reimplementing
 * `fee = max(amount * fee_bps / 10_000, min_fee)` in TypeScript. Two reasons:
 *
 * 1. The parameters are on-chain and can change under a 48h timelock. A hardcoded copy in the
 *    frontend would silently disagree with reality after any `commit_params`.
 * 2. The rounding is load-bearing. `net` is floored to a 10-stroop boundary because Stellar
 *    USDC has 7 decimals and CCTP's canonical representation has 6; a JS reimplementation
 *    that got that wrong would quote a number the contract never burns.
 *
 * # `max_fee` comes from Circle, also on-chain
 *
 * CCTP charges its own fee at mint time on the destination chain. `max_fee` is the ceiling
 * the user authorizes for it, and the wrapper bounds it further (`check_max_fee`) so a buggy
 * frontend cannot hand away a user's principal. The correct value is Circle's own
 * `get_min_fee_amount` for this token and amount — read live, not guessed, because the
 * min-fee controller can change it.
 */

/** Stellar token amounts are 7-decimal fixed point. */
export const STROOPS_PER_USDC = 10_000_000n;

/**
 * Inclusion-fee bid, in stroops (0.1 XLM).
 *
 * This is a **bid ceiling, not a charge**. Stellar charges the market clearing rate up to
 * your bid, so bidding high costs nothing in the normal case and buys reliable inclusion when
 * the network is busy.
 *
 * `BASE_FEE` (100) is the network *minimum*, and using it was the bug behind the first real
 * mainnet attempt: the approve was accepted by the client, never included in any ledger, and
 * came back NOT_FOUND on both Horizon and Soroban RPC. Live mainnet stats at the time:
 *
 *     ledger_capacity_usage  0.78          (surge pricing active)
 *     max_fee bids  p50      144,395       (we were bidding 100)
 *     fee_charged   p50      100           (what you actually pay)
 *
 * So the median bid was ~1,400x ours while the median *charge* was the floor. 0.1 XLM sits
 * above the observed p90 of fees actually charged (9,486) with a wide margin, and caps the
 * worst case at roughly three cents.
 *
 * `prepareTransaction` adds Soroban's deterministic resource fee on top; this bids only for
 * inclusion.
 */
const INCLUSION_FEE = "1000000";

export interface BridgeQuote {
  /** What the user asked to send, in stroops. */
  amount: bigint;
  /** Xebra's fee, in stroops. Includes `accountFee`. */
  fee: bigint;
  /** The part of `fee` that pays to create the recipient's USDC account, in stroops. Zero when
   *  the recipient already has one. Broken out so the UI can say what the charge is for. */
  accountFee: bigint;
  /** What is actually burned and minted on the destination, in stroops. */
  netBurned: bigint;
  /** Sub-10-stroop remainder that never leaves the user's wallet. */
  remainder: bigint;
}

export interface BridgeChainConfig {
  /** Horizon base URL, used only for confirmation polling. */
  horizonUrl: string;
  /**
   * Xebra's fee wrapper. Optional: when it is not deployed the app bridges **directly**
   * through Circle's TokenMessengerMinter, which is already live on mainnet. That path takes
   * no fee, but it is a real bridge — and it exercises every risky part of the flow (the
   * wallet auth tree, mint_recipient encoding, Circle's max_fee handling) without anything
   * of ours needing to exist on chain first.
   */
  wrapperContractId: string | null;
  cctpTokenMessengerId: string;
  usdcSacAddress: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  destinationDomain: number;
}

/** Parses USDC typed by a human ("12.5") into stroops, rejecting more than 7 decimals. */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter an amount in USDC, for example 25.00");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 7) {
    throw new Error("USDC on Stellar has at most 7 decimal places");
  }
  return BigInt(whole || "0") * STROOPS_PER_USDC + BigInt(`${fraction}0000000`.slice(0, 7));
}

/** Formats stroops for display. Trims trailing zeros but always keeps at least 2 decimals. */
export function formatUsdc(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const fraction = (abs % STROOPS_PER_USDC).toString().padStart(7, "0").replace(/0+$/, "");
  const padded = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${padded}`;
}

/**
 * The split when bridging directly through Circle: no Xebra fee, and `net` floored to a
 * 10-stroop boundary because Stellar USDC is 7-decimal and CCTP's canonical form is 6.
 *
 * Computing this in TypeScript is safe here precisely because there is no fee to get wrong —
 * the only arithmetic is the same flooring Circle itself applies internally. When the wrapper
 * IS deployed, the numbers come from its own `quote()` instead, so the fee math is never
 * duplicated.
 */
export function directQuote(amount: bigint): BridgeQuote {
  const remainder = amount % STROOPS_PER_CANONICAL_UNIT;
  // Direct mode takes no fee at all, so there is nothing to break out — the user pays their own
  // destination gas either way.
  return { amount, fee: 0n, accountFee: 0n, netBurned: amount - remainder, remainder };
}

/** Stellar 7-decimal stroops per CCTP 6-decimal canonical unit. */
export const STROOPS_PER_CANONICAL_UNIT = 10n;

/**
 * Reads the fee split from the wrapper. Throws with the contract's own error name when the
 * amount is outside the configured bounds, so the user sees the real reason (AmountBelowMin,
 * AmountAboveMax) rather than a generic failure.
 */
export async function quoteBridge(
  config: BridgeChainConfig,
  sourceAddress: string,
  amount: bigint,
  /**
   * Whether the destination has no USDC account yet, from `/api/recipient`.
   *
   * It changes the price: creating one costs about 2,039,280 lamports of rent that nobody can
   * ever reclaim, and the sponsor pays it. Charged separately from the floor so a repeat
   * recipient is not billed for a cost only a first-time one causes.
   *
   * Must match what `submitBridge` is given, or the quote shown and the amount charged differ.
   */
  recipientNeedsAccount: boolean,
): Promise<BridgeQuote> {
  if (!config.wrapperContractId) return directQuote(amount);

  const server = new rpc.Server(config.sorobanRpcUrl);
  const contract = new Contract(config.wrapperContractId);
  const account = await server.getAccount(sourceAddress);

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "quote",
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(recipientNeedsAccount, { type: "bool" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(humanizeContractError(sim.error));
  }
  if (!sim.result) throw new Error("The bridge did not return a quote.");

  const raw = scValToNative(sim.result.retval) as {
    amount: bigint;
    fee: bigint;
    account_fee: bigint;
    net_burned: bigint;
    remainder: bigint;
  };

  return {
    amount: BigInt(raw.amount),
    fee: BigInt(raw.fee),
    accountFee: BigInt(raw.account_fee),
    netBurned: BigInt(raw.net_burned),
    remainder: BigInt(raw.remainder),
  };
}

/**
 * Circle's minimum fee for burning `amount` of `usdc`, read from the live TokenMessengerMinter.
 * This is the floor `max_fee` must meet; passing less makes `deposit_for_burn` revert
 * (`InsufficientMaxFee`) or silently downgrade a Fast transfer to Standard.
 */
export async function getCircleMinFee(
  config: BridgeChainConfig,
  sourceAddress: string,
  amount: bigint,
): Promise<bigint> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const retval = await simulateWithPassphrase(
    server,
    config.networkPassphrase,
    config.cctpTokenMessengerId,
    sourceAddress,
    "get_min_fee_amount",
    nativeToScVal(new Address(config.usdcSacAddress), { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
  );
  return BigInt(scValToNative(retval) as string | bigint);
}

async function simulateWithPassphrase(
  server: rpc.Server,
  networkPassphrase: string,
  contractId: string,
  sourceAddress: string,
  method: string,
  // biome-ignore lint/suspicious/noExplicitAny: stellar-sdk's call() takes variadic xdr.ScVal
  ...args: any[]
) {
  const contract = new Contract(contractId);
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} failed: ${sim.error}`);
  if (!sim.result) throw new Error(`${method} returned no result`);
  return sim.result.retval;
}

export interface SubmitBridgeParams {
  config: BridgeChainConfig;
  userAddress: string;
  amount: bigint;
  /** Destination recipient, already decoded to 32 bytes and validated. */
  mintRecipient: Uint8Array;
  maxFee: bigint;
  /** The user's own ceiling on Xebra's fee, from the quote they were shown. */
  maxWrapperFee: bigint;
  /** <= 1000 requests Fast Transfer. */
  minFinalityThreshold: number;
  /** Must match the value the quote was taken with, or the price shown and the price charged
   *  differ. */
  recipientNeedsAccount: boolean;
  /** Seconds from now. The contract rejects anything beyond one hour. */
  ttlSeconds: number;
}

/**
 * Builds, signs and submits `bridge()`. One transaction, one signature: the auth tree the
 * wallet produces covers both the fee transfer and Circle's `deposit_for_burn`, because the
 * user — not the wrapper — is the `caller` passed to Circle.
 *
 * There is no partial state to clean up if this fails. The contract holds no user principal
 * between transactions, so either the whole thing succeeds or the user keeps every stroop.
 */
export async function submitBridge(
  kit: StellarWalletsKit,
  params: SubmitBridgeParams,
): Promise<{ txHash: string }> {
  const { config } = params;
  if (!config.wrapperContractId) {
    // Callers must route to submitDirectBurn when the wrapper is not deployed. Failing here
    // rather than silently falling back keeps "which contract took my money" unambiguous.
    throw new Error("The fee wrapper is not deployed; use submitDirectBurn instead.");
  }
  const server = new rpc.Server(config.sorobanRpcUrl);
  const contract = new Contract(config.wrapperContractId);
  const account = await server.getAccount(params.userAddress);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + params.ttlSeconds);

  // The ledger at which the one-shot allowance to Circle's TokenMessenger expires, sent as
  // signed data rather than computed on chain.
  //
  // Soroban matches every sub-invocation against the signed authorization tree argument by
  // argument. The contract's `approve(user, messenger, net, expiration_ledger)` is one of those
  // sub-invocations, and the tree is built during simulation but checked during execution — two
  // different ledgers, always. When the contract derived the expiry from
  // `env.ledger().sequence()` the two values could never agree, and every transfer failed with
  // an authorization error rather than anything that named the real cause.
  //
  // `+ APPROVAL_TTL_LEDGERS` rather than something smaller because it maximises the window: the
  // contract requires the expiry to be at or beyond the executing ledger, so this is what decides
  // how long the signed transaction stays submittable — about five minutes at 5s ledgers.
  const { sequence: latestLedger } = await server.getLatestLedger();
  const approvalExpirationLedger = latestLedger + APPROVAL_TTL_LEDGERS;

  const request = nativeToScVal(
    {
      user: new Address(params.userAddress),
      amount: params.amount,
      destination_domain: config.destinationDomain,
      mint_recipient: Buffer.from(params.mintRecipient),
      max_fee: params.maxFee,
      min_finality_threshold: params.minFinalityThreshold,
      recipient_needs_account: params.recipientNeedsAccount,
      approval_expiration_ledger: approvalExpirationLedger,
      max_wrapper_fee: params.maxWrapperFee,
      deadline,
    },
    { type: "instance" },
  );

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call("bridge", request))
    .setTimeout(120)
    .build();

  // prepareTransaction simulates and attaches the auth entries + resource footprint. If the
  // contract would reject the request, it fails HERE — before the user is asked to sign.
  let prepared: Awaited<ReturnType<typeof server.prepareTransaction>>;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new Error(humanizeContractError(formatError(err)));
  }

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: config.networkPassphrase,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
  return submitSigned(server, signedTx, "bridge transaction");
}

/**
 * Reads the caller's current USDC allowance for Circle's TokenMessengerMinter.
 *
 * Circle's `deposit_for_burn` pulls the principal with `transfer_from`, which consumes an
 * allowance ledger entry — `require_auth` on the caller does NOT substitute for one. Without
 * it the burn reverts with the SAC's contract error #9, "not enough allowance to spend".
 */
export async function getUsdcAllowance(config: BridgeChainConfig, owner: string): Promise<bigint> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const retval = await simulateWithPassphrase(
    server,
    config.networkPassphrase,
    config.usdcSacAddress,
    owner,
    "allowance",
    nativeToScVal(new Address(owner), { type: "address" }),
    nativeToScVal(new Address(config.cctpTokenMessengerId), { type: "address" }),
  );
  return BigInt(scValToNative(retval) as string | bigint);
}

/** Ledgers the allowance stays live for. It only needs to survive the following burn. */
const APPROVAL_TTL_LEDGERS = 60;

/**
 * Approves Circle's TokenMessengerMinter to pull exactly `amount` of the user's USDC.
 *
 * This is a **separate transaction** from the burn. A Soroban transaction carries a single
 * contract invocation, so approve-then-burn cannot be batched from the client — hence two
 * wallet signatures in direct mode. Routing through the deployed wrapper collapses it back to
 * one, because a contract can make both cross-contract calls within a single invocation.
 */
export async function approveUsdcForCctp(
  kit: StellarWalletsKit,
  config: BridgeChainConfig,
  userAddress: string,
  amount: bigint,
): Promise<{ txHash: string }> {
  const server = new rpc.Server(config.sorobanRpcUrl);
  const usdc = new Contract(config.usdcSacAddress);
  const account = await server.getAccount(userAddress);
  const { sequence } = await server.getLatestLedger();

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      usdc.call(
        "approve",
        nativeToScVal(new Address(userAddress), { type: "address" }),
        nativeToScVal(new Address(config.cctpTokenMessengerId), { type: "address" }),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(sequence + APPROVAL_TTL_LEDGERS, { type: "u32" }),
      ),
    )
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: config.networkPassphrase,
  });
  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
  return submitSigned(server, signedTx, "approval");
}

/**
 * Submits a signed transaction and interprets the full status set.
 *
 * Soroban RPC's `sendTransaction` returns one of PENDING, DUPLICATE, TRY_AGAIN_LATER or
 * ERROR — and it returns a transaction **hash for all of them**. Checking only for ERROR
 * therefore treats TRY_AGAIN_LATER (the node declined to queue it, usually fee/congestion)
 * as success, and the caller then polls a hash that will never appear in any ledger.
 */
async function submitSigned(
  server: rpc.Server,
  signedTx: Parameters<rpc.Server["sendTransaction"]>[0],
  what: string,
): Promise<{ txHash: string }> {
  const result = await server.sendTransaction(signedTx);

  switch (result.status) {
    case "PENDING":
      return { txHash: result.hash };
    case "DUPLICATE":
      // Already in the mempool from a previous attempt — the same hash, so polling is valid.
      return { txHash: result.hash };
    case "TRY_AGAIN_LATER":
      throw new Error(
        `The network declined to queue the ${what} right now (TRY_AGAIN_LATER). Nothing has moved. Wait a few seconds and try again.`,
      );
    default:
      throw new Error(`The ${what} was rejected: ${formatError(result)}`);
  }
}

/**
 * Polls until a submitted transaction is applied, so the next step sees its ledger effects.
 *
 * # Why Horizon rather than the SDK's `getTransaction`
 *
 * `rpc.Server.getTransaction` decodes the transaction's result **XDR**, and the installed
 * @stellar/stellar-sdk (13.x) predates protocol 23's `TransactionMetaV4`. It therefore throws
 * `TypeError: Bad union switch: 4` on any successful mainnet transaction — the switch value
 * is literally the meta version it does not know.
 *
 * That failure is especially misleading: the transaction has *succeeded* and been included in
 * a ledger; only the client's parsing of the receipt blows up. The first real mainnet approve
 * landed (ledger 64329152, fee 9,036 stroops) and still surfaced as a failed transfer.
 *
 * Horizon answers the only question this function asks — did it land, and did it succeed —
 * as plain JSON, with no XDR anywhere in the path. A 404 means "not yet included", which is
 * the normal state while polling.
 *
 * The SDK is four majors behind (13.3.0 vs 17.0.1) and should still be upgraded; this keeps
 * the funds path working without doing that mid-flight.
 */
export async function waitForTx(
  config: BridgeChainConfig,
  txHash: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${config.horizonUrl.replace(/\/$/, "")}/transactions/${txHash}`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { successful?: boolean; result_xdr?: string };
        if (body.successful === true) return;
        if (body.successful === false) {
          throw new Error(
            `Transaction ${txHash} was included in a ledger but failed. Nothing has moved.`,
          );
        }
      } else if (res.status !== 404) {
        // 404 is the expected "not included yet" answer; anything else is worth surfacing
        // rather than silently retrying until the deadline.
        throw new Error(`Horizon returned ${res.status} while checking ${txHash}.`);
      }
    } catch (err) {
      // A network blip should not abort a transfer that is probably fine; a real on-chain
      // failure is rethrown above and must not be swallowed here.
      if (err instanceof Error && err.message.includes("was included in a ledger but failed")) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${txHash} to be applied.\n\nCheck the hash on stellar.expert. If it never lands, nothing has moved and it is safe to retry.`,
  );
}

/**
 * Bridges **directly** through Circle's TokenMessengerMinter, with no Xebra contract in the
 * path and no fee taken.
 *
 * The argument list is identical to what the wrapper passes internally, which is the point:
 * this exercises the whole risky surface — the auth tree a real wallet produces, the 32-byte
 * `mint_recipient` encoding, Circle's `max_fee` handling and its five revert conditions —
 * before anything of ours is deployed. If this works, the wrapper's only untested addition is
 * the fee arithmetic, which has 29 unit tests behind it.
 *
 * `destination_caller` is zeroed so the mint is permissionlessly claimable on the destination
 * chain by anyone holding the attestation, including the user. That is what stops a relay
 * outage from becoming stuck funds.
 */
export async function submitDirectBurn(
  kit: StellarWalletsKit,
  params: Omit<SubmitBridgeParams, "maxWrapperFee">,
): Promise<{ txHash: string }> {
  const { config } = params;
  const server = new rpc.Server(config.sorobanRpcUrl);
  const messenger = new Contract(config.cctpTokenMessengerId);
  const account = await server.getAccount(params.userAddress);

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      messenger.call(
        "deposit_for_burn",
        nativeToScVal(new Address(params.userAddress), { type: "address" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(config.destinationDomain, { type: "u32" }),
        nativeToScVal(Buffer.from(params.mintRecipient), { type: "bytes" }),
        nativeToScVal(new Address(config.usdcSacAddress), { type: "address" }),
        nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
        nativeToScVal(params.maxFee, { type: "i128" }),
        nativeToScVal(params.minFinalityThreshold, { type: "u32" }),
      ),
    )
    .setTimeout(120)
    .build();

  // Simulation attaches auth entries and the resource footprint. If Circle would reject this,
  // it fails HERE — before the user is asked to sign anything.
  let prepared: Awaited<ReturnType<typeof server.prepareTransaction>>;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    throw new Error(humanizeCircleError(formatError(err)));
  }

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: config.networkPassphrase,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
  return submitSigned(server, signedTx, "burn");
}

/**
 * Circle's own revert conditions, which surface as opaque contract error codes. Names come
 * from circlefin/stellar-cctp's TokenMessengerMinterError enum.
 */
export function humanizeCircleError(raw: string): string {
  if (/AmountMustBeNonzero/i.test(raw)) return "Enter an amount greater than zero.";
  if (/MintRecipientMustBeNonzero/i.test(raw)) return "The destination address cannot be empty.";
  if (/MaxFeeMustBeLessThanAmount/i.test(raw)) {
    return "The network fee would exceed the amount. Try a larger transfer.";
  }
  if (/InsufficientMaxFee/i.test(raw)) {
    return "Circle's network fee rose above the quote. Refresh and try again.";
  }
  if (/burn limit|BurnLimit/i.test(raw)) {
    return "That amount is above Circle's per-transfer burn limit.";
  }
  if (/denylist|Denylist/i.test(raw)) return "This account is not permitted to bridge USDC.";
  if (/insufficient balance|underflow/i.test(raw)) {
    return "Your USDC balance is too low for this transfer.";
  }
  if (/trustline|TrustLine/i.test(raw)) {
    return "This wallet has no USDC trustline on Stellar. Add one, then try again.";
  }
  return raw;
}

/**
 * Maps the wrapper's `#[contracterror]` variants to something a person can act on. Soroban
 * surfaces these as `Error(Contract, #N)`, which is accurate and completely opaque to a user
 * about to move money.
 */
const CONTRACT_ERRORS: Record<number, string> = {
  2: "The bridge is paused. No funds have moved — please try again later.",
  5: "This quote expired. Refresh and try again.",
  7: "That destination chain is not supported yet.",
  8: "The destination address cannot be all zeroes.",
  9: "That looks like an Ethereum address, not a Solana one.",
  12: "That amount is below the minimum for this bridge.",
  13: "That amount is above the current per-transfer limit.",
  14: "The amount is too small to cover the fee.",
  18: "The network fee quote was too high; refresh and try again.",
  19: "The fee changed since you were quoted. Refresh to see the new amount.",
  30: "Not enough accrued fees to withdraw.",
};

export function humanizeContractError(raw: string): string {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = Number(match[1]);
    const known = CONTRACT_ERRORS[code];
    if (known) return known;
    return `The bridge rejected this transfer (code ${code}). No funds have moved.`;
  }
  if (/insufficient balance|underflow/i.test(raw)) {
    return "Your USDC balance is too low for this transfer.";
  }
  return raw;
}
