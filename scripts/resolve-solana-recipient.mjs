#!/usr/bin/env node
/**
 * Prints, for a Solana wallet address, what the wrapper needs to send it USDC:
 *   <owner hex> <USDC token account hex> <exists true|false> <token account base58>
 *
 * The token account is derived (the associated token account of the wallet for mainnet USDC) and looked up
 * on chain. If it exists it must be owned by this wallet and hold USDC, or this exits non-zero: sending to a
 * token account that belongs to someone else is not a mistake worth surfacing later.
 *
 * Usage: node scripts/resolve-solana-recipient.mjs <wallet>
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "apps/web/package.json"));
const { PublicKey, Connection } = require("@solana/web3.js");

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

try {
  const owner = new PublicKey(process.argv[2] ?? "");
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error("that is not a wallet address (it is off the ed25519 curve)");
  }
  const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), USDC.toBuffer()], ATA);
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const info = await conn.getParsedAccountInfo(ata);
  const parsed = info.value?.data?.parsed?.info;
  if (info.value && (!parsed || parsed.owner !== owner.toBase58() || parsed.mint !== USDC.toBase58())) {
    throw new Error("the derived token account exists but is not this wallet's USDC account");
  }
  const hex = (k) => Buffer.from(k.toBytes()).toString("hex");
  console.log(hex(owner), hex(ata), info.value ? "true" : "false", ata.toBase58());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
