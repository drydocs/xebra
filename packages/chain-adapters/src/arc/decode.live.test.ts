import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { http, type Hex, createPublicClient, createWalletClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeArcLogs } from "./decode.js";

/**
 * Runs against a real, locally-spawned `anvil` node with the *actual compiled* XebraEscrow
 * bytecode (from contracts/arc-evm's `forge build` output) — proves decodeArcLogs against a
 * genuine emitted event, not a hand-built log fixture. Skipped unless RUN_ANVIL_TESTS=1 (this
 * package's `test:integration` script sets it) so plain `pnpm test` stays fast and doesn't
 * require the Foundry toolchain or a prior `forge build` in contracts/arc-evm.
 */
const RUN = process.env.RUN_ANVIL_TESTS === "1";
const describeIfAnvil = RUN ? describe : describe.skip;

const CONTRACTS_ARC_EVM = fileURLToPath(new URL("../../../../contracts/arc-evm/", import.meta.url));
const ANVIL_PORT = 8546;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil/Hardhat's well-known deterministic dev mnemonic accounts #0 and #1.
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const USER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

function loadArtifact(name: string): { abi: unknown[]; bytecode: Hex } {
  const raw = readFileSync(`${CONTRACTS_ARC_EVM}out/${name}.sol/${name}.json`, "utf-8");
  const json = JSON.parse(raw);
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

describeIfAnvil("decodeArcLogs (live, against a real anvil-deployed XebraEscrow)", () => {
  let anvil: ChildProcess;
  let deployedIntentHash: Hex;
  let txHash: Hex;
  let openReceiptLogs: Parameters<typeof decodeArcLogs>[0];

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"]);
    await waitForRpc(RPC_URL);

    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const user = privateKeyToAccount(USER_PK);
    const publicClient = createPublicClient({ transport: http(RPC_URL) });
    const deployerClient = createWalletClient({ account: deployer, transport: http(RPC_URL) });
    const userClient = createWalletClient({ account: user, transport: http(RPC_URL) });

    const usdc = loadArtifact("MockUSDC");
    const escrow = loadArtifact("XebraEscrow");

    const usdcDeployHash = await deployerClient.deployContract({
      abi: usdc.abi,
      bytecode: usdc.bytecode,
      args: [],
      chain: null,
    });
    const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcDeployHash });
    const usdcAddress = usdcReceipt.contractAddress as Hex;

    const escrowDeployHash = await deployerClient.deployContract({
      abi: escrow.abi,
      bytecode: escrow.bytecode,
      args: [usdcAddress, deployer.address, 1800n],
      chain: null,
    });
    const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash });
    const escrowAddress = escrowReceipt.contractAddress as Hex;

    // Mint USDC to the user and approve the escrow.
    const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
    const mintHash = await deployerClient.writeContract({
      address: usdcAddress,
      abi: mintAbi,
      functionName: "mint",
      args: [user.address, 1_000_000000n],
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const approveAbi = parseAbi([
      "function approve(address spender, uint256 amount) returns (bool)",
    ]);
    const approveHash = await userClient.writeContract({
      address: usdcAddress,
      abi: approveAbi,
      functionName: "approve",
      args: [escrowAddress, 2n ** 256n - 1n],
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const block = await publicClient.getBlock();
    const intent = {
      user: user.address,
      sourceToken: usdcAddress,
      sourceAmount: 100_000000n,
      destAsset: `0x${"0".repeat(64)}` as Hex,
      minDestAmount: 900_0000000n,
      destAddress: `0x${"7".repeat(64)}` as Hex,
      expiry: block.timestamp + 3600n,
      nonce: 1n,
    };

    const domain = {
      name: "Xebra",
      version: "1",
      chainId: 31337,
      verifyingContract: escrowAddress,
    };
    const types = {
      Intent: [
        { name: "user", type: "address" },
        { name: "sourceToken", type: "address" },
        { name: "sourceAmount", type: "uint256" },
        { name: "destAsset", type: "bytes32" },
        { name: "minDestAmount", type: "uint256" },
        { name: "destAddress", type: "bytes32" },
        { name: "expiry", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    } as const;

    const signature = await userClient.signTypedData({
      account: user,
      domain,
      types,
      primaryType: "Intent",
      message: intent,
    });

    const openHash = await deployerClient.writeContract({
      address: escrowAddress,
      abi: escrow.abi,
      functionName: "open",
      args: [intent, signature],
      chain: null,
    });
    const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
    txHash = openHash;

    // Read the canonical hash back from the contract itself, independent of what the indexer
    // decodes from the log — the two must agree.
    deployedIntentHash = (await publicClient.readContract({
      address: escrowAddress,
      abi: escrow.abi,
      functionName: "hashIntent",
      args: [intent],
    })) as Hex;

    openReceiptLogs = openReceipt.logs;
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("decodes a real IntentOpened event emitted by the actual compiled contract", () => {
    const events = decodeArcLogs(openReceiptLogs);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.eventType).toBe("IntentOpened");
    expect(event?.intentHash).toBe(deployedIntentHash);
    expect(event?.txRef).toBe(txHash);
    expect(event?.payload.sourceAmount).toBe("100000000");
  });
});

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`anvil did not become ready at ${url} within ${timeoutMs}ms`);
}
