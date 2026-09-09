import { Buffer } from "buffer";
import {
  type Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Builds CCTP V2's `receiveMessage` instruction for Solana — the mint half of the corridor.
 *
 * # Verified against mainnet, not inferred
 *
 * Every PDA below was derived and confirmed to exist on Solana mainnet, and the whole
 * instruction was simulated against Circle's live programs. The simulation reached
 * `HandleReceiveFinalizedMessage` and failed only on a semantic check about the recipient —
 * which means the account list, ordering and Anchor encoding are correct.
 *
 * # Built against V2, not Circle's published V1 example
 *
 * `circlefin/solana-cctp-contracts`'s `examples/receiveMessage.ts` targets V1 and would
 * silently produce a wrong account list here:
 *
 *   - program ids differ (CCTPV2… vs CCTPi…/CCTPm…)
 *   - V2 seeds `used_nonce` with the 32-byte nonce sliced from the message, not a numeric
 *     nonce fetched through `getNoncePda`
 *   - V2's receiver account list gains `fee_recipient_token_account`
 *
 * Layouts come from the V2 IDLs and program source.
 *
 * # Runs in a browser as well as on a server
 *
 * No `node:` imports and no reliance on a global `Buffer`. Both the relay and the self-serve
 * claim page build the instruction from this one function, because the whole point of the claim
 * page is that it does exactly what the relay would have done.
 *
 * # `mintRecipient` is a token account, never a wallet
 *
 * Circle enforces `recipient_token_account.key() == mint_recipient`. A burn addressed to a
 * wallet can only ever be satisfied by a token account at that exact address, which for a
 * normal keypair address means it can never be minted. That mistake stranded a real mainnet
 * transfer during development, and it is why `apps/web` derives the associated token account
 * before burning rather than passing through whatever the user typed.
 */

export const MESSAGE_TRANSMITTER_V2 = new PublicKey(
  "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
);
export const TOKEN_MESSENGER_MINTER_V2 = new PublicKey(
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
);
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * CCTP V2 message header offsets. Verified empirically: slicing [12,44) from a real mainnet
 * message reproduced Iris's reported `eventNonce` byte for byte.
 */
const NONCE_START = 12;
const NONCE_END = 44;
const BODY_START = 148;
/** Burn message body is version(4) then burnToken(32). */
const BURN_TOKEN_START = BODY_START + 4;
const BURN_TOKEN_END = BURN_TOKEN_START + 32;

/**
 * Byte offset of `fee_recipient` inside the TokenMessenger account. From the V2 IDL's field
 * order: 8 discriminator + denylister(32) + owner(32) + pending_owner(32) +
 * message_body_version(4) + authority_bump(1).
 */
const FEE_RECIPIENT_OFFSET = 109;

const pda = (seeds: Buffer[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];
const utf8 = (s: string) => Buffer.from(s, "utf8");

/**
 * Anchor's instruction discriminator for `receive_message`: the first 8 bytes of
 * sha256("global:receive_message").
 *
 * Precomputed rather than hashed at call time so this module runs in a browser. It used to call
 * `node:crypto`, which is the only thing that stopped the self-serve claim page from building the
 * same instruction the relay does — and building a second, subtly different one for the browser is
 * how the two drift apart.
 *
 * A constant is only safe if it is checked, so `receive-message.test.ts` recomputes the hash and
 * asserts this matches. The value cannot change unless Circle renames the instruction, at which
 * point the account layout has changed too and the test failing is the correct outcome.
 */
export const RECEIVE_MESSAGE_DISCRIMINATOR = Buffer.from("26907fe11fe1ee19", "hex");

/** Borsh `Vec<u8>`: u32 little-endian length prefix, then the bytes. */
function borshBytes(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM);
}

export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

export interface ReceiveMessageConfig {
  /** Local USDC mint on the destination chain. */
  usdcMint: PublicKey;
  /** CCTP domain of the *source* chain — 27 for Stellar. Seeds several PDAs. */
  sourceDomain: number;
}

/**
 * Creates the recipient's associated token account if it does not exist.
 *
 * # Why this is a separate transaction
 *
 * `receiveMessage` serialises to 1224 of Solana's 1232 permitted bytes — the message and
 * attestation alone are ~506 bytes and it takes 20 account keys. There is no room to append
 * an ATA creation, so it has to be its own transaction.
 *
 * # Why the relay pays
 *
 * Creating an ATA is permissionless: the owner never signs, only the payer does. That is what
 * makes it possible to deliver to an exchange deposit address whose key nobody here will ever
 * have. The ~0.002 SOL rent is **not recoverable** — `CloseAccount` requires the owner's
 * signature, and an ATA has no close authority — so it is a permanent, once-per-recipient
 * cost that belongs in the fee floor.
 */
export async function ensureRecipientTokenAccount(
  connection: Connection,
  payer: PublicKey,
  ownerOrTokenAccount: PublicKey,
  mint: PublicKey,
): Promise<{ tokenAccount: PublicKey; created: boolean; instruction?: TransactionInstruction }> {
  const existing = await connection.getAccountInfo(ownerOrTokenAccount);
  if (existing && existing.owner.equals(TOKEN_PROGRAM)) {
    // Already a token account — this is the normal path, since apps/web burns to the ATA.
    return { tokenAccount: ownerOrTokenAccount, created: false };
  }

  const ata = associatedTokenAddress(ownerOrTokenAccount, mint);
  const ataInfo = await connection.getAccountInfo(ata);
  if (ataInfo) return { tokenAccount: ata, created: false };

  // CreateIdempotent (instruction 1) rather than Create (0): two relay workers racing the
  // same job must not fail each other, and a retry after a timeout must be harmless.
  const instruction = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: ownerOrTokenAccount, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

  return { tokenAccount: ata, created: true, instruction };
}

/**
 * Assembles `receiveMessage`. `recipientTokenAccount` must equal the message's
 * `mintRecipient`; Circle rejects anything else with `InvalidMintRecipient`.
 */
export async function buildReceiveMessageInstruction(
  connection: Connection,
  /** The account that will sign and pay. A `PublicKey`, not a `Keypair`: the relay holds a key
   *  and a browser wallet does not, and only the public key is needed to build the instruction —
   *  signing happens later, wherever the key actually lives. */
  payer: PublicKey,
  messageHex: string,
  attestationHex: string,
  config: ReceiveMessageConfig,
): Promise<TransactionInstruction> {
  const message = hexToBuffer(messageHex);
  const attestation = hexToBuffer(attestationHex);
  const nonce = message.subarray(NONCE_START, NONCE_END);
  const burnToken = message.subarray(BURN_TOKEN_START, BURN_TOKEN_END);
  const mintRecipient = new PublicKey(message.subarray(BODY_START + 36, BODY_START + 68));

  const domain = String(config.sourceDomain);
  const mint = config.usdcMint;

  const messageTransmitter = pda([utf8("message_transmitter")], MESSAGE_TRANSMITTER_V2);
  const authorityPda = pda(
    [utf8("message_transmitter_authority"), TOKEN_MESSENGER_MINTER_V2.toBuffer()],
    MESSAGE_TRANSMITTER_V2,
  );
  const usedNonce = pda([utf8("used_nonce"), nonce], MESSAGE_TRANSMITTER_V2);
  const mtEventAuthority = pda([utf8("__event_authority")], MESSAGE_TRANSMITTER_V2);

  const tokenMessenger = pda([utf8("token_messenger")], TOKEN_MESSENGER_MINTER_V2);
  const remoteTokenMessenger = pda(
    [utf8("remote_token_messenger"), utf8(domain)],
    TOKEN_MESSENGER_MINTER_V2,
  );
  const tokenMinter = pda([utf8("token_minter")], TOKEN_MESSENGER_MINTER_V2);
  const localToken = pda([utf8("local_token"), mint.toBuffer()], TOKEN_MESSENGER_MINTER_V2);
  const tokenPair = pda(
    [utf8("token_pair"), utf8(domain), burnToken],
    TOKEN_MESSENGER_MINTER_V2,
  );
  const custodyTokenAccount = pda([utf8("custody"), mint.toBuffer()], TOKEN_MESSENGER_MINTER_V2);
  const tmmEventAuthority = pda([utf8("__event_authority")], TOKEN_MESSENGER_MINTER_V2);

  const tmInfo = await connection.getAccountInfo(tokenMessenger);
  if (!tmInfo) throw new Error("TokenMessenger account not found — wrong program id or cluster.");
  const feeRecipient = new PublicKey(
    tmInfo.data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32),
  );

  return new TransactionInstruction({
    programId: MESSAGE_TRANSMITTER_V2,
    data: Buffer.concat([
      RECEIVE_MESSAGE_DISCRIMINATOR,
      borshBytes(message),
      borshBytes(attestation),
    ]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: authorityPda, isSigner: false, isWritable: false },
      { pubkey: messageTransmitter, isSigner: false, isWritable: false },
      { pubkey: usedNonce, isSigner: false, isWritable: true },
      { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mtEventAuthority, isSigner: false, isWritable: false },
      { pubkey: MESSAGE_TRANSMITTER_V2, isSigner: false, isWritable: false },
      // remaining accounts, forwarded to TokenMessengerMinter in IDL order
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
      { pubkey: tokenMinter, isSigner: false, isWritable: false },
      { pubkey: localToken, isSigner: false, isWritable: true },
      { pubkey: tokenPair, isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(feeRecipient, mint), isSigner: false, isWritable: true },
      { pubkey: mintRecipient, isSigner: false, isWritable: true },
      { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tmmEventAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false },
    ],
  });
}

/** Reads the `mintRecipient` a message is addressed to, without submitting anything. */
export function readMintRecipient(messageHex: string): PublicKey {
  const message = hexToBuffer(messageHex);
  return new PublicKey(message.subarray(BODY_START + 36, BODY_START + 68));
}

/** The 32-byte nonce, which seeds `used_nonce` and uniquely identifies the transfer. */
export function readNonce(messageHex: string): Buffer {
  return hexToBuffer(messageHex).subarray(NONCE_START, NONCE_END);
}
