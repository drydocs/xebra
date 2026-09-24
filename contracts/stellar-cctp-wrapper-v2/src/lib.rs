//! XebraCctpWrapper v2 — the forwarding version.
//!
//! v1 (`contracts/stellar-cctp-wrapper`, deployed) burns through Circle and leaves the destination
//! mint to a relay that pays the gas. v2 keeps every v1 invariant and adds a second path: for a
//! destination the admin has marked `forward`, the burn carries Circle's forward hook, Circle's own
//! infrastructure broadcasts the destination `receiveMessage`, and its fee comes out of the
//! minted amount. The relay stops being a funded operating expense and becomes a fallback.
//!
//! See `docs/forwarding-wrapper.md` for the reasoning, the measured behaviour of Circle's service,
//! and the fee model. The one new risk is that **Circle charges the whole `max_fee`**, so a signed
//! `max_fee` is a price the recipient pays; every bound below exists because of that.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, Map, Vec,
};

// Circle's TokenMessengerMinter interface
#[contractclient(name = "TokenMessengerClient")]
pub trait TokenMessenger {
    fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    );

    /// Same as `deposit_for_burn` plus `hook_data`. Circle's Forwarding Service is invoked by
    /// passing the fixed `FORWARD_HOOK` here. Read from the live mainnet interface
    /// (`stellar contract info interface`), argument order verified.
    fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    );
}

// Types

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Params {
    pub fee_bps: u32,
    pub min_fee: i128,
    pub min_transfer: i128,
    pub max_transfer: i128,
    /// Ceiling on the Circle fee allowance a caller may request, in bps of `net`.
    pub max_cctp_fee_bps: u32,
    /// Charged on top of the percentage fee when the destination has no token account yet.
    ///
    /// Creating one on Solana costs about 2,039,280 lamports of rent that **nobody can ever
    /// reclaim** — closing the account needs the owner's signature, which a sponsor does not
    /// have. Folding that into `min_fee` would make every transfer pay for a cost only
    /// first-time recipients incur, which is what forced the floor up to a level that made small
    /// transfers unattractive. Charged separately, the floor can stay low.
    ///
    /// The price is set here, by the admin, rather than supplied by the caller. The caller only
    /// says *whether* it applies.
    pub account_fee: i128,
}

/// Per-destination-domain configuration. `evm_style` selects the `mint_recipient` shape
/// check: EVM addresses are 20 bytes left-padded into 32, Solana pubkeys fill all 32.
///
/// `forward` turns on Circle's Forwarding Service for this destination, and `max_forward_fee` is
/// the most a signed request's `max_fee` may be on that path, in 7-decimal stroops. It is per
/// chain because forward fees differ by two orders of magnitude (Arc about $0.02, Solana about
/// $0.15, Ethereum about $1.13), so one global cap would either strand the expensive chains or
/// leave the cheap ones unprotected. Raising it, or turning `forward` on, goes through the 48h
/// timelock; lowering it or turning `forward` off is instant (`tighten_domain`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainCfg {
    pub domain: u32,
    pub evm_style: bool,
    pub forward: bool,
    pub max_forward_fee: i128,
    /// Circle's forwarder can create the recipient's Solana USDC token account as part of the
    /// forward (an extended hook carrying the owner's address). When set, a request that says its
    /// recipient needs an account is forwarded too, with that hook, instead of falling back to the
    /// relay. Only meaningful for a non-EVM destination that also has `forward` on. Proven on
    /// mainnet for Stellar -> Solana (docs/forwarding-wrapper.md).
    pub account_creation: bool,
    /// The most a signed `max_fee` may be when the forwarder also creates the account. Separate from
    /// `max_forward_fee` because the fee is roughly double (about $0.34 vs $0.17 on Solana) and a
    /// single cap would either block account creation or leave ordinary transfers unprotected.
    /// Zero unless `account_creation` is on.
    pub max_forward_fee_new_account: i128,
}

