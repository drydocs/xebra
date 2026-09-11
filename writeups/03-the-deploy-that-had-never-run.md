# The deploy script that had never run

Three defects, discovered in sequence, in the fifteen minutes around putting a contract on
mainnet. All in the *tooling*, not the contract. No test suite would ever have reached any of
them.

## 1. It died on line 27

```bash
scripts/deploy-cctp-wrapper.sh: line 27: REPO_ROOT: unbound variable
```

`REPO_ROOT`, `CRATE_DIR` and `WASM` were referenced throughout and never assigned. Under
`set -euo pipefail` the script terminated on the first line that touched one — before any check
ran, before it printed anything.

This was the only path to deploying the contract. It had never been executed once.

`$SOURCE` had the same problem one line further on: the `[ -n "$SOURCE" ]` guard, written
specifically to produce a helpful error, errored out before it could.

## 2. The confirmation gate exited silently

Fixed the variables, ran it again. All four gates passed — interface check against Circle's live
contract, 41 tests, release build, wasm optimization — then it printed the parameters and...
nothing. No prompt. No "aborted". No deploy. No error.

`read -r -p` returns non-zero on EOF. Under `set -e`, that terminates the script. In a
non-interactive shell there is no stdin, so `read` hit EOF and the script died between printing
the confirmation prompt and evaluating the answer.

The worst possible behaviour for a gate on an irreversible action: **you cannot tell whether it
deployed.** It had not. But nothing said so.

```bash
if [ -n "${CONFIRM:-}" ]; then
  [ "$CONFIRM" = "deploy to mainnet" ] || die "CONFIRM must be exactly 'deploy to mainnet'"
elif [ -t 0 ]; then
  read -r -p "  Type 'deploy to mainnet' to continue: " confirm || die "aborted"
  [ "$confirm" = "deploy to mainnet" ] || die "aborted"
else
  die "no terminal to confirm on — re-run with CONFIRM='deploy to mainnet'"
fi
```

## 3. The transaction was signed, sent, and never included

Third attempt. Signed. Submitted. Then:

```
❌ error: transaction submission timeout
```

Balance untouched, sequence unchanged, nothing on chain. The Stellar CLI defaults to an inclusion
fee of **100 stroops** — which is the network *minimum*, not a competitive bid. Mainnet was at 67%
capacity with a p90 charged fee of 14,252 stroops. The transaction was never going to be picked up.

The infuriating part: **this exact bug had already cost this project a mainnet burn weeks
earlier.** It was found, understood, and fixed — in `apps/web`. The deploy path never got the same
treatment, because the deploy path had never been run.

```bash
INCLUSION_FEE="${INCLUSION_FEE:-10000000}"  # 1 XLM ceiling, not a charge
```

A bid is a ceiling. Stellar charges the clearing rate up to it, so bidding high costs nothing on a
quiet network and buys inclusion on a busy one.

## Then it worked

Fourth attempt deployed
[`CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ`](https://stellar.expert/explorer/public/contract/CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ)
at ledger 64350394 for 49.79 XLM.

One optimization was worth having found first: `wasm-opt` took the binary from 57,475 to 43,319
bytes, and the simulated upload fee from 67.92 XLM to 50.81. The build profile was already fully
size-tuned — `opt-level = "z"`, LTO, `strip`, `panic = "abort"` — and wasm-opt still removed a
quarter of it. Skipping that step would have burned 17 XLM for nothing, and burned it again on
every rent extension for the life of the contract.

## The lesson

**Deployment tooling is production code that runs once.** That is the worst possible combination:
maximum consequence, minimum exercise.

The same bug fixed in one place and not another is the specific failure mode to watch for. When
you fix something environmental — a fee, a timeout, a retry — grep for every other place that does
the same thing. The inclusion fee was fixed in the app and not in the script, and the script was
the thing about to spend 50 XLM.
