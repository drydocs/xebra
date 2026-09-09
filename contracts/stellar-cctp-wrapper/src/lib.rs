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
}

/// Per-destination-domain configuration. `evm_style` selects the `mint_recipient` shape
/// check: EVM addresses are 20 bytes left-padded into 32, Solana pubkeys fill all 32.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainCfg {
    pub domain: u32,
    pub evm_style: bool,
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
    /// The user's own ceiling on *our* fee. Without it, a `commit_params` landing in the
    /// same ledger could overcharge an already-signed request.
    pub max_wrapper_fee: i128,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub amount: i128,
    pub fee: i128,
    pub net_burned: i128,
    /// The sub-10-stroop remainder that is never transferred out of the user's wallet.
    pub remainder: i128,
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
    pub net_burned: i128,
    pub remainder: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub fee_bps: u32,
    pub min_fee: i128,
    pub burn_token: Address,
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
const MIN_TRANSFER_FLOOR: i128 = 10_0000000; // 10 USDC
/// 250k USDC. Circle's live mainnet `get_max_burn_amount_per_message` for USDC is
/// 100000000000000 stroops (10M USDC), so this sits two orders of magnitude inside it.
const MAX_TRANSFER_CEILING: i128 = 250_000_0000000;
const MAX_CCTP_FEE_BPS_CEILING: u32 = 50; // 0.50%
const MAX_CCTP_FLAT_FEE_CEILING: i128 = 1_0000000; // 1 USDC
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
        let q = Self::compute_split(req.amount, params.fee_bps, params.min_fee)?;

        if q.fee > req.max_wrapper_fee {
            return Err(Error::WrapperFeeAboveUserCap);
        }

        let max_fee = Self::check_max_fee(q.net_burned, req.max_fee, params.max_cctp_fee_bps)?;

        req.user
            .require_auth_for_args((req.clone(),).into_val(env));

        // --- effects before interactions (checks-effects-interactions) ---
        let seq = Self::next_seq(env)?;
        let accrued_after = Self::get_accrued_fees(env.clone())
            .checked_add(q.fee)
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

        // Pull ONLY the fee. Principal never transits this contract.
        if q.fee > 0 {
            usdc_client.transfer(&req.user, &wrapper, &q.fee);
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

        TokenMessengerClient::new(env, &messenger).deposit_for_burn(
            &req.user,
            &q.net_burned,
            &req.destination_domain,
            &req.mint_recipient,
            &usdc,
            &BytesN::from_array(env, &[0u8; 32]),
            &max_fee,
            &req.min_finality_threshold,
        );

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
            net_burned: q.net_burned,
            remainder: q.remainder,
            destination_domain: req.destination_domain,
            mint_recipient: req.mint_recipient.clone(),
            max_fee,
            min_finality_threshold: req.min_finality_threshold,
            fee_bps: params.fee_bps,
            min_fee: params.min_fee,
            burn_token: usdc,
        }
        .publish(env);

        Ok(q)
    }

    pub fn compute_split(amount: i128, fee_bps: u32, min_fee: i128) -> Result<Quote, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        if fee_bps > MAX_FEE_BPS_CEILING {
            return Err(Error::FeeBpsTooHigh);
        }
        if min_fee < 0 || min_fee > MAX_MIN_FEE_CEILING {
            return Err(Error::MinFeeTooHigh);
        }

        let pct = amount
            .checked_mul(fee_bps as i128)
            .ok_or(Error::MathOverflow)?
            / BPS_DENOM;
        let fee = if pct > min_fee { pct } else { min_fee };

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
            net_burned,
            remainder,
        })
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

    pub fn set_pauser(env: Env, new_pauser: Address) -> Result<(), Error> {
        Self::get_admin(env.clone()).require_auth();
        let old_pauser = Self::get_pauser(env.clone());
        env.storage().instance().set(&DataKey::Pauser, &new_pauser);
        Self::bump_instance_ttl(&env);
        PauserChanged {
            old_pauser,
            new_pauser,
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
        if Self::domain_cfg(&env, cfg.domain).is_some() {
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

    pub fn quote(env: Env, amount: i128) -> Result<Quote, Error> {
        let p = Self::get_params(env.clone());
        if amount < p.min_transfer {
            return Err(Error::AmountBelowMin);
        }
        if amount > p.max_transfer {
            return Err(Error::AmountAboveMax);
        }
        Self::compute_split(amount, p.fee_bps, p.min_fee)
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

#[cfg(test)]
mod test;