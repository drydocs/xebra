import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_MESSENGER_MINTER_V2, associatedTokenAddress } from "@xebra/cctp-solana";
import { prepareClaim } from "./claim";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "BswkfXXywbVo8tesK4sWkrpsaVYUy3zaJuQYTCChGpG2";

/** A CCTP V2 message: 148-byte header, then a burn body carrying mintRecipient at +36. */
function message(mintRecipient: PublicKey): string {
  const buf = Buffer.alloc(148 + 68);
  Buffer.from("2f3c72ee96e3feb1be4b78587de0b00634394e94a4220ec205684be9b8447729", "hex").copy(buf, 12);
  mintRecipient.toBuffer().copy(buf, 148 + 36);
  return `0x${buf.toString("hex")}`;
}

/** A Connection that answers only what `prepareClaim` asks, so no network is involved. */
function fakeConnection(accounts: Record<string, unknown>): Connection {
  return {
    getAccountInfo: async (key: PublicKey) => accounts[key.toBase58()] ?? null,
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111" }),
  } as unknown as Connection;
}

const owner = Keypair.generate().publicKey;
const ata = associatedTokenAddress(owner, new PublicKey(USDC));

/** The TokenMessenger PDA, whose account bytes carry the fee recipient the instruction reads at
 *  offset 109. Zeroed data is fine here — the address only has to resolve. */
const [tokenMessengerPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_messenger", "utf8")],
  TOKEN_MESSENGER_MINTER_V2,
);
const tokenMessengerAccount = { data: Buffer.alloc(200) };

function input(overrides: Record<string, unknown> = {}) {
  return {
    message: message(ata),
    attestation: `0x${"ab".repeat(65)}`,
    usdcMint: USDC,
    sourceDomainId: 27,
    payer: PAYER,
    ...overrides,
  };
}

describe("prepareClaim", () => {
  it("asks for the owner when the recipient has no token account", async () => {
    // The burn message carries only the derived token account, and a token account address
    // cannot be reversed into its owner — so there is genuinely no way to create it without
    // being told whose it is.
    const result = await prepareClaim(fakeConnection({}), input());
    expect(result.status).toBe("needs-owner");
    if (result.status !== "needs-owner") return;
    expect(result.recipientTokenAccount).toBe(ata.toBase58());
    expect(result.reason).toContain("no USDC account");
  });

  it("refuses an owner whose token account is not the one the burn names", async () => {
    // Creating the wrong account spends the payer's rent on something unusable and still leaves
    // the mint impossible.
    const stranger = Keypair.generate().publicKey;
    const result = await prepareClaim(
      fakeConnection({}),
      input({ recipientOwner: stranger.toBase58() }),
    );
    expect(result.status).toBe("needs-owner");
    if (result.status !== "needs-owner") return;
    expect(result.reason).toContain("not the account this burn names");
  });

  it("creates the token account, then mints, when the owner checks out", async () => {
    const result = await prepareClaim(
      fakeConnection({ [tokenMessengerPda.toBase58()]: tokenMessengerAccount }),
      input({ recipientOwner: owner.toBase58() }),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.createsTokenAccount).toBe(true);
    // Order matters: the account has to exist before `receiveMessage` mints into it, and both
    // must be in one transaction or a failed mint leaves the payer having bought rent for
    // nothing.
    expect(result.transaction.instructions).toHaveLength(2);
    expect(result.transaction.feePayer?.toBase58()).toBe(PAYER);
  });

  it("skips account creation when the recipient already has one", async () => {
    const result = await prepareClaim(
      fakeConnection({
        [tokenMessengerPda.toBase58()]: tokenMessengerAccount,
        [ata.toBase58()]: { data: Buffer.alloc(165) },
      }),
      input(),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // No owner was supplied and none is needed — the common case must not ask for one.
    expect(result.createsTokenAccount).toBe(false);
    expect(result.transaction.instructions).toHaveLength(1);
  });

  it("mints to the account the burn named, not to the payer", async () => {
    // The payer and the recipient are deliberately different: anyone can rescue anyone's stuck
    // transfer, and `receiveMessage` sends the funds where the burn said regardless.
    const result = await prepareClaim(fakeConnection({}), input());
    if (result.status !== "needs-owner") return;
    expect(result.recipientTokenAccount).not.toBe(PAYER);
    expect(result.recipientTokenAccount).toBe(ata.toBase58());
  });
});
