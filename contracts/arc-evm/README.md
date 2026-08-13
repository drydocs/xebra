# @xebra/arc-evm

`XebraEscrow.sol` — Arc-side escrow for the Arc→Stellar corridor (v1 spec, frozen). Full state
machine (`Open→Claimed→Finalized`, `Open→Refunded`, `Claimed→Challenged→(Finalized|Refunded)`),
EIP-712 intent signing, bonded permissionless claim/challenge, single v1 admin arbiter.

## Setup

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
```

(`lib/` is gitignored — vendored via `forge install`, not committed. `--no-git` is required in
this repo because `contracts/arc-evm` sits inside the monorepo's own git working tree rather than
being its own repo, which is what `forge install`'s default submodule flow expects.)

## Test

```bash
forge test -vv
```

17 tests, including both dispute outcomes (`resolve(claimValid: true/false)`), nonce replay,
expired-intent rejection, wrong-source-token rejection, exact-bond enforcement, and a fuzz check
that `requiredBond` never drops below the 25 USDC floor.

## Deploy

```bash
USDC_ADDRESS=0x... ARBITER_ADDRESS=0x... CHALLENGE_WINDOW_SECS=1800 \
  forge script script/DeployXebraEscrow.s.sol --rpc-url arc_testnet --broadcast
```