/// The user signs this whole struct. Every field that could redirect or resize the transfer
/// is in here, so the signature pins all of them.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeRequest {
    pub user: Address,
    /// Total the user is willing to spend, in 7-decimal stroops. Debited as `fee + net`;
    /// the sub-10-stroop remainder stays in the user's wallet.
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    /// Circle's fee allowance, quoted off-chain from `get_min_fee_amount`. Bounded on-chain
    /// by `check_max_fee`.
    pub max_fee: i128,
    /// `<= 1000` requests Fast Transfer; `> 1000` is Standard.
    pub min_finality_threshold: u32,
    /// Ledger at which the one-shot USDC allowance to Circle's TokenMessenger expires.
    ///
    /// Supplied by the caller rather than computed as `sequence() + N`, and that is not a
    /// stylistic choice — it is what makes the transaction signable at all. Soroban matches every
    /// sub-invocation against the signed authorization tree **argument by argument**, and the
    /// SAC's `approve(from, spender, amount, expiration_ledger)` requires the user's auth. A
    /// value derived from `env.ledger().sequence()` is computed at *simulation* time when the
    /// tree is built and again at *execution* time when it is checked — and those are different
    /// ledgers, always. The two never match and every `bridge` fails with an authorization error.
    ///
    /// Bounded at execution instead: not already past (the SAC rejects that outright), and no
    /// further out than `APPROVAL_TTL_LEDGERS`, so nothing resembling a standing grant survives.
    pub approval_expiration_ledger: u32,
    /// Whether the destination needs a token account created before it can receive the mint.
    ///
    /// Determined off-chain — it is a fact about Solana that a Stellar contract cannot see — and
    /// it only selects whether `params.account_fee` applies. A caller who sets this to `false`
    /// when the account is in fact missing pays less and gets a mint that cannot land until
    /// somebody creates the account; the sponsor's rule is simply to not create an account it was
    /// not paid for. So the lie costs the liar, not us.
    pub recipient_needs_account: bool,
    /// The wallet that will own the recipient's USDC token account. Used when the destination
    /// forwarder creates that account (`DomainCfg::account_creation`): it goes into Circle's hook, and
    /// `mint_recipient` must be the token account derived from it. Circle enforces the derivation; this
    /// contract cannot (it has no ed25519 curve check), so the front end derives it. Must be zero
    /// unless `recipient_needs_account` is set, and never equal to `mint_recipient` — the wallet
    /// address in place of the token account is the mistake that stranded the first mainnet burn.
    pub recipient_owner: BytesN<32>,
    /// The user's own ceiling on *our* total fee, percentage and account fee together. Without
    /// it, a `commit_params` landing in the same ledger could overcharge an already-signed
    /// request.
    pub max_wrapper_fee: i128,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub amount: i128,
    /// Everything the user pays besides the principal: on the relay path the percentage-or-floor
    /// part plus the account fee if it applies; on the forward path `max(that, forward_fee)`. The
    /// recipient always receives `amount - fee - remainder`.
    pub fee: i128,
    /// The part of `fee` that is the destination account's rent, broken out so the UI can say
    /// what it is for rather than showing one unexplained number. Always zero when forwarded.
    pub account_fee: i128,
    pub net_burned: i128,
    /// The sub-10-stroop remainder that is never transferred out of the user's wallet.
    pub remainder: i128,
    /// Circle's forward fee: the `max_fee` charged to the recipient at the mint, in full. Zero on
    /// the relay path.
    pub forward_fee: i128,
    /// The part of `fee` this contract keeps: `fee - forward_fee`. The only thing pulled from the
    /// user besides the burn, and the only thing that accrues.
    pub wrapper_take: i128,
    /// Whether this transfer takes the forward path.
    pub forwarded: bool,
    /// Whether the forwarder will create the recipient's token account (forward path only).
    pub account_created: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingParams {
    pub params: Params,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAddress {
    pub addr: Address,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDomain {
    pub cfg: DomainCfg,
    pub eta: u64,
}

/// All state is instance storage: fixed-size, one TTL, bumped on every mutating call.
/// There are deliberately no per-user persistent entries — nothing can be archived
/// mid-flight, because nothing is ever in flight.
#[contracttype]
pub enum DataKey {
    Usdc,
    TokenMessenger,
    Admin,
    Pauser,
    FeeRecipient,
    Params,
    AccruedFees,
    Seq,
    Paused,
    Domains,
    PendingParams,
    PendingAdmin,
    PendingPauser,
    PendingRecipient,
    PendingDomain,
    /// Reentrancy flag. Temporary storage, set and cleared within a single `bridge`.
    Guard,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    Paused = 2,
    NotPaused = 3,
    Reentrancy = 4,
    RequestExpired = 5,
    DeadlineTooFar = 6,
    DomainNotAllowed = 7,
    MintRecipientZero = 8,
    MintRecipientShape = 9,
    BadFinalityThreshold = 10,
    AmountNotPositive = 11,
    AmountBelowMin = 12,
    AmountAboveMax = 13,
    AmountBelowFee = 14,
    NetTooSmall = 15,
    MaxFeeNegative = 16,
    MaxFeeExceedsNet = 17,
    MaxFeeTooHigh = 18,
    WrapperFeeAboveUserCap = 19,
    FeeBpsTooHigh = 20,
    MinFeeTooHigh = 21,
    MinTransferTooLow = 22,
    MaxTransferTooHigh = 23,
    CctpFeeBpsTooHigh = 24,
    BadTransferRange = 25,
    MathOverflow = 26,
    /// A postcondition this contract asserts about itself failed. Always a bug here or a
    /// host/token misbehaviour; always reverts rather than proceeding.
    InvariantViolated = 27,
    NothingPending = 28,
    TimelockNotElapsed = 29,
    InsufficientAccruedFees = 30,
    NotTightening = 31,
    DomainAlreadyAllowed = 32,
    SelfDomain = 34,
    AlreadyInitialized = 35,
    /// The signed approval expiry is already behind us — the transaction sat unincluded too
    /// long. Retrying re-simulates and produces a fresh one.
    ApprovalExpiryPast = 36,
    /// The requested approval would outlive the transaction that uses it.
    ApprovalExpiryTooFar = 37,
    AccountFeeTooHigh = 38,
    /// A forwarded transfer's `max_fee` was zero. Circle's forwarder cannot be paid nothing, so
    /// this can only fail after the burn.
    ForwardFeeZero = 39,
    /// The signed `max_fee` is above this destination's `max_forward_fee`.
    ForwardFeeAboveCap = 40,
    /// The signed `max_fee` is more than a tenth of what is burned.
    ForwardFeeTooHigh = 41,
    /// A `DomainCfg` carries a forward cap above the compile-time ceiling, or turns `forward` on
    /// with no cap.
    BadForwardConfig = 42,
    /// The forwarder is to create the recipient's account but no owner was given.
    RecipientOwnerMissing = 43,
    /// An owner was given although the request does not say the account needs creating.
    RecipientOwnerUnexpected = 44,
    /// `mint_recipient` equals `recipient_owner`: the wallet where the token account belongs.
    MintRecipientIsOwner = 45,
}

// ---------------------------------------------------------------------------
// Events — struct name in snake_case is the topic the indexer matches.
// ---------------------------------------------------------------------------

/// Topic: `bridge_initiated`.
///
/// The join to Circle's own burn event is the transaction hash — which is how
/// `packages/cctp-client/src/iris.ts` queries attestations anyway
/// (`getMessages(domain, transactionHash)`), and `bridge` and `deposit_for_burn` are the
/// same transaction by construction. `transfer_id` adds a collision-free primary key for
/// `cctp_transfers`, unique even for two identical bridges in one ledger. `fee_bps`/
/// `min_fee` are emitted so historical revenue can be re-derived without reconstructing
/// contract state at that ledger.
#[contractevent]
pub struct BridgeInitiated {
    pub transfer_id: BytesN<32>,
    pub seq: u64,
    pub user: Address,
    pub amount: i128,
    pub fee: i128,
    /// The rent portion of `fee`. Zero unless the destination needed a token account — which is
    /// also how the sponsor knows whether it was paid to create one.
    pub account_fee: i128,
    pub recipient_needs_account: bool,
    pub net_burned: i128,
    pub remainder: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub fee_bps: u32,
    pub min_fee: i128,
    pub burn_token: Address,
    /// Whether Circle was asked to mint (`true`) or a relay is expected to (`false`). This is what
    /// the watcher keys on: a forwarded burn is left to Circle first and only minted by hand if
    /// Iris reports the forward failed or it does not arrive.
    pub forwarded: bool,
    /// The recipient wallet named in the request (zero when none). On a forwarded transfer with
    /// `account_created` it is what Circle creates the token account for; on the relay path it is what
    /// a relay needs to create the account itself.
    pub recipient_owner: BytesN<32>,
    /// Whether Circle's forwarder is asked to create the recipient's token account.
    pub account_created: bool,
    /// Circle's forward fee, charged to the recipient at the mint. Equal to `max_fee` when
    /// forwarded, zero otherwise.
    pub forward_fee: i128,
    /// What accrued to the fee recipient from this transfer. `fee - forward_fee`.
    pub wrapper_take: i128,
}

/// Topic: `fees_withdrawn`.
#[contractevent]
pub struct FeesWithdrawn {
    pub to: Address,
    pub amount: i128,
    pub accrued_after: i128,
}

/// Topic: `wrapper_paused`.
#[contractevent]
pub struct WrapperPaused {
    pub by: Address,
}

/// Topic: `wrapper_unpaused`.
#[contractevent]
pub struct WrapperUnpaused {
    pub by: Address,
}

/// Topic: `params_proposed`. Alert on this — it opens the 48h window in which a fee
/// increase or cap loosening can be vetoed.
#[contractevent]
pub struct ParamsProposed {
    pub params: Params,
    pub eta: u64,
}

/// Topic: `params_committed`.
#[contractevent]
pub struct ParamsCommitted {
    pub params: Params,
}

/// Topic: `params_tightened`. Instant, exposure-reducing changes only.
#[contractevent]
pub struct ParamsTightened {
    pub params: Params,
}

/// Topic: `pending_cancelled`.
#[contractevent]
pub struct PendingCancelled {
    pub by: Address,
}

/// Topic: `admin_proposed`.
#[contractevent]
pub struct AdminProposed {
    pub new_admin: Address,
    pub eta: u64,
}

/// Topic: `admin_changed`.
#[contractevent]
pub struct AdminChanged {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// Topic: `pauser_proposed`. Alert on this as loudly as on `fee_recipient_proposed`: it opens the
/// 48h window in which the admin is trying to remove the only check on itself.
#[contractevent]
pub struct PauserProposed {
    pub new_pauser: Address,
    pub eta: u64,
}

/// Topic: `pauser_changed`.
#[contractevent]
pub struct PauserChanged {
    pub old_pauser: Address,
    pub new_pauser: Address,
}

/// Topic: `fee_recipient_proposed`. Highest-value exfiltration target — page on this.
#[contractevent]
pub struct FeeRecipientProposed {
    pub new_recipient: Address,
    pub eta: u64,
}

/// Topic: `fee_recipient_changed`.
#[contractevent]
pub struct FeeRecipientChanged {
    pub old_recipient: Address,
    pub new_recipient: Address,
}

/// Topic: `domain_proposed`.
#[contractevent]
pub struct DomainProposed {
    pub cfg: DomainCfg,
    pub eta: u64,
}

/// Topic: `domain_added`.
#[contractevent]
pub struct DomainAdded {
    pub cfg: DomainCfg,
}

/// Topic: `domain_tightened`. Instant and exposure-reducing only: forwarding off, or a lower cap.
#[contractevent]
pub struct DomainTightened {
    pub cfg: DomainCfg,
    pub by: Address,
}

/// Topic: `domain_removed`.
#[contractevent]
pub struct DomainRemoved {
    pub domain: u32,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BPS_DENOM: i128 = 10_000;
/// Stellar 7-decimal local units per CCTP 6-decimal canonical unit. Verified live:
/// `get_token_decimal_config` on mainnet returns `{canonical_decimals: 6, local_decimals: 7}`.
const STROOPS_PER_CANONICAL: i128 = 10;

/// Hard ceilings. No admin, compromised or otherwise, can exceed any of these — they are
/// compile-time constants, and there is no upgrade entrypoint. This is what makes the
/// immutability of `usdc`/`token_messenger` meaningful under a stolen-key threat model.
const MAX_FEE_BPS_CEILING: u32 = 100; // 1.00%
const MAX_MIN_FEE_CEILING: i128 = 5_0000000; // 5 USDC
/// The smallest `min_transfer` an admin may set: 1 USDC. v1 used 10. Lowered on purpose for v2 so a first
/// real transfer can be small. Two things still bound what a small transfer can be: the fee floor
/// (`min_fee`, 0.30 USDC by default) and, on the forward path, `check_forward_fee`, which refuses a
/// delivery fee above a tenth of what is burned. On Solana that second bound means roughly 2 USDC or
/// more for an existing token account and about 4 USDC when Circle also creates it, whatever this says.
const MIN_TRANSFER_FLOOR: i128 = 1_0000000; // 1 USDC
/// Circle's own live mainnet `get_max_burn_amount_per_message` for USDC, read from the chain:
/// 100000000000000 stroops = 10M USDC. Set to Circle's limit rather than a tighter one of our
/// own, so the contract imposes no ceiling a user would ever notice — above this the burn would
/// be rejected by Circle anyway, and failing here says why.
///
/// Note what this gives up. A lower ceiling is what bounds the damage from a bug nobody has
/// found, and this contract has had no external audit. `params.max_transfer` can still be set
/// below this and raised as clean transfers accumulate; that is the lever, and it is worth using
/// early on.
const MAX_TRANSFER_CEILING: i128 = 100_000_000_000_000;
const MAX_CCTP_FEE_BPS_CEILING: u32 = 50; // 0.50%
const MAX_CCTP_FLAT_FEE_CEILING: i128 = 1_0000000; // 1 USDC
/// Ceiling on `params.account_fee`. Solana account rent is about 2,039,280 lamports; at any SOL
/// price where 2 USDC fails to cover that, the fee schedule needs revisiting rather than
/// stretching.
pub const MAX_ACCOUNT_FEE_CEILING: i128 = 2_0000000; // 2 USDC
const CCTP_MAX_FEE_FRACTION_DENOM: i128 = 10;
/// Circle treats anything above 1000 as Standard; 2000 is the documented Standard value.
const MAX_FINALITY_THRESHOLD: u32 = 2_000;
const MAX_DEADLINE_HORIZON: u64 = 3_600;
const TIMELOCK_SECS: u64 = 172_800; // 48h
/// Ceiling on how far ahead a caller may set the one-shot allowance to Circle's TokenMessenger.
/// It only needs to survive this one transaction, so this is kept short enough that nothing
/// resembling a standing grant is ever left behind — about five minutes at 5s ledgers, which is
/// also comfortably longer than a transaction's own submission window.
const APPROVAL_TTL_LEDGERS: u32 = 60;

/// Hard ceiling on any domain's `max_forward_fee`: 2 USDC. Compile-time, so no admin, compromised
/// or otherwise, can let a signed request hand more than this to Circle. Above the highest live
/// forward fee measured (Ethereum, about $1.13) and far above the two chains actually enabled.
pub const MAX_FORWARD_FEE_CEILING: i128 = 2_0000000;

/// Circle's Forwarding Service hook, version 0 (single hook): the ASCII string `cctp-forward`
/// right-padded with zeros to 32 bytes. The wrapper passes exactly this and nothing else, so a
/// caller cannot smuggle arbitrary hook data into a burn. Verified on testnet and mainnet
/// (2026-09-20): burns carrying it were minted by Circle's forwarder. If Circle changes the
/// format, forwards fail safely and `tighten_domain` switches them off.
pub const FORWARD_HOOK: [u8; 32] = [
    0x63, 0x63, 0x74, 0x70, 0x2d, 0x66, 0x6f, 0x72, 0x77, 0x61, 0x72, 0x64, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

pub const DOMAIN_SOLANA: u32 = 5;
pub const DOMAIN_ARC: u32 = 26;
pub const DOMAIN_STELLAR: u32 = 27;

/// ~5s average ledger close time on Stellar.
const LEDGERS_PER_DAY: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const INSTANCE_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 180;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct XebraCctpWrapper;

#[contractimpl]
impl XebraCctpWrapper {
    /// `usdc` and `token_messenger` are immutable for the life of the contract — there are
    /// no setters and no upgrade entrypoint. A Circle migration means redeploying and
    /// repointing the frontend, which strands nobody precisely because no funds are held
    /// between transactions.
    pub fn __constructor(
        env: Env,
        usdc: Address,
        token_messenger: Address,
        admin: Address,
        pauser: Address,
        fee_recipient: Address,
        params: Params,
        domains: Vec<DomainCfg>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Usdc) {
            return Err(Error::AlreadyInitialized);
        }
        Self::validate_params(&params)?;

        let mut map: Map<u32, DomainCfg> = Map::new(&env);
        for cfg in domains.iter() {
            if cfg.domain == DOMAIN_STELLAR {
                return Err(Error::SelfDomain);
            }
            Self::validate_domain_cfg(&cfg)?;
            if map.contains_key(cfg.domain) {
                return Err(Error::DomainAlreadyAllowed);
            }
            map.set(cfg.domain, cfg);
        }

        let s = env.storage().instance();
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::TokenMessenger, &token_messenger);
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Pauser, &pauser);
        s.set(&DataKey::FeeRecipient, &fee_recipient);
        s.set(&DataKey::Params, &params);
        s.set(&DataKey::Domains, &map);
        s.set(&DataKey::AccruedFees, &0i128);
        s.set(&DataKey::Seq, &0u64);
        s.set(&DataKey::Paused, &false);
        s.extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
        Ok(())
    }

    pub fn bridge(env: Env, req: BridgeRequest) -> Result<Quote, Error> {
        if env.storage().temporary().has(&DataKey::Guard) {
            return Err(Error::Reentrancy);
        }
        env.storage().temporary().set(&DataKey::Guard, &true);
        let out = Self::bridge_inner(&env, &req);
        env.storage().temporary().remove(&DataKey::Guard);
        out
    }

    fn bridge_inner(env: &Env, req: &BridgeRequest) -> Result<Quote, Error> {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        // --- request validity ---
        let now = env.ledger().timestamp();
        if req.deadline <= now {
            return Err(Error::RequestExpired);
        }
        if req.deadline > now.saturating_add(MAX_DEADLINE_HORIZON) {
            return Err(Error::DeadlineTooFar);
        }

        // --- destination validity: a burn to an unsupported or self domain is not stuck,
        //     it is destroyed, so this is an allowlist and not a denylist ---
        if req.destination_domain == DOMAIN_STELLAR {
            return Err(Error::SelfDomain);
        }
        let cfg = Self::domain_cfg(env, req.destination_domain).ok_or(Error::DomainNotAllowed)?;
        Self::check_mint_recipient(req.mint_recipient.to_array(), cfg.evm_style)?;
        if req.min_finality_threshold == 0 || req.min_finality_threshold > MAX_FINALITY_THRESHOLD {
            return Err(Error::BadFinalityThreshold);
        }

        // The allowance window, bounded here because it arrives signed rather than computed.
        // Below `sequence()` the SAC would panic with an opaque host error; above the ceiling the
        // grant would outlive the transaction that consumes it.
        let seq_now = env.ledger().sequence();
        if req.approval_expiration_ledger < seq_now {
            return Err(Error::ApprovalExpiryPast);
        }
        if req.approval_expiration_ledger > seq_now.saturating_add(APPROVAL_TTL_LEDGERS) {
            return Err(Error::ApprovalExpiryTooFar);
        }

        // --- amount bounds and the split ---
        let params = Self::get_params(env.clone());
        if req.amount < params.min_transfer {
            return Err(Error::AmountBelowMin);
        }
        if req.amount > params.max_transfer {
            return Err(Error::AmountAboveMax);
        }
        // Which path this transfer takes is decided here, from inputs the user signed.
        //
        //   forwarded       Circle mints. Every EVM destination and every existing Solana account.
        //                   A recipient that needs a token account is forwarded too when the domain
        //                   has `account_creation`, with Circle's extended hook that creates it.
        //   relay path      everything else, exactly v1: the account fee pays for a relay to create
        //                   the account and mint.
        let creates_account = cfg.forward && cfg.account_creation && req.recipient_needs_account;
        let forwarded = cfg.forward && (!req.recipient_needs_account || cfg.account_creation);

        // The owner is signed, so it must mean one thing: present only where it is used, and never
        // the wallet address standing in for the token account.
        let owner_given = req.recipient_owner.to_array().iter().any(|b| *b != 0);
        if owner_given && !req.recipient_needs_account {
            return Err(Error::RecipientOwnerUnexpected);
        }
        if creates_account && !owner_given {
            return Err(Error::RecipientOwnerMissing);
        }
        if owner_given && req.recipient_owner == req.mint_recipient {
            return Err(Error::MintRecipientIsOwner);
        }

        let (q, max_fee) = if forwarded {
            let mut q = Self::compute_forward_split(
                req.amount,
                params.fee_bps,
                params.min_fee,
                req.max_fee,
            )?;
            q.account_created = creates_account;
            Self::check_forward_fee(&q, &cfg)?;
            let m = q.forward_fee;
            (q, m)
        } else {
            let account_fee = if req.recipient_needs_account {
                params.account_fee
            } else {
                0
            };
            let q = Self::compute_split(req.amount, params.fee_bps, params.min_fee, account_fee)?;
            let m = Self::check_max_fee(q.net_burned, req.max_fee, params.max_cctp_fee_bps)?;
            (q, m)
        };

        // The total the user pays, forward fee included, against their own signed ceiling.
        if q.fee > req.max_wrapper_fee {
            return Err(Error::WrapperFeeAboveUserCap);
        }

        req.user
            .require_auth_for_args((req.clone(),).into_val(env));

        // --- effects before interactions (checks-effects-interactions) ---
        let seq = Self::next_seq(env)?;
        let accrued_after = Self::get_accrued_fees(env.clone())
            .checked_add(q.wrapper_take)
            .ok_or(Error::MathOverflow)?;
        env.storage().instance().set(&DataKey::Seq, &seq);
        env.storage()
            .instance()
            .set(&DataKey::AccruedFees, &accrued_after);

        // --- interactions ---
        let usdc = Self::get_usdc(env.clone());
        let messenger = Self::get_token_messenger(env.clone());
        let wrapper = env.current_contract_address();
        let usdc_client = token::Client::new(env, &usdc);

        // Pull ONLY our own take. Principal never transits this contract, and on the forward path
        // Circle's fee is not pulled here at all: it is deducted from the burn at the destination.
        if q.wrapper_take > 0 {
            usdc_client.transfer(&req.user, &wrapper, &q.wrapper_take);
        }

        // Circle pulls the principal with `transfer_from`, NOT `transfer` — see
        // circlefin/stellar-cctp's `deposit_and_burn`:
        //
        //     token_client.transfer_from(&contract_address, from, &contract_address, &amount);
        //
        // A Soroban SAC's `transfer_from` consumes an ALLOWANCE ledger entry; the caller's
        // `require_auth` does not substitute for one. Without this approve the burn reverts
        // with the SAC's "not enough allowance to spend" (contract error #9) — verified on
        // mainnet before this line existed.
        //
        // The approve is scoped to exactly `net_burned` and expires almost immediately, so no
        // standing grant to the TokenMessenger survives this transaction. It is authorized by
        // the same user auth tree that roots `bridge`, which is why the whole flow is still a
        // single signature — the reason for routing through this contract rather than making
        // users approve and burn in two separate transactions.
        // Every argument here comes from the signed request. See `approval_expiration_ledger`:
        // deriving the expiry from the current ledger made the authorization tree unmatchable
        // between simulation and execution, which failed every single transfer.
        usdc_client.approve(
            &req.user,
            &messenger,
            &q.net_burned,
            &req.approval_expiration_ledger,
        );

        let messenger_client = TokenMessengerClient::new(env, &messenger);
        // Zero, always: anyone may submit the mint, which is what keeps a failed forward, a dead
        // relay and a dead Xebra all recoverable. Circle's forwarder also requires it.
        let destination_caller = BytesN::from_array(env, &[0u8; 32]);
        if forwarded {
            // Built here from signed fields and nothing else; a caller never supplies hook data.
            let hook = if q.account_created {
                Self::forward_hook_with_account(env, &req.recipient_owner)
            } else {
                Bytes::from_array(env, &FORWARD_HOOK)
            };
            messenger_client.deposit_for_burn_with_hook(
                &req.user,
                &q.net_burned,
                &req.destination_domain,
                &req.mint_recipient,
                &usdc,
                &destination_caller,
                &max_fee,
                &req.min_finality_threshold,
                &hook,
            );
        } else {
            messenger_client.deposit_for_burn(
                &req.user,
                &q.net_burned,
                &req.destination_domain,
                &req.mint_recipient,
                &usdc,
                &destination_caller,
                &max_fee,
                &req.min_finality_threshold,
            );
        }

        // Solvency, enforced by the chain rather than asserted in a test: if this contract
        // ever holds less USDC than it claims to owe the fee recipient, fail closed.
        if usdc_client.balance(&wrapper) < accrued_after {
            return Err(Error::InvariantViolated);
        }

        let transfer_id = Self::transfer_id(env, seq, req, &q);
        BridgeInitiated {
            transfer_id,
            seq,
            user: req.user.clone(),
            amount: q.amount,
            fee: q.fee,
            account_fee: q.account_fee,
            recipient_needs_account: req.recipient_needs_account,
            net_burned: q.net_burned,
            remainder: q.remainder,
            destination_domain: req.destination_domain,
            mint_recipient: req.mint_recipient.clone(),
            max_fee,
            min_finality_threshold: req.min_finality_threshold,
            fee_bps: params.fee_bps,
            min_fee: params.min_fee,
            burn_token: usdc,
            forwarded,
            recipient_owner: req.recipient_owner.clone(),
            account_created: q.account_created,
            forward_fee: q.forward_fee,
            wrapper_take: q.wrapper_take,
        }
        .publish(env);

        Ok(q)
    }

    /// The fee split. `account_fee` is added on top of the percentage-or-floor part, and is zero
    /// unless the destination needs a token account created.
    pub fn compute_split(
        amount: i128,
        fee_bps: u32,
        min_fee: i128,
        account_fee: i128,
    ) -> Result<Quote, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        if fee_bps > MAX_FEE_BPS_CEILING {
            return Err(Error::FeeBpsTooHigh);
        }
        if min_fee < 0 || min_fee > MAX_MIN_FEE_CEILING {
            return Err(Error::MinFeeTooHigh);
        }
        if account_fee < 0 || account_fee > MAX_ACCOUNT_FEE_CEILING {
            return Err(Error::AccountFeeTooHigh);
        }

        let pct = amount
            .checked_mul(fee_bps as i128)
            .ok_or(Error::MathOverflow)?
            / BPS_DENOM;
        let base = if pct > min_fee { pct } else { min_fee };
        let fee = base.checked_add(account_fee).ok_or(Error::MathOverflow)?;

        let after_fee = amount.checked_sub(fee).ok_or(Error::MathOverflow)?;
        if after_fee <= 0 {
            return Err(Error::AmountBelowFee);
        }

        let remainder = after_fee % STROOPS_PER_CANONICAL;
        let net_burned = after_fee - remainder;
        if net_burned <= 0 {
            return Err(Error::NetTooSmall);
        }

        let recomposed = fee
            .checked_add(net_burned)
            .and_then(|v| v.checked_add(remainder));
        if recomposed != Some(amount) {
            return Err(Error::InvariantViolated);
        }

        Ok(Quote {
            amount,
            fee,
            account_fee,
            net_burned,
            remainder,
            forward_fee: 0,
            wrapper_take: fee,
            forwarded: false,
            account_created: false,
        })
    }

    /// The forward-path split. Pure, like `compute_split`, so it can be tested without a ledger.
    ///
    /// The recipient's promise is the same as on the relay path — `amount - fee` — and the forward
    /// fee is paid *out of* `fee`, not on top of it:
    ///
    /// ```text
    /// fee          = max(base, M)        base = max(amount * bps, min_fee), M = forward fee
    /// wrapper_take = fee - M             what accrues; never negative
    /// burned       = amount - wrapper_take, rounded down to a multiple of 10
    /// recipient    = burned - M          = amount - fee - remainder
    /// ```
    ///
    /// When `M >= base` the user pays `M` and we keep nothing on that transfer: gas is passed
    /// through at cost rather than the transfer being refused. `max_fee` is rounded up to a
    /// multiple of 10 stroops (Stellar USDC has 7 decimals, CCTP's canonical amount 6), exactly as
    /// `check_max_fee` does for the relay path. The per-domain cap and the 10% bound are applied by
    /// `check_forward_fee`, which needs the domain.
    pub fn compute_forward_split(
        amount: i128,
        fee_bps: u32,
        min_fee: i128,
        max_fee: i128,
    ) -> Result<Quote, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        if fee_bps > MAX_FEE_BPS_CEILING {
            return Err(Error::FeeBpsTooHigh);
        }
        if min_fee < 0 || min_fee > MAX_MIN_FEE_CEILING {
            return Err(Error::MinFeeTooHigh);
        }
        if max_fee < 0 {
            return Err(Error::MaxFeeNegative);
        }
        if max_fee == 0 {
            return Err(Error::ForwardFeeZero);
        }

        let rem = max_fee % STROOPS_PER_CANONICAL;
        let m = if rem == 0 {
            max_fee
        } else {
            max_fee
                .checked_add(STROOPS_PER_CANONICAL - rem)
                .ok_or(Error::MathOverflow)?
        };

        let pct = amount
            .checked_mul(fee_bps as i128)
            .ok_or(Error::MathOverflow)?
            / BPS_DENOM;
        let base = if pct > min_fee { pct } else { min_fee };
        let fee = if base > m { base } else { m };
        let wrapper_take = fee - m;

        let after = amount
            .checked_sub(wrapper_take)
            .ok_or(Error::MathOverflow)?;
        if after <= 0 {
            return Err(Error::AmountBelowFee);
        }
        let remainder = after % STROOPS_PER_CANONICAL;
        let net_burned = after - remainder;
        // The recipient must receive something: Circle takes `m` out of `net_burned`.
        if net_burned <= m {
            return Err(Error::MaxFeeExceedsNet);
        }

        // `wrapper_take + net_burned + remainder` is what leaves the user's wallet; the fee the
        // user is told about is `wrapper_take + m`.
        let recomposed = wrapper_take
            .checked_add(net_burned)
            .and_then(|v| v.checked_add(remainder));
        if recomposed != Some(amount) {
            return Err(Error::InvariantViolated);
        }
        if net_burned - m != amount - fee - remainder {
            return Err(Error::InvariantViolated);
        }

        Ok(Quote {
            amount,
            fee,
            account_fee: 0,
            net_burned,
            remainder,
            forward_fee: m,
            wrapper_take,
            forwarded: true,
            account_created: false,
        })
    }

    /// The bounds on a forwarded transfer's `max_fee`, which Circle charges in full.
    ///
    /// Two, and neither can be overridden by the caller: the destination's own `max_forward_fee`,
    /// and a tenth of what is burned (the same 10% rule `check_max_fee` applies on the relay path).
    /// The per-domain cap is itself bounded by `MAX_FORWARD_FEE_CEILING` when it is configured.
    pub fn check_forward_fee(q: &Quote, cfg: &DomainCfg) -> Result<(), Error> {
        // Creating the account roughly doubles Circle's fee, so it has its own cap; the plain cap
        // must not block it and the account cap must not loosen ordinary transfers.
        let cap = if q.account_created {
            cfg.max_forward_fee_new_account
        } else {
            cfg.max_forward_fee
        };
        if q.forward_fee > cap {
            return Err(Error::ForwardFeeAboveCap);
        }
        if q.forward_fee > q.net_burned / CCTP_MAX_FEE_FRACTION_DENOM {
            return Err(Error::ForwardFeeTooHigh);
        }
        Ok(())
    }

    pub fn check_max_fee(net_burned: i128, max_fee: i128, cap_bps: u32) -> Result<i128, Error> {
        if max_fee < 0 {
            return Err(Error::MaxFeeNegative);
        }
        if cap_bps > MAX_CCTP_FEE_BPS_CEILING {
            return Err(Error::CctpFeeBpsTooHigh);
        }
        if net_burned <= 0 {
            return Err(Error::NetTooSmall);
        }

        let rem = max_fee % STROOPS_PER_CANONICAL;
        let max_fee = if rem == 0 {
            max_fee
        } else {
            max_fee
                .checked_add(STROOPS_PER_CANONICAL - rem)
                .ok_or(Error::MathOverflow)?
        };

        if max_fee >= net_burned {
            return Err(Error::MaxFeeExceedsNet);
        }

        let bps_bound = net_burned
            .checked_mul(cap_bps as i128)
            .ok_or(Error::MathOverflow)?
            / BPS_DENOM;
        let soft = if bps_bound > MAX_CCTP_FLAT_FEE_CEILING {
            bps_bound
        } else {
            MAX_CCTP_FLAT_FEE_CEILING
        };
        let hard = net_burned / CCTP_MAX_FEE_FRACTION_DENOM;
        let bound = if soft < hard { soft } else { hard };

        if max_fee > bound {
            return Err(Error::MaxFeeTooHigh);
        }
        Ok(max_fee)
    }

    fn check_mint_recipient(bytes: [u8; 32], evm_style: bool) -> Result<(), Error> {
        if bytes.iter().all(|b| *b == 0) {
            return Err(Error::MintRecipientZero);
        }
        let left_padded = bytes[..12].iter().all(|b| *b == 0);
        if evm_style != left_padded {
            return Err(Error::MintRecipientShape);
        }
        Ok(())
    }

    pub fn withdraw_fees(env: Env, amount: i128) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();
        Self::bump_instance_ttl(&env);

        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        let accrued = Self::get_accrued_fees(env.clone());
        if amount > accrued {
            return Err(Error::InsufficientAccruedFees);
        }
        let accrued_after = accrued - amount;
        env.storage()
            .instance()
            .set(&DataKey::AccruedFees, &accrued_after);

        let to = Self::get_fee_recipient(env.clone());
        token::Client::new(&env, &Self::get_usdc(env.clone())).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );

        FeesWithdrawn {
            to,
            amount,
            accrued_after,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_admin_or_pauser(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance_ttl(&env);
        WrapperPaused { by: caller }.publish(&env);
        Ok(())
    }

    /// Unpause is admin-only: a pauser can stop the world but not restart it.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone());
        admin.require_auth();
        if !Self::is_paused(env.clone()) {
            return Err(Error::NotPaused);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance_ttl(&env);
        WrapperUnpaused { by: admin }.publish(&env);
        Ok(())
    }

    pub fn propose_params(env: Env, params: Params) -> Result<u64, Error> {
        Self::get_admin(env.clone()).require_auth();
        Self::validate_params(&params)?;
        let eta = env.ledger().timestamp().saturating_add(TIMELOCK_SECS);
        env.storage().instance().set(
            &DataKey::PendingParams,
            &PendingParams {
                params: params.clone(),
                eta,
            },
        );
        Self::bump_instance_ttl(&env);
        ParamsProposed { params, eta }.publish(&env);
        Ok(eta)
    }

    pub fn commit_params(env: Env) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        let pending: PendingParams = env
            .storage()
            .instance()
            .get(&DataKey::PendingParams)
            .ok_or(Error::NothingPending)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }
        env.storage()
            .instance()
            .set(&DataKey::Params, &pending.params);
        env.storage().instance().remove(&DataKey::PendingParams);
        Self::bump_instance_ttl(&env);
        ParamsCommitted {
            params: pending.params,
        }
        .publish(&env);
        Ok(())
    }

    pub fn tighten_params(env: Env, params: Params) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        Self::validate_params(&params)?;
        let cur = Self::get_params(env.clone());
        let tighter = params.fee_bps <= cur.fee_bps
            && params.min_fee <= cur.min_fee
            && params.max_transfer <= cur.max_transfer
            && params.max_cctp_fee_bps <= cur.max_cctp_fee_bps
            && params.account_fee <= cur.account_fee
            && params.min_transfer >= cur.min_transfer;
        if !tighter {
            return Err(Error::NotTightening);
        }
        env.storage().instance().set(&DataKey::Params, &params);
        Self::bump_instance_ttl(&env);
        ParamsTightened { params }.publish(&env);
        Ok(())
    }

    /// The pauser's veto over every pending change, in one call.
    pub fn cancel_pending(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_admin_or_pauser(&env, &caller)?;
        let s = env.storage().instance();
        s.remove(&DataKey::PendingParams);
        s.remove(&DataKey::PendingAdmin);
        s.remove(&DataKey::PendingPauser);
        s.remove(&DataKey::PendingRecipient);
        s.remove(&DataKey::PendingDomain);
        Self::bump_instance_ttl(&env);
        PendingCancelled { by: caller }.publish(&env);
        Ok(())
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<u64, Error> {
        Self::get_admin(env.clone()).require_auth();
        let eta = env.ledger().timestamp().saturating_add(TIMELOCK_SECS);
        env.storage().instance().set(
            &DataKey::PendingAdmin,
            &PendingAddress {
                addr: new_admin.clone(),
                eta,
            },
        );
        Self::bump_instance_ttl(&env);
        AdminProposed { new_admin, eta }.publish(&env);
        Ok(eta)
    }

    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: PendingAddress = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NothingPending)?;
        pending.addr.require_auth();
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }
        let old_admin = Self::get_admin(env.clone());
        env.storage().instance().set(&DataKey::Admin, &pending.addr);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Self::bump_instance_ttl(&env);
        AdminChanged {
            old_admin,
            new_admin: pending.addr,
        }
        .publish(&env);
        Ok(())
    }

    /// Replacing the pauser is timelocked, and that is the point.
    ///
    /// The pauser's veto over pending proposals is the only defence against a stolen admin key
    /// during the 48h window. While this was instant that defence did not exist: an attacker
    /// holding the admin key would replace the pauser with themselves in one transaction, then
    /// propose maximum fees and a new fee recipient with nobody able to cancel them. Timelocked,
    /// the sitting pauser sees `pauser_proposed` and can `cancel_pending`.
    ///
    /// The cost is real and worth stating: if the pauser key is *lost*, rotating to a new one now
    /// takes 48 hours. That is the trade — a lost pauser key is an inconvenience, a stolen admin
    /// key is an incident.
    pub fn propose_pauser(env: Env, new_pauser: Address) -> Result<u64, Error> {
        Self::get_admin(env.clone()).require_auth();
        let eta = env.ledger().timestamp().saturating_add(TIMELOCK_SECS);
        env.storage().instance().set(
            &DataKey::PendingPauser,
            &PendingAddress {
                addr: new_pauser.clone(),
                eta,
            },
        );
        Self::bump_instance_ttl(&env);
        PauserProposed { new_pauser, eta }.publish(&env);
        Ok(eta)
    }

    pub fn commit_pauser(env: Env) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        let pending: PendingAddress = env
            .storage()
            .instance()
            .get(&DataKey::PendingPauser)
            .ok_or(Error::NothingPending)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }
        let old_pauser = Self::get_pauser(env.clone());
        env.storage().instance().set(&DataKey::Pauser, &pending.addr);
        env.storage().instance().remove(&DataKey::PendingPauser);
        Self::bump_instance_ttl(&env);
        PauserChanged {
            old_pauser,
            new_pauser: pending.addr,
        }
        .publish(&env);
        Ok(())
    }

    pub fn propose_fee_recipient(env: Env, new_recipient: Address) -> Result<u64, Error> {
        Self::get_admin(env.clone()).require_auth();
        let eta = env.ledger().timestamp().saturating_add(TIMELOCK_SECS);
        env.storage().instance().set(
            &DataKey::PendingRecipient,
            &PendingAddress {
                addr: new_recipient.clone(),
                eta,
            },
        );
        Self::bump_instance_ttl(&env);
        FeeRecipientProposed { new_recipient, eta }.publish(&env);
        Ok(eta)
    }

    pub fn commit_fee_recipient(env: Env) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        let pending: PendingAddress = env
            .storage()
            .instance()
            .get(&DataKey::PendingRecipient)
            .ok_or(Error::NothingPending)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }
        let old_recipient = Self::get_fee_recipient(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &pending.addr);
        env.storage().instance().remove(&DataKey::PendingRecipient);
        Self::bump_instance_ttl(&env);
        FeeRecipientChanged {
            old_recipient,
            new_recipient: pending.addr,
        }
        .publish(&env);
        Ok(())
    }
    
    pub fn propose_domain(env: Env, cfg: DomainCfg) -> Result<u64, Error> {
        Self::get_admin(env.clone()).require_auth();
        if cfg.domain == DOMAIN_STELLAR {
            return Err(Error::SelfDomain);
        }
        Self::validate_domain_cfg(&cfg)?;
        // v1 refused any domain already present. v2 lets the admin *replace* one, because turning
        // forwarding on or raising a cap has to go through here — but only under the same 48h
        // timelock as adding a domain, and never as a no-op.
        if Self::domain_cfg(&env, cfg.domain).as_ref() == Some(&cfg) {
            return Err(Error::DomainAlreadyAllowed);
        }
        let eta = env.ledger().timestamp().saturating_add(TIMELOCK_SECS);
        env.storage().instance().set(
            &DataKey::PendingDomain,
            &PendingDomain {
                cfg: cfg.clone(),
                eta,
            },
        );
        Self::bump_instance_ttl(&env);
        DomainProposed { cfg, eta }.publish(&env);
        Ok(eta)
    }

    pub fn commit_domain(env: Env) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        let pending: PendingDomain = env
            .storage()
            .instance()
            .get(&DataKey::PendingDomain)
            .ok_or(Error::NothingPending)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockNotElapsed);
        }
        let mut map = Self::domains(&env);
        map.set(pending.cfg.domain, pending.cfg.clone());
        env.storage().instance().set(&DataKey::Domains, &map);
        env.storage().instance().remove(&DataKey::PendingDomain);
        Self::bump_instance_ttl(&env);
        DomainAdded { cfg: pending.cfg }.publish(&env);
        Ok(())
    }

    /// Instant, exposure-reducing changes to a domain: turn forwarding off, or lower its cap.
    /// Admin **or pauser**, like `remove_domain` — it is the kill switch if Circle's service
    /// misbehaves or its hook format changes, and it must not wait 48 hours or need the admin.
    ///
    /// It can only tighten. Turning `forward` on or raising the cap is `propose_domain`. A call
    /// that changes nothing is refused so it cannot masquerade as activity.
    pub fn tighten_domain(
        env: Env,
        caller: Address,
        domain: u32,
        forward: bool,
        max_forward_fee: i128,
        account_creation: bool,
        max_forward_fee_new_account: i128,
    ) -> Result<(), Error> {
        Self::require_admin_or_pauser(&env, &caller)?;
        let mut map = Self::domains(&env);
        let old = map.get(domain).ok_or(Error::DomainNotAllowed)?;
        // Account creation rides on forwarding, so turning forwarding off turns it off too, and a
        // switched-off creation has no cap. Normalised here so the kill switch is one call and can
        // never leave a half-configured domain.
        let account_creation = account_creation && forward;
        let new_account_cap = if account_creation {
            max_forward_fee_new_account
        } else {
            0
        };
        if (forward && !old.forward)
            || max_forward_fee > old.max_forward_fee
            || max_forward_fee < 0
            || (account_creation && !old.account_creation)
            || new_account_cap > old.max_forward_fee_new_account
            || new_account_cap < 0
        {
            return Err(Error::NotTightening);
        }
        let cfg = DomainCfg {
            domain,
            evm_style: old.evm_style,
            forward,
            max_forward_fee,
            account_creation,
            max_forward_fee_new_account: new_account_cap,
        };
        if cfg == old {
            return Err(Error::NotTightening);
        }
        Self::validate_domain_cfg(&cfg)?;
        map.set(domain, cfg.clone());
        env.storage().instance().set(&DataKey::Domains, &map);
        Self::bump_instance_ttl(&env);
        DomainTightened { cfg, by: caller }.publish(&env);
        Ok(())
    }

    pub fn remove_domain(env: Env, caller: Address, domain: u32) -> Result<(), Error> {
        Self::require_admin_or_pauser(&env, &caller)?;
        let mut map = Self::domains(&env);
        if !map.contains_key(domain) {
            return Err(Error::DomainNotAllowed);
        }
        map.remove(domain);
        env.storage().instance().set(&DataKey::Domains, &map);
        Self::bump_instance_ttl(&env);
        DomainRemoved { domain }.publish(&env);
        Ok(())
    }

    pub fn get_usdc(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap()
    }

    pub fn get_token_messenger(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::TokenMessenger)
            .unwrap()
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_pauser(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Pauser).unwrap()
    }

    pub fn get_fee_recipient(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeRecipient).unwrap()
    }

    pub fn get_params(env: Env) -> Params {
        env.storage().instance().get(&DataKey::Params).unwrap()
    }

    pub fn get_accrued_fees(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AccruedFees)
            .unwrap_or(0)
    }

    pub fn get_seq(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Seq).unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_domains(env: Env) -> Vec<DomainCfg> {
        Self::domains(&env).values()
    }

    /// What a transfer of `amount` to `destination_domain` costs. `recipient_needs_account` and
    /// `max_fee` must match what will be passed to `bridge`, or the quote shown and the amount
    /// charged will differ. On the relay path `max_fee` does not affect the price and is ignored;
    /// on the forward path it *is* the delivery fee, so the price cannot be quoted without it.
    pub fn quote(
        env: Env,
        amount: i128,
        recipient_needs_account: bool,
        destination_domain: u32,
        max_fee: i128,
    ) -> Result<Quote, Error> {
        let p = Self::get_params(env.clone());
        if amount < p.min_transfer {
            return Err(Error::AmountBelowMin);
        }
        if amount > p.max_transfer {
            return Err(Error::AmountAboveMax);
        }
        let cfg = Self::domain_cfg(&env, destination_domain).ok_or(Error::DomainNotAllowed)?;
        if cfg.forward && (!recipient_needs_account || cfg.account_creation) {
            let mut q = Self::compute_forward_split(amount, p.fee_bps, p.min_fee, max_fee)?;
            q.account_created = cfg.account_creation && recipient_needs_account;
            Self::check_forward_fee(&q, &cfg)?;
            return Ok(q);
        }
        let account_fee = if recipient_needs_account {
            p.account_fee
        } else {
            0
        };
        Self::compute_split(amount, p.fee_bps, p.min_fee, account_fee)
    }

    /// A domain config must carry a cap no higher than the compile-time ceiling, and `forward`
    /// with no cap could never succeed (every forwarded `max_fee` must be positive).
    fn validate_domain_cfg(cfg: &DomainCfg) -> Result<(), Error> {
        if cfg.max_forward_fee < 0 || cfg.max_forward_fee > MAX_FORWARD_FEE_CEILING {
            return Err(Error::BadForwardConfig);
        }
        if cfg.forward && cfg.max_forward_fee == 0 {
            return Err(Error::BadForwardConfig);
        }
        if cfg.max_forward_fee_new_account < 0 || cfg.max_forward_fee_new_account > MAX_FORWARD_FEE_CEILING
        {
            return Err(Error::BadForwardConfig);
        }
        if cfg.account_creation {
            // The hook is Solana's, it rides on a forward, and a zero cap could never succeed.
            if !cfg.forward || cfg.evm_style || cfg.max_forward_fee_new_account == 0 {
                return Err(Error::BadForwardConfig);
            }
        } else if cfg.max_forward_fee_new_account != 0 {
            return Err(Error::BadForwardConfig);
        }
        Ok(())
    }

    fn validate_params(p: &Params) -> Result<(), Error> {
        if p.fee_bps > MAX_FEE_BPS_CEILING {
            return Err(Error::FeeBpsTooHigh);
        }
        if p.min_fee < 0 || p.min_fee > MAX_MIN_FEE_CEILING {
            return Err(Error::MinFeeTooHigh);
        }
        if p.min_transfer < MIN_TRANSFER_FLOOR {
            return Err(Error::MinTransferTooLow);
        }
        if p.max_transfer > MAX_TRANSFER_CEILING {
            return Err(Error::MaxTransferTooHigh);
        }
        if p.min_transfer >= p.max_transfer {
            return Err(Error::BadTransferRange);
        }
        if p.max_cctp_fee_bps > MAX_CCTP_FEE_BPS_CEILING {
            return Err(Error::CctpFeeBpsTooHigh);
        }
        if p.account_fee < 0 || p.account_fee > MAX_ACCOUNT_FEE_CEILING {
            return Err(Error::AccountFeeTooHigh);
        }
        Ok(())
    }

    fn require_admin_or_pauser(env: &Env, caller: &Address) -> Result<(), Error> {
        caller.require_auth();
        if *caller != Self::get_admin(env.clone()) && *caller != Self::get_pauser(env.clone()) {
            return Err(Error::NotAuthorized);
        }
        Ok(())
    }

    fn domains(env: &Env) -> Map<u32, DomainCfg> {
        env.storage()
            .instance()
            .get(&DataKey::Domains)
            .unwrap_or_else(|| Map::new(env))
    }

    fn domain_cfg(env: &Env, domain: u32) -> Option<DomainCfg> {
        Self::domains(env).get(domain)
    }

    fn next_seq(env: &Env) -> Result<u64, Error> {
        Self::get_seq(env.clone())
            .checked_add(1)
            .ok_or(Error::MathOverflow)
    }

    fn transfer_id(env: &Env, seq: u64, req: &BridgeRequest, q: &Quote) -> BytesN<32> {
        let payload = (
            env.current_contract_address(),
            seq,
            req.user.clone(),
            q.net_burned,
            req.destination_domain,
            req.mint_recipient.clone(),
        );
        let xdr: Bytes = payload.to_xdr(env);
        env.crypto().keccak256(&xdr).to_bytes()
    }

    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }
}

