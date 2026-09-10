import { type Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { TOKEN_MESSENGER_MINTER_V2, buildReceiveMessageInstruction } from "./receive-message.js";

/**
 * `receiveMessage` sits 8 bytes under Solana's 1232-byte packet limit, so it cannot carry a
 * single extra instruction.
 *
 * A `setComputeUnitLimit` call added for safety margin took it to exactly 1264 and every mint
 * failed with `Transaction too large: 1264 > 1232` — after the burn, with the user's USDC
 * already gone and waiting. Nothing in the suite measured the transaction, so nothing caught it.
 */

const LIMIT = 1232;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PAYER = new PublicKey("BswkfXXywbVo8tesK4sWkrpsaVYUy3zaJuQYTCChGpG2");

/** A real attested mainnet message: 376 bytes, and its size is what dominates the transaction. */
function realMessage(): string {
  const buf = Buffer.alloc(376);
  Buffer.from("578272c8d89e288bd4cc40f221d837906dab71f3427bc4fbdc34fa97c432600b", "hex").copy(
    buf,
    12,
  );
  new PublicKey("F7uED84sz9SvgumnVXbdZ9d2tv7tjYPNqiYd7Uc3vLVB").toBuffer().copy(buf, 148 + 36);
  return `0x${buf.toString("hex")}`;
}

/** CCTP V2 attestations are two 65-byte signatures. */
const ATTESTATION = `0x${"ab".repeat(130)}`;

const [tokenMessengerPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_messenger", "utf8")],
  TOKEN_MESSENGER_MINTER_V2,
);

function fakeConnection(): Connection {
  return {
    getAccountInfo: async (key: PublicKey) =>
      key.equals(tokenMessengerPda) ? { data: Buffer.alloc(200) } : null,
  } as unknown as Connection;
}

async function build() {
  const ix = await buildReceiveMessageInstruction(
    fakeConnection(),
    PAYER,
    realMessage(),
    ATTESTATION,
    { usdcMint: USDC, sourceDomain: 27 },
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = PAYER;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx;
}

describe("the mint transaction", () => {
  it("fits inside Solana's packet limit", async () => {
    const tx = await build();
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    expect(size, `receiveMessage serialised to ${size} bytes`).toBeLessThanOrEqual(LIMIT);
  });

  it("has so little headroom that nothing else can be added", async () => {
    // The point of the previous test is not that it passes — it is how narrowly it passes.
    // Anyone adding an instruction here needs to know it cannot fit.
    const tx = await build();
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    expect(LIMIT - size).toBeLessThan(64);
  });

  it("reproduces the exact production failure when a compute-budget instruction is added", async () => {
    // A 32-byte program id in the account table plus an 8-byte compiled instruction: 1224 + 40.
    // `serialize` throws rather than returning a size, which is the error that reached mainnet
    // — after the burn, with the user's USDC already gone and waiting on a mint that could
    // never be submitted.
    const { ComputeBudgetProgram } = await import("@solana/web3.js");
    const tx = await build();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    expect(() => tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toThrow(
      "Transaction too large: 1264 > 1232",
    );
  });
});
