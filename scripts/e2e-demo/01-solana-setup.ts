/**
 * Solana devnet leg of the e2e demo (see README.md in this directory for why this step is
 * currently blocked by devnet's public faucet rate limit, and what it would feed into the
 * Stellar-side script once it can run to completion). Real code, not a stub — creates a genuine
 * SPL mint and funds a solver ATA on devnet, exactly what apps/solver's real fill adapter needs
 * as its own inventory before it can deliver.
 *
 * Run: pnpm --filter @xebra/solver exec tsx ../../scripts/e2e-demo/01-solana-setup.ts
 */
import { writeFileSync } from "node:fs";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC_URL = "https://api.devnet.solana.com";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const solver = Keypair.generate();
  const recipient = Keypair.generate(); // stands in for the user's Solana destAddress

  console.log("solver:", solver.publicKey.toBase58());
  console.log("recipient:", recipient.publicKey.toBase58());

  console.log("requesting devnet airdrop for solver...");
  const airdropSig = await connection.requestAirdrop(solver.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropSig, "confirmed");
  console.log("airdrop confirmed:", airdropSig);

  console.log("creating SPL mint (6 decimals, standing in for a real Solana destination asset)...");
  const mint = await createMint(connection, solver, solver.publicKey, null, 6);
  console.log("mint:", mint.toBase58());

  console.log("minting 1000 units to solver's own ATA (solver inventory)...");
  const solverAta = await getOrCreateAssociatedTokenAccount(
    connection,
    solver,
    mint,
    solver.publicKey,
  );
  await mintTo(connection, solver, mint, solverAta.address, solver, 1_000_000_000n);
  console.log("solver ATA:", solverAta.address.toBase58());

  const out = {
    solverSecretKeyBase64: Buffer.from(solver.secretKey).toString("base64"),
    solverPublicKey: solver.publicKey.toBase58(),
    recipientSecretKeyBase64: Buffer.from(recipient.secretKey).toString("base64"),
    recipientPublicKey: recipient.publicKey.toBase58(),
    mint: mint.toBase58(),
  };
  writeFileSync(new URL("./solana-setup.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("wrote solana-setup.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
