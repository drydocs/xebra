import {
  Connection,
  type Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { MintSubmitter } from "@xebra/cctp-client";
import { decodeRelayKeypair } from "./decode-keypair.js";
import {
  buildReceiveMessageInstruction,
  ensureRecipientTokenAccount,
  readMintRecipient,
} from "./receive-message.js";

/**
 * Submits the destination-chain mint for a CCTP transfer.
 *
 * # Simulate before every submit
 *
 * A failed Solana transaction still charges its fee; a failed *simulation* charges nothing.
 * Every mint is simulated first and abandoned on failure, so a systematically broken job —
 * a wrong account, an already-consumed nonce, a recipient that cannot receive — costs the
 * relay zero rather than one fee per retry. This is not belt-and-braces: it is how the
 * `InvalidMintRecipient` bug was found during development without spending anything.
 *
 * # Two transactions, not one
 *
 * `receiveMessage` serialises to 1224 of the 1232 bytes Solana permits — the message and
 * attestation are ~506 bytes and the instruction takes 20 account keys. Creating a recipient
 * token account cannot be appended to it, so when the recipient is new that happens first, in
 * its own transaction.
 *
 * # The real cost of a mint is rent, not fees
 *
 *   used_nonce rent      ~867,621 lamports   every transfer, permanent
 *   token account rent  ~2,039,280 lamports  first-time recipients only, permanent
 *   transaction fee          ~5,000 lamports
 *
 * The rent dwarfs the fee by more than two orders of magnitude and none of it is recoverable:
 * `used_nonce` is replay protection that must live forever, and closing a token account needs
 * the *owner's* signature, which the relay will never have. Both belong in the fee floor.
 */
/** Solana's hard packet limit. `receiveMessage` sits 8 bytes under it. */
const MAX_TRANSACTION_BYTES = 1232;

export function createSolanaMintSubmitter(
  connection: Connection,
  payer: Keypair,
  usdcMint: PublicKey,
  sourceDomain: number,
): MintSubmitter {
  return {
    async submitReceiveMessage(message, attestation) {
      // The message names a token account, not a wallet — Circle enforces
      // recipient_token_account.key() == mint_recipient.
      const mintRecipient = readMintRecipient(message);

      const recipient = await ensureRecipientTokenAccount(
        connection,
        payer.publicKey,
        mintRecipient,
        usdcMint,
      );

      if (recipient.created && recipient.instruction) {
        const createTx = new Transaction().add(recipient.instruction);
        const sim = await connection.simulateTransaction(
          await withBlockhash(connection, createTx, payer),
        );
        if (sim.value.err) {
          throw new Error(
            `Creating the recipient token account would fail: ${JSON.stringify(sim.value.err)}`,
          );
        }
        await sendAndConfirmTransaction(connection, createTx, [payer], {
          commitment: "confirmed",
        });
      }

      const ix = await buildReceiveMessageInstruction(
        connection,
        payer.publicKey,
        message,
        attestation,
        {
          usdcMint,
          sourceDomain,
        },
      );

      // No compute-budget instruction, and that is forced rather than chosen.
      //
      // `receiveMessage` alone serialises to 1224 bytes against Solana's 1232-byte limit — 8
      // bytes of headroom. `setComputeUnitLimit` adds the ComputeBudget program id to the
      // account table (32 bytes) plus a compiled instruction (8), landing at exactly 1264 and
      // failing with `Transaction too large: 1264 > 1232`. That is not a tunable margin; there
      // is no room for any additional instruction at all.
      //
      // So the mint relies on the 200,000-unit default. Measured consumption on a real mainnet
      // mint was 185,553 units, which leaves about 7% of headroom. If Circle's program ever
      // costs more than that, the fix is an address lookup table — it replaces each 32-byte
      // account key with a one-byte index and would free hundreds of bytes — not a compute
      // budget instruction, which cannot fit.
      const tx = new Transaction().add(ix);

      const prepared = await withBlockhash(connection, tx, payer);

      // Checked before simulating, because an oversize transaction fails with a message about
      // bytes that says nothing about which instruction pushed it over.
      const size = prepared.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }).length;
      if (size > MAX_TRANSACTION_BYTES) {
        throw new Error(
          `Mint transaction is ${size} bytes, over Solana's ${MAX_TRANSACTION_BYTES}-byte limit. Nothing was submitted. An address lookup table is the only way to add anything to this transaction.`,
        );
      }
      const sim = await connection.simulateTransaction(prepared);
      if (sim.value.err) {
        throw new Error(
          `Mint simulation failed (nothing submitted, no fee spent): ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-12).join("\n")}`,
        );
      }

      const signature = await sendAndConfirmTransaction(connection, prepared, [payer], {
        commitment: "confirmed",
      });
      return { signature };
    },
  };
}

async function withBlockhash(connection: Connection, tx: Transaction, payer: Keypair) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/**
 * The same submitter from a URL and an encoded secret key, so a caller needs no Solana SDK of
 * its own — a Next.js route handler, in particular, should not have to import `Keypair` and
 * `Connection` just to construct this.
 */
export function createSolanaMintSubmitterFromConfig(config: {
  rpcUrl: string;
  /** Base58, base64, or a `solana-keygen` JSON byte array. */
  secretKey: string;
  usdcMint: string;
  sourceDomainId: number;
}): MintSubmitter {
  return createSolanaMintSubmitter(
    new Connection(config.rpcUrl, "confirmed"),
    decodeRelayKeypair(config.secretKey),
    new PublicKey(config.usdcMint),
    config.sourceDomainId,
  );
}

/** The relay hot wallet's balance, for the "relay SOL low" alert. Here rather than in the
 *  caller so a service that only needs a number does not depend on the Solana SDK. */
export async function getRelayBalanceLamports(config: {
  rpcUrl: string;
  secretKey: string;
}): Promise<number> {
  const { publicKey } = decodeRelayKeypair(config.secretKey);
  return new Connection(config.rpcUrl, "confirmed").getBalance(publicKey);
}
