import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  associatedTokenAddress,
  buildReceiveMessageInstruction,
  ensureRecipientTokenAccount,
  readMintRecipient,
  usedNonceAddress,
} from "@xebra/cctp-solana";

/**
 * Completing a transfer from the browser, without us.
 *
 * # Why this exists
 *
 * The product's central claim is that funds cannot hang: once Circle attests a burn, the
 * `(message, attestation)` pair is public and **anyone** can submit `receiveMessage` on Solana to
 * mint to the recipient. Circle's Forwarding Service normally does that and pays the gas.
 *
 * That was true and unusable. If delivery failed, the receipt told the user to keep their hash and
 * wait for a human to run a script — which is not a self-serve path, and it made our uptime the
 * user's risk rather than their convenience. This closes that, and with the relay gone it is the
 * only path for a forward that fails.
 *
 * # It builds the instruction from the shared package
 *
 * `buildReceiveMessageInstruction` from `@xebra/cctp-solana`, unchanged — the one whose account
 * list was verified against Circle's live mainnet programs. A second, browser-specific
 * implementation is how the two quietly diverge, and the divergence would only show up as a
 * failed mainnet transaction.
 *
 * # Two transactions when the recipient has no USDC account
 *
 * `receiveMessage` alone is 1,224 of Solana's 1,232 permitted bytes, so opening the account cannot
 * ride along: together they came to 1,330 and every such claim failed before reaching the chain.
 * The account is opened first, on its own, and the mint is built only once that has confirmed.
 * Opening is idempotent, so a claim interrupted between the two is finished by claiming again.
 *
 * # Who pays
 *
 * The connected wallet: transaction fees, and the 695,960 lamports of permanent `used_nonce` rent,
 * plus 1,488,440 lamports of token-account rent if the recipient has none (both read from mainnet
 * on 2026-10-14). That is the trade — the forwarded version costs the user nothing extra because
 * Circle's delivery fee, taken from the burn, covers it.
 *
 * The payer does **not** have to be the recipient. `receiveMessage` mints to the address the burn
 * named, whoever submits it, so anyone can rescue anyone's stuck transfer.
 */

export type ClaimPreparation =
  | {
      status: "ready";
      /** The token account the mint lands in — fixed by the burn, not by the payer. */
      recipientTokenAccount: string;
      /** Opens the recipient's USDC account. Present only when it does not exist yet; it costs the
       *  payer about 0.0015 SOL that nobody can ever reclaim, and must confirm before
       *  `buildMintTransaction` is called. */
      setup: Transaction | null;
    }
  | {
      status: "needs-owner";
      recipientTokenAccount: string;
      reason: string;
    }
  | {
      /** Someone has already minted this transfer: the `used_nonce` account exists. */
      status: "already-minted";
      recipientTokenAccount: string;
    };

export interface ClaimInput {
  message: string;
  attestation: string;
  usdcMint: string;
  sourceDomainId: number;
  payer: string;
  /**
   * The wallet that owns the recipient token account, needed only when that account does not
   * exist yet.
   *
   * Creating an associated token account requires the owner's address to derive it — the burn
   * message carries only the derived account, and a token account address cannot be reversed into
   * its owner. So when the account is missing there is genuinely no way to proceed without being
   * told who it belongs to. It is checked, not trusted: the derived address must equal the one the
   * burn named, or the claim is refused.
   */
  recipientOwner?: string;
}

/** Where the browser reaches Solana. The public RPC returns 403 to any request carrying an
 *  `Origin`, so this is a same-origin proxy rather than the endpoint itself. */
export function browserConnection(): Connection {
  return new Connection(new URL("/api/solana-rpc", window.location.origin).toString(), {
    commitment: "confirmed",
  });
}

/** Decides what a claim needs, and builds the account-opening transaction if it needs one. */
export async function prepareClaim(
  connection: Connection,
  input: ClaimInput,
): Promise<ClaimPreparation> {
  const payer = new PublicKey(input.payer);
  const mint = new PublicKey(input.usdcMint);
  const recipientTokenAccount = readMintRecipient(input.message);
  const recipient = recipientTokenAccount.toBase58();

  // Checked first so nobody pays to open an account for a transfer that has already landed.
  if (await connection.getAccountInfo(usedNonceAddress(input.message))) {
    return { status: "already-minted", recipientTokenAccount: recipient };
  }

  if (await connection.getAccountInfo(recipientTokenAccount)) {
    return { status: "ready", recipientTokenAccount: recipient, setup: null };
  }

  if (!input.recipientOwner) {
    return {
      status: "needs-owner",
      recipientTokenAccount: recipient,
      reason:
        "the recipient has no USDC account on Solana yet, and creating one needs the wallet " +
        "address it belongs to",
    };
  }

  const owner = new PublicKey(input.recipientOwner);
  const derived = associatedTokenAddress(owner, mint);
  if (!derived.equals(recipientTokenAccount)) {
    // Refusing rather than creating what was asked for: creating the wrong account spends the
    // payer's rent on something unusable and still leaves the mint impossible.
    return {
      status: "needs-owner",
      recipientTokenAccount: recipient,
      reason: `that wallet's USDC account is ${derived.toBase58()}, which is not the account this burn names`,
    };
  }

  const { instruction } = await ensureRecipientTokenAccount(connection, payer, owner, mint);
  // No instruction means the account appeared between the two reads: nothing left to open.
  if (!instruction) return { status: "ready", recipientTokenAccount: recipient, setup: null };

  return {
    status: "ready",
    recipientTokenAccount: recipient,
    setup: await withBlockhash(connection, new Transaction().add(instruction), payer),
  };
}

/**
 * The mint itself. Built after any setup transaction has confirmed, never alongside it: the
 * blockhash has to be fresh by then, and the wallet's own simulation of the mint fails while the
 * account it mints into does not exist yet.
 */
export async function buildMintTransaction(
  connection: Connection,
  input: ClaimInput,
): Promise<Transaction> {
  const payer = new PublicKey(input.payer);
  const instruction = await buildReceiveMessageInstruction(
    connection,
    payer,
    input.message,
    input.attestation,
    { usdcMint: new PublicKey(input.usdcMint), sourceDomain: input.sourceDomainId },
  );
  return withBlockhash(connection, new Transaction().add(instruction), payer);
}

async function withBlockhash(
  connection: Connection,
  transaction: Transaction,
  payer: PublicKey,
): Promise<Transaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer;
  transaction.recentBlockhash = blockhash;
  return transaction;
}
