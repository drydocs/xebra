#!/usr/bin/env node
/**
 * Recovers a CCTP transfer that was burned to a **wallet address** instead of a token account.
 *
 * # The bug this recovers from
 *
 * On Solana, CCTP's `mintRecipient` must be the USDC *token account*, not the wallet. Circle
 * enforces it in `handle_receive_finalized_message`:
 *
 *     require_keys_eq!(recipient_token_account.key(), mint_recipient, InvalidMintRecipient);
 *
 * A burn addressed to a wallet can therefore only ever be satisfied by a token account living
 * at that exact address. That is unusual but possible: the address is an ordinary keypair, and
 * nothing has been created there yet, so a token account can be initialised at it, used, and
 * then closed to free the address again.
 *
 * # Why three transactions
 *
 * The obvious approach is one atomic transaction doing create -> init -> mint -> sweep ->
 * close. It does not fit: `receiveMessage` alone carries a 376-byte message and a 130-byte
 * attestation, and with 20 account keys the transaction floors at ~1362 bytes against
 * Solana's 1232-byte limit.
 *
 * So it is split. The failure modes are all recoverable, and the ordering is chosen so that
 * the irreversible step happens only after the account it needs exists:
 *
 *   step1  create + initialise the token account at the stranded address   [wallet + relayer]
 *   step2  receiveMessage — mints the USDC into it                         [relayer only]
 *   step3  sweep to the real ATA, then close and refund the rent           [wallet]
 *
 * If step 1 lands and step 2 never runs, the only cost is rent locked in an empty token
 * account, which step 3 refunds. Nothing here can destroy funds that are not already stranded.
 *
 * # Signing
 *
 * Steps 1 and 3 need a signature from the stranded address, which lives in the user's wallet.
 * This script partially signs with the relayer where needed and emits base64 transactions for
 * the wallet to countersign. Step 2 the relayer can submit alone.
 *
 * Usage:
 *   node scripts/recover-stranded-mint.mjs --burn-tx <hash> --step 1     # build, print base64
 *   node scripts/recover-stranded-mint.mjs --burn-tx <hash> --step 2 --send
 *   node scripts/recover-stranded-mint.mjs --burn-tx <hash> --step 3
 *   node scripts/recover-stranded-mint.mjs --burn-tx <hash> --submit <signed_base64>
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "../packages/chain-adapters/node_modules/@solana/web3.js/lib/index.cjs.js";

const MESSAGE_TRANSMITTER_V2 = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
const TOKEN_MESSENGER_MINTER_V2 = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const IRIS = "https://iris-api.circle.com";
const STELLAR_DOMAIN = 27;
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR_PATH ?? ".secrets/solana-relayer.json";

const TOKEN_ACCOUNT_SIZE = 165;
const NONCE_START = 12;
const NONCE_END = 44;
const BODY_START = 148;
const BURN_TOKEN_START = BODY_START + 4;
const BURN_TOKEN_END = BURN_TOKEN_START + 32;

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const utf8 = (s) => Buffer.from(s, "utf8");
const discriminator = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function borshBytes(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

const ata = (owner, mint) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

// --- SPL Token instructions, hand-built to avoid another dependency -----------

/** InitializeAccount3 (index 18): sets the owner without needing the rent sysvar. */
function initializeAccount3(account, mint, owner) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]),
  });
}

/** TransferChecked (index 12). Checked rather than plain Transfer so a wrong mint or decimals
 *  fails loudly instead of moving the wrong token. */