impl XebraCctpWrapper {
    /// Circle's extended forward hook, which asks the forwarder to create the recipient's Solana USDC
    /// token account (https://developers.circle.com/cctp/concepts/forwarding-service). 65 bytes:
    ///
    /// ```text
    /// 0..24   "cctp-forward", right-padded          (same magic as the plain hook)
    /// 24..28  version 0                              (big-endian uint32)
    /// 28..32  payload length, 33                     (big-endian uint32)
    /// 32      ATA-creation flag, 1
    /// 33..65  the account owner's 32-byte address
    /// ```
    ///
    /// The bytes are built here from the signed owner and nothing the caller can influence. This is
    /// the exact layout Circle's forwarder accepted on Stellar mainnet (2026-09-21, burn
    /// 7dcf762a…ada79), pinned by `the_account_hook_is_the_exact_65_bytes_mainnet_accepted`.
    pub fn forward_hook_with_account(env: &Env, owner: &BytesN<32>) -> Bytes {
        let mut header = [0u8; 28];
        header.copy_from_slice(&FORWARD_HOOK[..28]);
        let mut hook = Bytes::new(env);
        hook.extend_from_array(&header);
        hook.extend_from_array(&33u32.to_be_bytes());
        hook.extend_from_array(&[1u8]);
        hook.extend_from_array(&owner.to_array());
        hook
    }
}

#[cfg(test)]
mod test;