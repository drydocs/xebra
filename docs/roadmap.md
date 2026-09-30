# Roadmap

What comes after the USDC corridor. Nothing here is built. Each item says what would make it
worth building, and what would kill it.

The current corridor ([`go-live.md`](./go-live.md)) comes first. Nothing below starts until
someone who is not us can bridge USDC.

---

## Compliance-preserving RWA bridging

Move tokenized real-world assets (money market fund shares, T-bill tokens, tokenized bonds)
between Stellar and other chains **without dropping the issuer's controls on the way**.

### Why this is open

Research dated 2026-09-16 (the Stellar RWA diligence runs):

- Stellar holds about **$4B** of tokenized RWAs (SDF Dune dashboard, 2026-08-29). Only about
  $2M of it is used in Blend and about $8.4M in Templar. Most of it cannot leave the issuer's
  own app.
- Bridging infrastructure is already live on Stellar. **Axelar ITS** runs on Soroban and can
  register an existing Stellar asset as a canonical token on EVM chains. A standard ITS token,
  though, **does not carry** Stellar's `AUTH_REQUIRED`, freeze or clawback, or SEP-57 / T-REX
  identity and compliance checks. A regulated issuer cannot accept that.
- SDF's SCF 7.0 RFP track asks for a **Stellar-compatible LayerZero DVN**, so bridge
  infrastructure is something SDF explicitly wants funded.
- Issuers on Stellar prefer native asset controls. Franklin Templeton's BENJI uses
  authorization and clawback with no custom contract. A bridge has to respect those controls,
  not work around them.

### Why this does not ride the current rail

CCTP only moves USDC, and Circle does the burn and the mint. An RWA has no Circle. Two ways to
build it inside Xebra's shape:

1. **Issuer-sanctioned burn/mint (recommended).** The issuer grants Xebra's token manager the
   mint and burn role on each chain. The source side burns. The destination side mints **only
   after checking the recipient against the issuer's identity registry on that chain**. That
   means a Stellar trustline authorised by the issuer, or `verify_identity` under the
   OpenZeppelin RWA suite, or ERC-3643 / ONCHAINID on EVM chains. Freeze and clawback state
   travel with the message. Supply stays in the issuer's hands; the message layer can be Axelar
   ITS (custom token manager) or LayerZero OFT.
2. **Intent/solver rail.** A solver holds RWA inventory on both chains and fills from stock.
   This fits the existing Arc↔Stellar escrow design, but every solver becomes a regulated holder
   of the asset. It also needs inventory in every issuer's token on every chain. Only viable for
   one or two large, liquid funds.

### Where it breaks Xebra's current invariants

Two properties the USDC corridor relies on do not survive unchanged:

- **Permissionless claim.** Today anyone holding Circle's attestation can mint, forever. For an
  RWA, the recipient can lose eligibility (KYC lapses, sanctions, the issuer freezes them) while
  the transfer is in flight. The mint has to **re-check eligibility at claim time**. There must
  also be an issuer-directed return path for a transfer whose recipient is no longer allowed to
  receive it. Without that, value is stuck the way the lost dollar in
  [`writeups/01-the-lost-dollar.md`](../writeups/01-the-lost-dollar.md) was stuck.
- **No custody of principal.** Burn/mint keeps this. A lock/release design would not: a lockbox
  holding fund shares is itself a holder the issuer has to authorise, and a target.

### Milestones

| | What | Done when |
|---|---|---|
| R0 | Competitor check | Know how Centrifuge's deRWA tokens (reported to reach Stellar over LayerZero OFT) enforce permissions after bridging. Know whether Axelar or LayerZero ship a compliance-aware token manager. |
| R1 | Design partner | One issuer with the same fund on Stellar and at least one EVM chain agrees to test (candidates: Ondo USDY, Spiko, Centrifuge, Etherfuse). |
| R2 | Token manager on testnet | Burn on Stellar. Mint on one EVM chain only for an ERC-3643-verified recipient. A mint to an unverified recipient reverts. A de-authorised recipient's transfer can be returned by the issuer. |
| R3 | Control mirroring | A freeze or clawback on either side is reflected on the other within one message round-trip. |
| R4 | Audit, then one mainnet corridor | One asset, Stellar ↔ one EVM chain, with a supply cap. |

### Kill criteria

Stop if any of these holds:

- No issuer will grant a mint/burn role to a third-party bridge. Issuers that deploy natively on
  every chain themselves, as BENJI does, do not need one.
- Axelar, LayerZero or the issuer's own stack ships compliance-preserving transfers for Stellar
  first.
- Legal review says a bridged share needs its own registration or transfer-agent entry per
  chain. At that point the product is a transfer-agent integration, not a bridge.