function transferChecked(source, mint, destination, authority, amount, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** CloseAccount (index 9): frees the address and refunds rent to `destination`. */
function closeAccount(account, destination, authority) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

// --- shared setup -------------------------------------------------------------

async function loadContext(burnTx) {
  const res = await fetch(`${IRIS}/v2/messages/${STELLAR_DOMAIN}?transactionHash=${burnTx}`);
  const body = await res.json();
  const msg = body?.messages?.[0];
  if (!msg) throw new Error(`Iris returned no message: ${JSON.stringify(body)}`);
  if (msg.status !== "complete") throw new Error(`Attestation is "${msg.status}", not complete.`);

  const message = Buffer.from(msg.message.replace(/^0x/, ""), "hex");
  const attestation = Buffer.from(msg.attestation.replace(/^0x/, ""), "hex");
  const nonce = message.subarray(NONCE_START, NONCE_END);
  const burnToken = message.subarray(BURN_TOKEN_START, BURN_TOKEN_END);
  const decodedBody = msg.decodedMessage?.decodedMessageBody ?? {};

  /** The address the burn named. Stranded precisely because it is a wallet, not a token
   *  account — the whole reason this script exists. */
  const stranded = new PublicKey(decodedBody.mintRecipient);
  const amount = BigInt(decodedBody.amount);

  const connection = new Connection(RPC, "confirmed");
  const relayer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8"))),
  );

  return { message, attestation, nonce, burnToken, stranded, amount, connection, relayer };
}

function receiveMessageIx(ctx) {
  const { message, attestation, nonce, burnToken, stranded, relayer } = ctx;

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

  return {
    usedNonce,
    tokenMessenger,
    ix: (feeRecipientTokenAccount) =>
      new TransactionInstruction({
        programId: MESSAGE_TRANSMITTER_V2,
        data: Buffer.concat([
          discriminator("receive_message"),
          borshBytes(message),
          borshBytes(attestation),
        ]),
        keys: [
          { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
          { pubkey: authorityPda, isSigner: false, isWritable: false },
          { pubkey: messageTransmitter, isSigner: false, isWritable: false },
          { pubkey: usedNonce, isSigner: false, isWritable: true },
          { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: mtEventAuthority, isSigner: false, isWritable: false },
          { pubkey: MESSAGE_TRANSMITTER_V2, isSigner: false, isWritable: false },
          { pubkey: tokenMessenger, isSigner: false, isWritable: false },
          { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
          { pubkey: tokenMinter, isSigner: false, isWritable: false },
          { pubkey: localToken, isSigner: false, isWritable: true },
          { pubkey: tokenPair, isSigner: false, isWritable: false },
          { pubkey: feeRecipientTokenAccount, isSigner: false, isWritable: true },
          // The stranded address itself, now a token account — this is what makes the
          // recipient_token_account == mint_recipient check pass.
          { pubkey: stranded, isSigner: false, isWritable: true },
          { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: tmmEventAuthority, isSigner: false, isWritable: false },
          { pubkey: TOKEN_MESSENGER_MINTER_V2, isSigner: false, isWritable: false },
        ],
      }),
  };
}

async function withBlockhash(connection, tx, feePayer) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

function report(tx, label) {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  console.log(`\n${label}`);
  console.log(`  size ${bytes} / 1232 bytes${bytes > 1232 ? "  <-- TOO LARGE" : ""}`);
  console.log("\n  base64 (for the wallet to countersign):\n");
  console.log(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  );
}

// --- steps --------------------------------------------------------------------

async function step1(ctx) {
  const { connection, relayer, stranded } = ctx;

  const existing = await connection.getAccountInfo(stranded);
  if (existing) {
    console.log(`\n${stranded.toBase58()} already exists (owner ${existing.owner.toBase58()}).`);
    console.log("Step 1 is already done, or the address is no longer free. Skip to step 2.");
    return;
  }

  const rent = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
  const balance = await connection.getBalance(relayer.publicKey);
  const floor = await connection.getMinimumBalanceForRentExemption(0);
  const needed = rent + floor + 5000;

  console.log(`Relayer   ${relayer.publicKey.toBase58()}`);
  console.log(`  balance ${balance} lamports`);
  console.log(`  needed  ${needed} lamports for this step (${rent} of it refunded at step 3)`);
  if (balance < needed) {
    throw new Error(
      `Relayer is short ${needed - balance} lamports (${((needed - balance) / 1e9).toFixed(6)} SOL).`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: relayer.publicKey,
      newAccountPubkey: stranded,
      lamports: rent,
      space: TOKEN_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM,
    }),
    // Owner is the stranded address itself, so the same wallet key can sweep and close it.
    initializeAccount3(stranded, USDC_MINT, stranded),
  );
  await withBlockhash(connection, tx, relayer.publicKey);
  tx.partialSign(relayer);
  report(tx, `STEP 1 — create + initialise token account at ${stranded.toBase58()}`);
  console.log(`\n  Needs one more signature: ${stranded.toBase58()} (your wallet).`);
}

async function step2(ctx, send) {
  const { connection, relayer, stranded } = ctx;

  const acct = await connection.getAccountInfo(stranded);
  if (!acct) throw new Error("Step 1 has not run — the token account does not exist yet.");
  if (!acct.owner.equals(TOKEN_PROGRAM)) {
    throw new Error(
      `${stranded.toBase58()} is not a token account (owner ${acct.owner.toBase58()}).`,
    );
  }

  const built = receiveMessageIx(ctx);
  const used = await connection.getAccountInfo(built.usedNonce);
  if (used) {
    console.log("\nAlready minted — used_nonce exists. Skip to step 3.");
    return;
  }

  const tmInfo = await connection.getAccountInfo(built.tokenMessenger);
  const feeRecipient = new PublicKey(tmInfo.data.subarray(109, 141));
  const feeRecipientTokenAccount = ata(feeRecipient, USDC_MINT);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(built.ix(feeRecipientTokenAccount));
  await withBlockhash(connection, tx, relayer.publicKey);
  tx.sign(relayer);

  const bytes = tx.serialize().length;
  console.log(`\nSTEP 2 — receiveMessage  (size ${bytes} / 1232)`);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("SIMULATION FAILED:", JSON.stringify(sim.value.err));
    console.error((sim.value.logs ?? []).slice(-20).join("\n"));
    process.exit(1);
  }
  console.log(`  simulation OK, ${sim.value.unitsConsumed} compute units`);

  if (!send) {
    console.log("\n  Re-run with --send to submit.");
    return;
  }
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`\n  Minted. https://solscan.io/tx/${sig}`);
}

