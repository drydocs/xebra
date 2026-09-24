#!/usr/bin/env node
/**
 * Moves every token and all SOL out of the two leftover Solana wallets into one destination.
 *
 * Default is a DRY RUN: it reads chain state, builds the transactions, SIMULATES them, and prints
 * the plan. It sends nothing. To send, set CONFIRM to the exact sentence the plan ends with.
 *
 * Wallets swept (both are ours, keys in the git-ignored .secrets/):
 *   - the relay hot wallet:  .secrets/solana-relayer.json
 *   - the test wallet:       .secrets/mainnet-test-wallets/solana-fresh-1.json
 *
 * What it does, and why in this order:
 *   1. Lists every token account each wallet owns, under both token programs, so nothing is missed
 *      by looking only at USDC.
 *   2. For each token with a balance, transfers it (`transfer_checked`, so a wrong mint or decimals
 *      fails on chain) to the DESTINATION's token account for that mint. That account must already
 *      exist: this script does not create accounts, because creating one on someone else's behalf
 *      costs rent nobody gets back.
 *   3. Closes each emptied token account, returning its rent to the destination.
 *   4. Last, sends the relay wallet's remaining SOL, less the fee for that very transaction. The
 *      relay wallet is the fee payer for everything, so the test wallet (which holds no SOL) can be
 *      emptied without being funded first.
 *
 * Safety:
 *   - the destination is pinned below and every token account is checked on chain: owned by that
 *     wallet, right mint, before anything is built;
 *   - every transaction is simulated first, and a failed simulation aborts the run;
 *   - nothing here prints a secret key.
 *
 * Usage:
 *   node scripts/sweep-solana.mjs
 *   CONFIRM="send the Solana plan above" node scripts/sweep-solana.mjs
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// @solana/web3.js is a dependency of apps/web, not of the repo root.
const require = createRequire(resolve(ROOT, "apps/web/package.json"));
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const DESTINATION = new PublicKey("2GiJjxyCM296G3aAxrz826m8JZjeoqMAKuushBE19ouL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdMTaZAcNsoEiGY6TApEvZyjmCTkfHSdRwSpb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SENTENCE = "send the Solana plan above";
const FEE_PER_SIGNATURE = 5000n;

const conn = new Connection(RPC, "confirmed");
const die = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(ROOT, p), "utf8"))));

const relayer = load(".secrets/solana-relayer.json");
const test = load(".secrets/mainnet-test-wallets/solana-fresh-1.json");
const wallets = [
  { name: "relay wallet", kp: relayer },
  { name: "test wallet", kp: test },
];
const short = (k) => `${k.toBase58().slice(0, 6)}…${k.toBase58().slice(-4)}`;

const ata = (owner, mint, program) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
const transferChecked = (src, mint, dst, owner, amount, decimals, program) =>
  new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  });
const closeAccount = (acct, dest, owner, program) =>
  new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: acct, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });

// ---- 1. read everything ----------------------------------------------------------------------

const holdings = []; // { wallet, account, mint, amount, decimals, program }
for (const w of wallets) {
  const res = await conn.getParsedTokenAccountsByOwner(w.kp.publicKey, { programId: TOKEN_PROGRAM });
  for (const { pubkey, account } of res.value) {
    const info = account.data.parsed.info;
    holdings.push({
      wallet: w,
      account: pubkey,
      mint: new PublicKey(info.mint),
      amount: BigInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
      ui: info.tokenAmount.uiAmountString,
      program: TOKEN_PROGRAM,
    });
  }
  // The public RPC rejects the token-account filter for Token-2022 (INVALID_PARAMS), so ask for the
  // accounts by owner offset instead. This script does not move Token-2022 tokens (extensions can
  // change the transfer rules), so finding one is a stop, not something to skip past.
  const t22 = await conn.getProgramAccounts(TOKEN_2022_PROGRAM, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: 32, bytes: w.kp.publicKey.toBase58() } }],
  });
  if (t22.length) die(`${w.name} owns ${t22.length} Token-2022 account(s); this script does not handle them`);
}

console.log(`destination  ${DESTINATION.toBase58()}`);
console.log();
const lamports = {};
for (const w of wallets) {
  lamports[w.name] = BigInt(await conn.getBalance(w.kp.publicKey));
  console.log(`${w.name}  ${w.kp.publicKey.toBase58()}  ${Number(lamports[w.name]) / 1e9} SOL`);
}
for (const h of holdings) {
  console.log(`  token account ${short(h.account)} (${h.wallet.name}): ${h.ui} of mint ${short(h.mint)}`);
}
console.log();

// ---- 2. build the token moves ------------------------------------------------------------------

const txs = []; // { label, tx, signers }
for (const h of holdings) {
  const destAta = ata(DESTINATION, h.mint, h.program);
  const ins = [];
  if (h.amount > 0n) {
    const info = await conn.getParsedAccountInfo(destAta);
    const parsed = info.value?.data?.parsed?.info;
    if (!parsed || parsed.owner !== DESTINATION.toBase58() || parsed.mint !== h.mint.toBase58()) {
      die(
        `the destination has no token account for mint ${h.mint.toBase58()} (expected ${destAta.toBase58()}). ` +
          "This script does not create one: it would cost rent nobody gets back. Create it, or leave that token.",
      );
    }
    ins.push(transferChecked(h.account, h.mint, destAta, h.wallet.kp.publicKey, h.amount, h.decimals, h.program));
  }
  ins.push(closeAccount(h.account, DESTINATION, h.wallet.kp.publicKey, h.program));
  const signers = [relayer, ...(h.wallet.kp === relayer ? [] : [h.wallet.kp])];
  txs.push({
    label: `${h.amount > 0n ? `move ${h.ui} then ` : ""}close ${short(h.account)} (${h.wallet.name}), rent to destination`,
    ins,
    signers,
  });
}

const build = async (ins, signers) => {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: relayer.publicKey, blockhash, lastValidBlockHeight });
  tx.add(...ins);
  tx.sign(...signers);
  return { tx, lastValidBlockHeight };
};

// ---- 3. the SOL move is planned from what is left after the token transactions -----------------

let feesForTokenTxs = 0n;
for (const t of txs) feesForTokenTxs += FEE_PER_SIGNATURE * BigInt(t.signers.length);
// Closing the test wallet's account returns rent to the DESTINATION, not to the relay wallet, so the
// relay wallet's SOL after the token moves is exactly its balance minus those fees.
const relayerAfter = lamports["relay wallet"] - feesForTokenTxs;
const solSend = relayerAfter - FEE_PER_SIGNATURE;

if (solSend > 0n) {
  txs.push({
    label: `send the relay wallet's remaining SOL (${Number(solSend) / 1e9}), leaving it at zero`,
    ins: [SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: DESTINATION, lamports: solSend })],
    signers: [relayer],
  });
}

// ---- 4. simulate everything --------------------------------------------------------------------

console.log("plan:");
let n = 0;
for (const t of txs) {
  n++;
  console.log(`  ${n}. ${t.label}`);
}
console.log();

if (!txs.length) {
  console.log("nothing to send");
  process.exit(0);
}

for (const [i, t] of txs.entries()) {
  const isSol = t.ins.length === 1 && t.ins[0].programId.equals(SystemProgram.programId);
  // The real SOL amount is only known once the earlier fees are paid, so simulate it now as "the
  // whole current balance minus this transaction's fee", which is the same shape: it leaves the
  // relay wallet at exactly zero, and it pays enough to make the destination rent-exempt. (A dust
  // amount would fail here, and only here, because the destination wallet holds no SOL yet.)
  const ins = isSol
    ? [
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: DESTINATION,
          lamports: lamports["relay wallet"] - FEE_PER_SIGNATURE,
        }),
      ]
    : t.ins;
  const { tx } = await build(ins, t.signers);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) die(`simulation of step ${i + 1} failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  console.log(`  step ${i + 1} simulates OK`);
}
console.log();

if (process.env.CONFIRM !== SENTENCE) {
  console.log(`Confirm by re-running with CONFIRM="${SENTENCE}"`);
  console.log("(dry run: nothing sent)");
  process.exit(0);
}

// ---- 5. send, one at a time, in order ----------------------------------------------------------

for (const [i, t] of txs.entries()) {
  const isSol = t.ins.length === 1 && t.ins[0].programId.equals(SystemProgram.programId);
  let ins = t.ins;
  if (isSol) {
    // Recompute from the live balance now that the earlier fees are actually paid.
    const now = BigInt(await conn.getBalance(relayer.publicKey));
    const amount = now - FEE_PER_SIGNATURE;
    if (amount <= 0n) {
      console.log(`  step ${i + 1}: nothing left to send`);
      continue;
    }
    ins = [SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: DESTINATION, lamports: amount })];
  }
  const { tx, lastValidBlockHeight } = await build(ins, t.signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) die(`step ${i + 1} failed on chain: ${JSON.stringify(res.value.err)} (${sig})`);
  console.log(`  step ${i + 1} confirmed  ${sig}`);
}

console.log();
for (const w of wallets) console.log(`${w.name} now holds ${Number(await conn.getBalance(w.kp.publicKey)) / 1e9} SOL`);
