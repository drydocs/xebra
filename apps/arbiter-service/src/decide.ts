/**
 * The arbiter's actual "did the solver tell the truth" check is not a judgment call — it's
 * exactly the same falsifiable, deterministic verification anyone else (a challenger, this
 * service, a curious observer) can run: does the asserted destination-chain delivery actually
 * satisfy the intent (right memo/intent hash, right asset, right amount, right recipient)?
 * That verification already lives in @xebra/chain-adapters (`verifyDelivery` for Solana,
 * `decodeFulfillmentPayment` + a match check for Stellar destinations) — this function is
 * deliberately just a one-line wrapper around "resolve `true` iff verification succeeded,"
 * not a separate policy layer, because inventing one would reintroduce exactly the kind of
 * arbiter discretion the whole bonded-challenge design (spec "Trust model") exists to avoid.
 */
export function decideClaimValidity(verified: boolean): boolean {
  return verified;
}
