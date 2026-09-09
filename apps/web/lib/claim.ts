import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  associatedTokenAddress,
  buildReceiveMessageInstruction,
  readMintRecipient,
} from "@xebra/cctp-solana";

/**
 * Completing a transfer from the browser, without us.
 *
 * # Why this exists
 *
 * The product's central claim is that funds cannot hang: once Circle attests a burn, the
 * `(message, attestation)` pair is public and **anyone** can submit `receiveMessage` on Solana to
 * mint to the recipient. The relay sponsors that gas as a convenience.
 *
 * That was true and unusable. If the relay was down, the receipt told the user to keep their hash
 * and wait for a human to run a script — which is not a self-serve path, and it made our uptime
 * the user's risk rather than their convenience. This closes that.
 *
 * # It builds the same instruction the relay builds
 *
 * `buildReceiveMessageInstruction` from `@xebra/cctp-solana`, unchanged — the one whose account
 * list was verified against Circle's live mainnet programs. A second, browser-specific
 * implementation is how the two quietly diverge, and the divergence would only show up as a
 * failed mainnet transaction.
 *
 * # Who pays
 *
 * The connected wallet: transaction fee, and the 867,621 lamports of permanent `used_nonce` rent,
 * plus token-account rent if the recipient has none. That is the trade — the relay's version is
 * free to the user because we absorb it.
 *
 * The payer does **not** have to be the recipient. `receiveMessage` mints to the address the burn
 * named, whoever submits it, so anyone can rescue anyone's stuck transfer.
 */

export type ClaimPreparation =
  | {
      status: "ready";
      /** The token account the mint lands in — fixed by the burn, not by the payer. */
      recipientTokenAccount: string;
      transaction: Transaction;
      /** True when the transaction also creates the recipient's token account, which costs the
       *  payer about 0.002 SOL that nobody can ever reclaim. */
      createsTokenAccount: boolean;
    }
  | {
      status: "needs-owner";
      recipientTokenAccount: string;
      reason: string;
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

export async function prepareClaim(
  connection: Connection,
  input: ClaimInput,
): Promise<ClaimPreparation> {
  const payer = new PublicKey(input.payer);
  const mint = new PublicKey(input.usdcMint);
  const recipientTokenAccount = readMintRecipient(input.message);

  const existing = await connection.getAccountInfo(recipientTokenAccount);
  const transaction = new Transaction();
  let createsTokenAccount = false;

  if (!existing) {
    if (!input.recipientOwner) {
      return {
        status: "needs-owner",
        recipientTokenAccount: recipientTokenAccount.toBase58(),
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
        recipientTokenAccount: recipientTokenAccount.toBase58(),
        reason: `that wallet's USDC account is ${derived.toBase58()}, which is not the account this burn names`,
      };
    }

    transaction.add(createAssociatedTokenAccountInstruction(payer, derived, owner, mint));
    createsTokenAccount = true;
  }

  transaction.add(
    await buildReceiveMessageInstruction(connection, payer, input.message, input.attestation, {
      usdcMint: mint,
      sourceDomain: input.sourceDomainId,
    }),
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer;
  transaction.recentBlockhash = blockhash;

  return {
    status: "ready",
    recipientTokenAccount: recipientTokenAccount.toBase58(),
    transaction,
    createsTokenAccount,
  };
}

/** Built here rather than pulled from `@solana/spl-token`, which is a large dependency this app
 *  otherwise does not have, for one instruction with no data and a fixed account list. */
function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
) {
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      // The owner never signs. Creating someone's token account is permissionless — only the
      // payer signs — which is what makes claiming on behalf of another wallet possible at all.
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}
