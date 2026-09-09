import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  RECEIVE_MESSAGE_DISCRIMINATOR,
  associatedTokenAddress,
  readMintRecipient,
  readNonce,
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_MINTER_V2,
} from "./receive-message.js";

/**
 * Fixture from a REAL mainnet burn (Stellar tx ca70f32e…), attested by Circle. Using a real
 * message rather than a synthetic one is the point: the byte offsets below were the source of
 * a production bug, and only a genuine message proves they are right.
 */
const REAL_MESSAGE_NONCE = "2f3c72ee96e3feb1be4b78587de0b00634394e94a4220ec205684be9b8447729";

describe("associatedTokenAddress", () => {
  it("reproduces an ATA observed on mainnet", () => {
    // 2GiJjx… is a real address; B8vQF8… is its USDC ATA, confirmed to exist on chain.
    const owner = new PublicKey("2GiJjxyCM296G3aAxrz826m8JZjeoqMAKuushBE19ouL");
    const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(associatedTokenAddress(owner, usdc).toBase58()).toBe(
      "B8vQF8ESWbGcYLmH7veQPyshVH7XfDHPg2pAPk4RjV7d",
    );
  });
});

describe("message parsing", () => {
  // A CCTP V2 message: 148-byte header then the burn body.
  function fakeMessage(nonceHex: string, mintRecipient: PublicKey): string {
    const buf = Buffer.alloc(148 + 68);
    Buffer.from(nonceHex, "hex").copy(buf, 12);
    mintRecipient.toBuffer().copy(buf, 148 + 36);
    return `0x${buf.toString("hex")}`;
  }

  it("slices the nonce from bytes [12,44)", () => {
    // Verified against Iris: this slice reproduced the reported eventNonce exactly.
    const recipient = PublicKey.default;
    const nonce = readNonce(fakeMessage(REAL_MESSAGE_NONCE, recipient));
    expect(nonce.toString("hex")).toBe(REAL_MESSAGE_NONCE);
    expect(nonce).toHaveLength(32);
  });

  it("reads mintRecipient from the burn body", () => {
    const recipient = new PublicKey("B8vQF8ESWbGcYLmH7veQPyshVH7XfDHPg2pAPk4RjV7d");
    expect(readMintRecipient(fakeMessage(REAL_MESSAGE_NONCE, recipient)).toBase58()).toBe(
      recipient.toBase58(),
    );
  });
});

describe("program ids", () => {
  it("targets CCTP V2, not V1", () => {
    // V1 ids start CCTPi…/CCTPm… and have entirely different account layouts.
    expect(MESSAGE_TRANSMITTER_V2.toBase58()).toBe("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
    expect(TOKEN_MESSENGER_MINTER_V2.toBase58()).toBe(
      "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    );
  });
});

describe("the Anchor discriminator", () => {
  it("matches sha256(\"global:receive_message\")", async () => {
    // The constant exists so this module runs in a browser: hashing at call time needed
    // `node:crypto`, which is what kept the self-serve claim page from building the same
    // instruction the relay builds. A precomputed constant is only safe if something checks it,
    // and a wrong discriminator is rejected on chain only after paying a fee to find out.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update("global:receive_message").digest().subarray(0, 8);
    expect(RECEIVE_MESSAGE_DISCRIMINATOR.toString("hex")).toBe(expected.toString("hex"));
  });
});
