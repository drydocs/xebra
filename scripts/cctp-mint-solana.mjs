#!/usr/bin/env node
/**
 * Completes a CCTP transfer by submitting `receiveMessage` on Solana, minting the USDC that
 * was already burned on Stellar.
 *
 * # Why this exists
 *
 * CCTP is burn + attestation only. Circle runs the attestation service (Iris) and explicitly
 * does **not** run a relayer — their technical guide puts delivery on the integrator: "the API
 * consumer must query this attestation and submit it onchain to the destination domain's
 * MessageTransmitterV2#receiveMessage function." `receiveMessage` is permissionless, so anyone
 * with destination gas can submit it, but nobody is obliged to.
 *
 * This is the one-off form of what `apps/cctp-relay` will do continuously.
 *
 * # Built against CCTP **V2**, not the V1 examples
 *
 * Circle's published `examples/receiveMessage.ts` targets V1. V2 differs in ways that would
 * silently produce a wrong account list:
 *   - different program ids (CCTPV2… rather than CCTPi…/CCTPm…)
 *   - `used_nonce` is seeded by the 32-byte nonce sliced out of the message body, not by a
 *     numeric nonce fetched via `getNoncePda`
 *   - the receiver's account list gains `fee_recipient_token_account`
 *
 * Account layouts here come from the V2 IDLs and program source in circlefin/solana-cctp-
 * contracts, not from the V1 example.
 *
 * # Safety
 *
 * Defaults to a dry run: it derives every account, checks on chain that the ones which must
 * exist do and that `used_nonce` does *not* (its existence means the message was already
 * minted), prints the plan, and stops. Pass --send to actually submit.
 *
 * Usage:
 *   node scripts/cctp-mint-solana.mjs --burn-tx <stellar_tx_hash>            # dry run
 *   node scripts/cctp-mint-solana.mjs --burn-tx <stellar_tx_hash> --send
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "../packages/chain-adapters/node_modules/@solana/web3.js/lib/index.cjs.js";

// --- constants ---------------------------------------------------------------
const MESSAGE_TRANSMITTER_V2 = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
const TOKEN_MESSENGER_MINTER_V2 = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const IRIS = "https://iris-api.circle.com";
const STELLAR_DOMAIN = 27;
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR_PATH ?? ".secrets/solana-relayer.json";

/**
 * CCTP V2 message header offsets, in bytes. Verified against the live message: slicing
 * [12,44) reproduced Iris's reported `eventNonce` exactly.
 */
const NONCE_START = 12;
const NONCE_END = 44;
const BODY_START = 148;
/** Burn message body: version(4) then burnToken(32). */
const BURN_TOKEN_START = BODY_START + 4;
const BURN_TOKEN_END = BURN_TOKEN_START + 32;

// --- helpers -----------------------------------------------------------------
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const utf8 = (s) => Buffer.from(s, "utf8");

