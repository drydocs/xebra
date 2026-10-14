import { type Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_MESSENGER_MINTER_V2,
  associatedTokenAddress,
  usedNonceAddress,
} from "@xebra/cctp-solana";
import { describe, expect, it } from "vitest";
import { buildMintTransaction, prepareClaim } from "./claim";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "BswkfXXywbVo8tesK4sWkrpsaVYUy3zaJuQYTCChGpG2";

/** A CCTP V2 message: 148-byte header, then a burn body carrying mintRecipient at +36. A real
 *  attested message to Solana is 376 bytes, which is what makes the transaction size matter. */
function message(mintRecipient: PublicKey, length = 148 + 68): string {
  const buf = Buffer.alloc(length);
  Buffer.from("2f3c72ee96e3feb1be4b78587de0b00634394e94a4220ec205684be9b8447729", "hex").copy(
    buf,
    12,
  );
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

  it("opens the token account in a transaction of its own when the owner checks out", async () => {
    const connection = fakeConnection({ [tokenMessengerPda.toBase58()]: tokenMessengerAccount });
    const result = await prepareClaim(connection, input({ recipientOwner: owner.toBase58() }));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // The mint is not in here: it is built only after this has confirmed, because the two do
    // not fit in one Solana transaction (see the size tests below).
    expect(result.setup?.instructions).toHaveLength(1);
    expect(result.setup?.instructions[0]?.programId.toBase58()).toBe(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    expect(result.setup?.instructions[0]?.keys[1]?.pubkey.equals(ata)).toBe(true);
    expect(result.setup?.feePayer?.toBase58()).toBe(PAYER);

    const mint = await buildMintTransaction(
      connection,
      input({ recipientOwner: owner.toBase58() }),
    );
    expect(mint.instructions).toHaveLength(1);
    expect(mint.feePayer?.toBase58()).toBe(PAYER);
  });

  it("reports a transfer someone already minted, before asking for anything", async () => {
    // The used_nonce account exists once the transfer is minted. Checked first, so nobody pays
    // 0.0015 SOL to open an account for a transfer that has already landed.
    const result = await prepareClaim(
      fakeConnection({ [usedNonceAddress(message(ata)).toBase58()]: { data: Buffer.alloc(9) } }),
      input(),
    );
    expect(result.status).toBe("already-minted");
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
    expect(result.setup).toBeNull();
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

describe("the claim's transactions at real size", () => {
  const LIMIT = 1232;
  const realInput = input({
    message: message(ata, 376),
    attestation: `0x${"ab".repeat(130)}`,
    recipientOwner: owner.toBase58(),
  });
  const connection = fakeConnection({ [tokenMessengerPda.toBase58()]: tokenMessengerAccount });
  const size = (tx: Transaction) =>
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;

  it("fits each one inside Solana's packet limit", async () => {
    const result = await prepareClaim(connection, realInput);
    if (result.status !== "ready" || !result.setup) throw new Error("expected a setup transaction");
    expect(size(result.setup)).toBeLessThanOrEqual(LIMIT);
    expect(size(await buildMintTransaction(connection, realInput))).toBeLessThanOrEqual(LIMIT);
  });

  it("could not have been one transaction", async () => {
    // The shape every claim to a wallet without a USDC account used to have: 1,330 bytes, refused
    // before it reached the chain.
    const result = await prepareClaim(connection, realInput);
    if (result.status !== "ready" || !result.setup) throw new Error("expected a setup transaction");
    const mint = await buildMintTransaction(connection, realInput);
    const both = new Transaction().add(...result.setup.instructions, ...mint.instructions);
    both.feePayer = new PublicKey(PAYER);
    both.recentBlockhash = "11111111111111111111111111111111";
    expect(() => size(both)).toThrow(/too large/i);
  });
});