async function step3(ctx) {
  const { connection, relayer, stranded, amount } = ctx;

  const acct = await connection.getAccountInfo(stranded);
  if (!acct) throw new Error("Nothing to sweep — the token account does not exist.");

  const destination = ata(stranded, USDC_MINT);
  const destInfo = await connection.getAccountInfo(destination);
  if (!destInfo) {
    throw new Error(
      `Destination ATA ${destination.toBase58()} does not exist. Create it before sweeping.`,
    );
  }

  const tx = new Transaction().add(
    transferChecked(stranded, USDC_MINT, destination, stranded, amount, 6),
    // Rent goes back to the relayer, which paid it in step 1.
    closeAccount(stranded, relayer.publicKey, stranded),
  );
  await withBlockhash(connection, tx, relayer.publicKey);
  tx.partialSign(relayer);
  report(tx, `STEP 3 — sweep ${amount} to ${destination.toBase58()}, then close`);
  console.log(`\n  Needs one more signature: ${stranded.toBase58()} (your wallet).`);
}

async function submit(ctx, b64) {
  const { connection } = ctx;
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`Submitted. https://solscan.io/tx/${sig}`);
}

async function main() {
  const burnTx = arg("--burn-tx");
  if (!burnTx) {
    console.error("usage: node scripts/recover-stranded-mint.mjs --burn-tx <hash> --step <1|2|3>");
    process.exit(2);
  }
  const ctx = await loadContext(burnTx);
  console.log(`Stranded recipient: ${ctx.stranded.toBase58()}`);
  console.log(`Amount:             ${ctx.amount} (6dp) = ${Number(ctx.amount) / 1e6} USDC`);

  const signed = arg("--submit");
  if (signed) return submit(ctx, signed);

  const step = arg("--step");
  if (step === "1") return step1(ctx);
  if (step === "2") return step2(ctx, process.argv.includes("--send"));
  if (step === "3") return step3(ctx);
  console.error("pass --step 1|2|3 or --submit <base64>");
  process.exit(2);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message ?? err);
  process.exit(1);
});
