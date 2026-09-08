#!/usr/bin/env node
/**
 * Pre-flight for a Stellar -> Solana USDC transfer. Verifies everything that can be checked
 * *before* a burn, because a burn is irreversible and every failure mode found afterwards
 * costs real money.
 *
 * This exists because the first real transfer through this app was stranded by a bug that was
 * fully detectable in advance: the burn named a wallet address where CCTP requires a token
 * account. Every check below corresponds to a failure that has either happened here or was one
 * step away from happening.
 *
 * Usage:
 *   node scripts/preflight-bridge.mjs --to <solana_address> [--amount 1]
 *
 * Exits non-zero if anything would prevent the transfer completing.
 */

import { readFileSync } from "node:fs";
import { PublicKey, Connection } from "../packages/chain-adapters/node_modules/@solana/web3.js/lib/index.cjs.js";

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOROBAN_RPC = "https://mainnet.sorobanrpc.com";
const USDC_SOLANA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATP = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RELAYER_PATH = ".secrets/solana-relayer.json";

/** Rent the relay must hold to complete a mint: its own floor + used_nonce + fee. */
const MINT_COST_LAMPORTS = 810_624 + 867_621 + 5_000;

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  failures++;
};
const warn = (m) => console.log(`  warn  ${m}`);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function sorobanView(contractId, method, args = []) {
  // Read-only simulate via the Soroban RPC's own JSON interface would need XDR assembly, so
  // this shells out to the stellar CLI, which is already a required tool for deploys.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    "stellar",
    [
      "contract", "invoke",
      "--id", contractId,
      "--source-account", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      "--rpc-url", SOROBAN_RPC,
      "--network-passphrase", "Public Global Stellar Network ; September 2015",
      "--send=no",
      "--", method, ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 },
  );
  return out.trim().replace(/^"|"$/g, "");
}

async function main() {
  const to = arg("--to");
  const amountUsdc = Number(arg("--amount", "1"));
  if (!to) {
    console.error("usage: node scripts/preflight-bridge.mjs --to <solana_address> [--amount 1]");
    process.exit(2);
  }

  const stroops = BigInt(Math.round(amountUsdc * 1e7));
  console.log(`Pre-flight: ${amountUsdc} USDC  Stellar -> Solana`);
  console.log(`Destination (as typed): ${to}\n`);

  // --- 1. destination address is well formed --------------------------------
  console.log("Destination");
  let owner;
  try {
    owner = new PublicKey(to);
    if (owner.toBytes().length !== 32) throw new Error("not 32 bytes");
    ok("valid Solana address");
  } catch (err) {
    bad(`not a valid Solana address: ${err.message}`);
    process.exit(1);
  }

  const bytes = owner.toBytes();
  if (bytes.every((b) => b === 0)) bad("all-zero address — nobody controls it");
  else if (bytes.slice(0, 12).every((b) => b === 0)) {
    bad("looks like a left-padded EVM address, not a Solana one");
  } else ok("not an EVM address or the zero address");

  // --- 2. THE check that stranded the first transfer -------------------------
  console.log("\nmintRecipient (this is what the burn will name)");
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_SOLANA.toBuffer()],
    ATP,
  );
  console.log(`  wallet        ${owner.toBase58()}`);
  console.log(`  token account ${ata.toBase58()}   <-- goes in mintRecipient`);
  if (ata.equals(owner)) bad("token account equals the wallet — impossible, derivation is wrong");
  else ok("burn will name the TOKEN ACCOUNT, not the wallet");

  const connection = new Connection(SOLANA_RPC, "confirmed");
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    bad(
      "that token account does not exist yet — CCTP will not create it, so the mint would " +
        "fail. Receive any USDC on Solana with this wallet first.",
    );
  } else if (!ataInfo.owner.equals(TOKEN_PROGRAM)) {
    bad(`account exists but is not a token account (owner ${ataInfo.owner.toBase58()})`);
  } else {
    ok("token account exists and is owned by the SPL Token program");
  }

  // --- 3. Circle can accept the burn -----------------------------------------
  console.log("\nCircle CCTP (Stellar mainnet)");
  const CCTP = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
  const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

  const paused = await sorobanView(CCTP, "paused");
  paused === "false" ? ok("not paused") : bad(`CCTP is paused (${paused})`);

  const maxBurn = BigInt(await sorobanView(CCTP, "get_max_burn_amount_per_message", ["--local_token", USDC_SAC]));
  stroops <= maxBurn
    ? ok(`amount within Circle's per-message cap (${maxBurn} stroops)`)
    : bad(`amount ${stroops} exceeds Circle's cap ${maxBurn}`);

  const minFee = BigInt(await sorobanView(CCTP, "get_min_fee_amount", ["--burn_token", USDC_SAC, "--amount", String(stroops)]));
  ok(`Circle's min fee for this amount: ${minFee} stroops`);

  const remote = await sorobanView(CCTP, "get_remote_token_messenger", ["--domain", "5"]);
  remote && remote !== "null"
    ? ok("Solana (domain 5) is a registered destination")
    : bad("Solana is not registered as a remote domain");

  // --- 4. the relay can pay for the mint --------------------------------------
  console.log("\nRelay (pays the Solana mint)");
  try {
    const kp = JSON.parse(readFileSync(RELAYER_PATH, "utf8"));
    const pub = new PublicKey(Uint8Array.from(kp).slice(32));
    const bal = await connection.getBalance(pub);
    console.log(`  ${pub.toBase58()}  ${bal} lamports`);
    bal >= MINT_COST_LAMPORTS
      ? ok(`enough for the mint (needs ${MINT_COST_LAMPORTS})`)
      : bad(`short ${MINT_COST_LAMPORTS - bal} lamports for the mint`);
  } catch (err) {
    warn(`could not read the relayer key: ${err.message}`);
  }

  // --- 5. decimals ------------------------------------------------------------
  console.log("\nAmount");
  const remainder = stroops % 10n;
  console.log(`  ${stroops} stroops (7dp) -> ${(stroops - remainder) / 10n} canonical (6dp)`);
  remainder === 0n
    ? ok("no dust — the full amount converts cleanly")
    : warn(`${remainder} stroops stay in your wallet (below Solana's smallest USDC unit)`);

  console.log(
    failures === 0
      ? "\nPRE-FLIGHT PASSED — safe to burn.\n"
      : `\nPRE-FLIGHT FAILED — ${failures} problem(s). DO NOT BURN.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPRE-FLIGHT ERROR:", err.message ?? err);
  process.exit(1);
});
