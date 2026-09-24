import { encodeReceiveMessage, messageTransmitterAbi } from "@xebra/cctp-evm";
import { encodeFunctionData } from "viem";

/**
 * Completing an Arc transfer from the browser, without us.
 *
 * The Arc half of `lib/claim.ts`, and the same promise: Circle's `(message, attestation)` pair is
 * public, `destination_caller` is zero, so any wallet may submit `receiveMessage` and the mint
 * lands on whoever the burn named. Circle's forwarding service pays the gas as a convenience; this is the version
 * where you pay it.
 *
 * # It sends the calldata the forwarder would
 *
 * `encodeReceiveMessage` from `@xebra/cctp-evm`, unchanged. A browser-only encoding is how the two
 * quietly diverge.
 *
 * # No wagmi, no connector library
 *
 * This talks to the injected EIP-1193 provider directly. The app used to carry wagmi and shed it
 * (see `next.config.ts`) because a bridge that needed an EVM connector to *build* was not worth
 * its dependency tree; a claim page needs four JSON-RPC methods, and this is those four.
 *
 * # Who pays
 *
 * The connected wallet, in gas — USDC on Arc, so well under a cent. The payer need not be the
 * recipient: the mint goes to the address the burn named, whoever submits it.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface ArcClaimTarget {
  chainId: number;
  messageTransmitter: string;
  rpcUrl: string;
  explorerUrl: string;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

const hex = (n: number) => `0x${n.toString(16)}`;

export async function connectEvmWallet(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("the wallet returned no accounts");
  return first;
}

/** Switches the wallet to Arc, adding the network first if it has never seen it. */
export async function ensureArcNetwork(
  provider: Eip1193Provider,
  target: ArcClaimTarget,
): Promise<void> {
  const chainId = hex(target.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    // 4902: the wallet does not know this chain. Anything else is a refusal or a real failure.
    if ((err as { code?: number }).code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Arc",
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [target.rpcUrl],
          blockExplorerUrls: [target.explorerUrl],
        },
      ],
    });
  }
}

/**
 * Whether Circle's transmitter has already consumed this message's nonce.
 *
 * Worth asking before a wallet prompt because the likeliest reason to be on this page with a
 * working attestation is that Circle's forwarding got there first — and "already minted, nothing to do" is
 * a much better thing to be told than a wallet's opaque "transaction will fail" warning.
 *
 * The nonce is bytes 12..44 of the V2 message header (`version | source | destination | nonce`).
 */
export async function isAlreadyMinted(
  provider: Eip1193Provider,
  target: ArcClaimTarget,
  message: `0x${string}`,
): Promise<boolean> {
  const nonce = `0x${message.slice(2 + 12 * 2, 2 + 44 * 2)}`;
  const data = encodeFunctionData({
    abi: messageTransmitterAbi,
    functionName: "usedNonces",
    args: [nonce as `0x${string}`],
  });
  const result = (await provider.request({
    method: "eth_call",
    params: [{ to: target.messageTransmitter, data }, "latest"],
  })) as string;
  return BigInt(result) !== 0n;
}

export async function sendClaim(
  provider: Eip1193Provider,
  target: ArcClaimTarget,
  from: string,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Promise<string> {
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [
      { from, to: target.messageTransmitter, data: encodeReceiveMessage(message, attestation) },
    ],
  })) as string;
}

/** Polls the wallet's own node. Arc finalises in under a second; the ceiling is for a bad RPC. */
export async function waitForClaim(
  provider: Eip1193Provider,
  hash: string,
  timeoutMs = 60_000,
): Promise<"success" | "reverted"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) return receipt.status === "0x1" ? "success" : "reverted";
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`no receipt for ${hash} after ${Math.round(timeoutMs / 1000)}s`);
}
