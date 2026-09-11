# When the error blames the wrong contract

A transfer failed with this, shown to the user in the UI:

> **The bridge rejected this transfer (code 10). No funds have moved.**

Confident. Specific. Completely wrong. The bridge rejected nothing.

## What actually happened

The wallet was empty. USDC refused the fee transfer. Here is the real trace, newest first:

```
0: contract:CCNWLGFM…  Error(Contract, #10)  "escalating error to VM trap from failed host function call: call"
1: contract:CCNWLGFM…  Error(Contract, #10)  ["contract call failed", transfer, [GBFI4X5E, CCNWLGFM…, 3000000]]
2: contract:CCW67TSZ…  Error(Contract, #10)  ["resulting balance is not within the allowed range", 0, -3000000, …]
```

Read it bottom-up. The **USDC contract** refused: balance 0, resulting balance would be −3,000,000
stroops. Our contract then reported that the call *it* made had failed. Both surfaced
`Error(Contract, #10)`.

## Why the message was wrong

The error mapper did this:

```ts
const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
const known = CONTRACT_ERRORS[code];
```

It matched `Error(Contract, #N)` **anywhere in the trace** and looked the number up in our own
error table. In our contract, `#10` is `BadFinalityThreshold`. So the app produced a confident
diagnosis of a parameter the user never set, for a problem in their own wallet, and pointed them at
the wrong system entirely.

**Error numbers are per-contract.** Ours means one thing, the Stellar Asset Contract's means
another, Circle's means a third. There is no global namespace and nothing in the string says which
contract you are reading.

## The fix

A Soroban trace is a stack printed newest-first, so the *last* error event names the origin:

```ts
function originatingContract(raw: string): string | null {
  const ids = [...raw.matchAll(/contract:([A-Z0-9]{56})[^\n]*?Error\(Contract/g)].map((m) => m[1]);
  return ids.length > 0 ? ids[ids.length - 1] : null;
}
```

The code table is now consulted only when that origin is our wrapper. Anything else says so plainly
rather than mistranslating it.

Two cause-based checks run first, because they identify the problem regardless of who reported it.
And note the wording:

```ts
const SAC_BALANCE_RANGE = /resulting balance is not within the allowed range/i;
```

The SAC does **not** say "insufficient balance". The previous check looked for exactly that phrase
and could never have matched. Guessing at error strings does not work; you have to read the one the
system actually emits.

## The other half

The app should never have let the transfer start. It now reads the wallet's USDC balance and
disables the button with a plain sentence:

> This wallet holds 0.00 USDC, and this transfer needs 10.00 including the fee — 10.00 short.

With one deliberate subtlety: a balance that could not be *read* stays `null` and blocks nothing.
Treating a failed lookup as a zero is a mistake this codebase had already made once, in the
recipient check, where an RPC failure was reported to the user as "this wallet has no USDC account"
and blocked a wallet that plainly held USDC.

**"I could not find out" and "the answer is no" are different answers.** They have opposite
consequences and they must not share a code path.

## The lesson

**An error message that is confidently wrong is worse than one that is vague.** "Something went
wrong" sends someone looking. "The bridge rejected this transfer (code 10)" sends them looking in
the wrong place, and they trust it because it has a number in it.

When you map error codes, map them *with their namespace*. And when you write a fallback, make it
honest about what you do not know.
