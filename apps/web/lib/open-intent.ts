import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

/**
 * Builds, simulates, and submits `open()` on the Stellar-source XebraEscrow, signed via the
 * user's connected wallet (Stellar Wallets Kit's `signTransaction`, a documented Freighter-
 * supported capability). This is the simpler of the two flows docs/architecture.md §2
 * describes — sign-and-submit-the-whole-transaction, rather than sign-a-detached-auth-entry-
 * and-let-someone-else-submit — chosen deliberately for v1: it needs no relay infrastructure
 * (Stellar's base fee is negligible, so the user paying it directly is a fine default per the
 * architecture doc), and "connect wallet, sign a transaction, submit it" is the interaction
 * shape every Stellar wallet supports, vs. auth-entry signing's less certain wallet coverage.
 *
 * Real code, compiled against @stellar/stellar-sdk's actual API — not exercised against a live
 * Soroban RPC in this build (see repo README's Status section).
 */
export interface OpenIntentParams {
  escrowContractId: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  userAddress: string;
  sourceTokenAddress: string;
  sourceAmount: bigint;
  destChain: number;
  destAssetHex: `0x${string}`;
  minDestAmount: bigint;
  destAddressHex: `0x${string}`;
  expiry: bigint;
  nonce: bigint;
}

function buildIntentScVal(params: OpenIntentParams) {
  return nativeToScVal(
    {
      user: new Address(params.userAddress),
      source_token: new Address(params.sourceTokenAddress),
      source_amount: params.sourceAmount,
      dest_chain: params.destChain,
      dest_asset: hexToBuffer(params.destAssetHex),
      min_dest_amount: params.minDestAmount,
      dest_address: hexToBuffer(params.destAddressHex),
      expiry: params.expiry,
      nonce: params.nonce,
    },
    { type: "instance" },
  );
}

export async function getIntentHash(params: OpenIntentParams): Promise<`0x${string}`> {
  const server = new rpc.Server(params.sorobanRpcUrl);
  const contract = new Contract(params.escrowContractId);
  const account = await server.getAccount(params.userAddress);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: params.networkPassphrase })
    .addOperation(contract.call("hash_intent", buildIntentScVal(params)))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`hash_intent simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error("hash_intent simulation returned no result");
  }

  const bytes = sim.result.retval.bytes();
  return `0x${bytes.toString("hex")}` as `0x${string}`;
}

export async function openStellarIntent(
  kit: StellarWalletsKit,
  params: OpenIntentParams,
): Promise<{ txHash: string }> {
  const server = new rpc.Server(params.sorobanRpcUrl);
  const contract = new Contract(params.escrowContractId);
  const account = await server.getAccount(params.userAddress);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: params.networkPassphrase })
    .addOperation(contract.call("open", buildIntentScVal(params)))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    networkPassphrase: params.networkPassphrase,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, params.networkPassphrase);
  const result = await server.sendTransaction(signedTx);

  if (result.status === "ERROR") {
    throw new Error(`open() submission failed: ${JSON.stringify(result.errorResult)}`);
  }

  return { txHash: result.hash };
}

function hexToBuffer(hex: `0x${string}`): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}