/** Anchor's instruction discriminator: first 8 bytes of sha256("global:<snake_case_name>"). */
function discriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Borsh `Vec<u8>`: u32 little-endian length, then the bytes. */
function borshBytes(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function associatedTokenAddress(owner, mint) {
  return pda(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const burnTx = arg("--burn-tx");
  const send = process.argv.includes("--send");
  if (!burnTx) {
    console.error("usage: node scripts/cctp-mint-solana.mjs --burn-tx <stellar_tx_hash> [--send]");
    process.exit(2);
  }

  // --- 1. attestation ---------------------------------------------------------
  console.log(`Fetching attestation for burn ${burnTx} …`);
  const res = await fetch(`${IRIS}/v2/messages/${STELLAR_DOMAIN}?transactionHash=${burnTx}`);
  const body = await res.json();
  const msg = body?.messages?.[0];
  if (!msg) throw new Error(`Iris returned no message: ${JSON.stringify(body)}`);
  if (msg.status !== "complete") {
    throw new Error(`Attestation is "${msg.status}", not complete. Wait and retry.`);
  }

  const message = Buffer.from(msg.message.replace(/^0x/, ""), "hex");
  const attestation = Buffer.from(msg.attestation.replace(/^0x/, ""), "hex");
  const nonce = message.subarray(NONCE_START, NONCE_END);
  const burnToken = message.subarray(BURN_TOKEN_START, BURN_TOKEN_END);

  const decoded = msg.decodedMessage ?? {};
  const decodedBody = decoded.decodedMessageBody ?? {};
  // `mintRecipient` IS the token account — Circle enforces
  // recipient_token_account.key() == mint_recipient. Deriving an ATA from it would produce
  // the ATA *of a token account*, which is meaningless and fails that check.
  const recipientTokenAccount = new PublicKey(decodedBody.mintRecipient);

  console.log(`  status ${msg.status}, amount ${decodedBody.amount}, fee ${decodedBody.feeExecuted}`);
  console.log(`  domain ${decoded.sourceDomain} -> ${decoded.destinationDomain}`);
  console.log(`  recipient token account ${recipientTokenAccount.toBase58()}`);
  if (!nonce.equals(Buffer.from(msg.eventNonce.replace(/^0x/, ""), "hex"))) {
    throw new Error("Sliced nonce does not match Iris's eventNonce — message layout is wrong.");
  }

  const connection = new Connection(RPC, "confirmed");

  // --- 2. derive accounts -----------------------------------------------------
  const messageTransmitter = pda([utf8("message_transmitter")], MESSAGE_TRANSMITTER_V2);
  const authorityPda = pda(
    [utf8("message_transmitter_authority"), TOKEN_MESSENGER_MINTER_V2.toBuffer()],
    MESSAGE_TRANSMITTER_V2,
  );
  const usedNonce = pda([utf8("used_nonce"), nonce], MESSAGE_TRANSMITTER_V2);
  const mtEventAuthority = pda([utf8("__event_authority")], MESSAGE_TRANSMITTER_V2);

  const tokenMessenger = pda([utf8("token_messenger")], TOKEN_MESSENGER_MINTER_V2);
  const remoteTokenMessenger = pda(
    [utf8("remote_token_messenger"), utf8(String(STELLAR_DOMAIN))],
    TOKEN_MESSENGER_MINTER_V2,
  );
  const tokenMinter = pda([utf8("token_minter")], TOKEN_MESSENGER_MINTER_V2);
  const localToken = pda([utf8("local_token"), USDC_MINT.toBuffer()], TOKEN_MESSENGER_MINTER_V2);
  const tokenPair = pda(
    [utf8("token_pair"), utf8(String(STELLAR_DOMAIN)), burnToken],
    TOKEN_MESSENGER_MINTER_V2,
  );
  const custodyTokenAccount = pda(
    [utf8("custody"), USDC_MINT.toBuffer()],
    TOKEN_MESSENGER_MINTER_V2,
  );
  const tmmEventAuthority = pda([utf8("__event_authority")], TOKEN_MESSENGER_MINTER_V2);

  // fee_recipient lives inside the TokenMessenger account. Layout from the V2 IDL:
  // 8 discriminator + denylister(32) + owner(32) + pending_owner(32) + message_body_version(4)
  // + authority_bump(1) = 109.
  const tmInfo = await connection.getAccountInfo(tokenMessenger);
  if (!tmInfo) throw new Error("TokenMessenger account not found — wrong program id?");
  const feeRecipient = new PublicKey(tmInfo.data.subarray(109, 141));
  const feeRecipientTokenAccount = associatedTokenAddress(feeRecipient, USDC_MINT);

  // --- 3. verify on chain -----------------------------------------------------
  const mustExist = {
    messageTransmitter,
    authorityPda: null, // authority PDA is not an initialised account
    tokenMessenger,
    remoteTokenMessenger,
    tokenMinter,
    localToken,
    tokenPair,
    custodyTokenAccount,
    recipientTokenAccount,
    feeRecipientTokenAccount,
  };

  console.log("\nDerived accounts:");
  let problems = 0;
  for (const [name, key] of Object.entries(mustExist)) {
    if (key === null) continue;
    const info = await connection.getAccountInfo(key);
    const ok = info !== null;
    if (!ok) problems++;
    console.log(`  ${ok ? "ok  " : "MISSING"} ${name.padEnd(26)} ${key.toBase58()}`);
  }
  console.log(`  ---  ${"authorityPda".padEnd(26)} ${authorityPda.toBase58()}`);

  const usedInfo = await connection.getAccountInfo(usedNonce);
  if (usedInfo) {
    console.log(`\nAlready minted: used_nonce ${usedNonce.toBase58()} exists.`);
    console.log("This message has been consumed. Nothing to do.");
    return;
  }
  console.log(`  new  ${"usedNonce".padEnd(26)} ${usedNonce.toBase58()} (created by this tx)`);

  if (problems > 0) {
    throw new Error(`${problems} required account(s) missing — refusing to build a transaction.`);
  }

  // --- 4. build the instruction ----------------------------------------------
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))),
  );
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`\nPayer ${payer.publicKey.toBase58()}  balance ${(balance / 1e9).toFixed(6)} SOL`);

  const data = Buffer.concat([
    discriminator("receive_message"),
    borshBytes(message),
    borshBytes(attestation),
  ]);

  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // caller
    { pubkey: authorityPda, isSigner: false, isWritable: false },
    { pubkey: messageTransmitter, isSigner: false, isWritable: false },
    { pubkey: usedNonce, isSigner: false, isWritable: true },
    { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false }, // receiver
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: mtEventAuthority, isSigner: false, isWritable: false },
    { pubkey: MESSAGE_TRANSMITTER_V2, isSigner: false, isWritable: false }, // program
    // remaining accounts, forwarded to the TokenMessengerMinter receiver in IDL order
    { pubkey: tokenMessenger, isSigner: false, isWritable: false },
    { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
    { pubkey: tokenMinter, isSigner: false, isWritable: false },
    { pubkey: localToken, isSigner: false, isWritable: true },
    { pubkey: tokenPair, isSigner: false, isWritable: false },
    { pubkey: feeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: tmmEventAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId: MESSAGE_TRANSMITTER_V2, keys, data });
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  console.log(
    `  tx size: ${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length} / 1232 bytes`,
  );

  if (!send) {
    console.log("\nDry run — simulating (no SOL spent, nothing submitted).");
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.error("\nSIMULATION FAILED:", JSON.stringify(sim.value.err));
      console.error((sim.value.logs ?? []).slice(-25).join("\n"));
      process.exit(1);
    }
    console.log("Simulation OK. Units consumed:", sim.value.unitsConsumed);
    console.log("\nRe-run with --send to submit.");
    return;
  }

  if (balance === 0) throw new Error(`Payer ${payer.publicKey.toBase58()} has no SOL.`);

  console.log("\nSubmitting …");
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`\nMinted. Signature: ${sig}`);
  console.log(`  https://solscan.io/tx/${sig}`);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message ?? err);
  process.exit(1);
});
