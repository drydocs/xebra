//! Tests for XebraCctpWrapper.
//!
//! The mock TokenMessenger records every argument it receives, which is what makes the
//! highest-severity risk in this crate — a transposition in the `deposit_for_burn` argument
//! list, where `amount`/`max_fee` are both `i128` and `mint_recipient`/`destination_caller`
//! are both `BytesN<32>` — a caught bug rather than a lost-funds incident. See
//! `test_bridge_passes_exact_arguments_to_circle`.
//!
//! `mock_all_auths()` bypasses the host's authorization checks, exactly as the escrow's
//! suite documents. It therefore does NOT prove that a real wallet produces an auth tree
//! covering both the fee transfer and the nested `deposit_for_burn`. That is the single
//! highest-value pre-launch check and it can only be done on testnet against a real signer —
//! it is tracked as a Phase 6 deliverable, not as something these tests cover.

use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger as _};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, Bytes, BytesN, Env,
    TryFromVal, Vec,
};

use crate::{
    BridgeRequest, DomainCfg, Error, Params, Quote, XebraCctpWrapper, XebraCctpWrapperClient,
    DOMAIN_ARC, DOMAIN_SOLANA, DOMAIN_STELLAR, FORWARD_HOOK, MAX_ACCOUNT_FEE_CEILING,
    MAX_FORWARD_FEE_CEILING, MAX_MIN_FEE_CEILING, TIMELOCK_SECS,
};

// ---------------------------------------------------------------------------
// Mock TokenMessengerMinter
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedCall {
    pub caller: Address,
    pub amount: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub burn_token: Address,
    pub destination_caller: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    /// `None` when the plain `deposit_for_burn` was called, `Some(hook)` for the hook variant.
    /// Which entry point was used is the whole difference between the two paths.
    pub hook_data: Option<Bytes>,
}

#[contracttype]
pub enum MockKey {
    Last,
    Panic,
}

#[contract]
pub struct MockMessenger;

#[contractimpl]
impl MockMessenger {
    pub fn __constructor(env: Env, should_panic: bool) {
        env.storage().instance().set(&MockKey::Panic, &should_panic);
    }

    /// Signature must match `crate::TokenMessenger` exactly — that is the point of the test.
    /// Pulls `amount` from `caller` to model Circle's burn, so balance assertions are real.
    pub fn deposit_for_burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        Self::burn(
            env,
            caller,
            amount,
            destination_domain,
            mint_recipient,
            burn_token,
            destination_caller,
            max_fee,
            min_finality_threshold,
            None,
        );
    }

    /// Circle's `deposit_for_burn_with_hook`, argument order as read from the live mainnet
    /// interface. A transposition here is as dangerous as in `deposit_for_burn`, and the tests
    /// pin every argument of it too.
    pub fn deposit_for_burn_with_hook(
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
    ) {
        // Circle's `HookDataEmpty` (error 7107): an empty hook is refused, so the wrapper must
        // never send one.
        if hook_data.is_empty() {
            panic!("HookDataEmpty");
        }
        Self::burn(
            env,
            caller,
            amount,
            destination_domain,
            mint_recipient,
            burn_token,
            destination_caller,
            max_fee,
            min_finality_threshold,
            Some(hook_data),
        );
    }

    fn burn(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Option<Bytes>,
    ) {
        let should_panic: bool = env
            .storage()
            .instance()
            .get(&MockKey::Panic)
            .unwrap_or(false);
        if should_panic {
            panic!("circle rejected the burn");
        }
        // Mirrors circlefin/stellar-cctp's `deposit_and_burn` exactly:
        //
        //     token_client.transfer_from(&contract_address, from, &contract_address, &amount);
        //
        // This MUST be transfer_from, not transfer. A SAC's transfer_from consumes an
        // allowance ledger entry, and `mock_all_auths()` does not create allowances — it only
        // satisfies `require_auth`. An earlier version of this mock used `transfer`, which
        // needs no allowance, so the suite passed while the real contract reverted on mainnet
        // with "not enough allowance to spend" (SAC contract error #9).
        token::Client::new(&env, &burn_token).transfer_from(
            &env.current_contract_address(),
            &caller,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().instance().set(
            &MockKey::Last,
            &RecordedCall {
                caller,
                amount,
                destination_domain,
                mint_recipient,
                burn_token,
                destination_caller,
                max_fee,
                min_finality_threshold,
                hook_data,
            },
        );
    }

    pub fn last_call(env: Env) -> Option<RecordedCall> {
        env.storage().instance().get(&MockKey::Last)
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FEE_BPS: u32 = 10; // 0.10%
const MIN_FEE: i128 = 5000000; // 0.5 USDC
const MIN_TRANSFER: i128 = 10_0000000; // 10 USDC
const MAX_TRANSFER: i128 = 100_000_0000000; // 100k USDC
const MAX_CCTP_FEE_BPS: u32 = 20;
const ACCOUNT_FEE: i128 = 5000000; // 0.5 USDC, roughly Solana token-account rent
const ARC_FORWARD_CAP: i128 = 1_000_000; // 0.10 USDC

#[allow(dead_code)]
struct Setup<'a> {
    env: Env,
    wrapper: XebraCctpWrapperClient<'a>,
    messenger: MockMessengerClient<'a>,
    token: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
    usdc: Address,
    user: Address,
    admin: Address,
    pauser: Address,
    fee_recipient: Address,
}

fn default_params() -> Params {
    Params {
        fee_bps: FEE_BPS,
        min_fee: MIN_FEE,
        min_transfer: MIN_TRANSFER,
        max_transfer: MAX_TRANSFER,
        max_cctp_fee_bps: MAX_CCTP_FEE_BPS,
        account_fee: ACCOUNT_FEE,
    }
}

fn setup() -> Setup<'static> {
    setup_with(false, default_params())
}

fn setup_with(messenger_panics: bool, params: Params) -> Setup<'static> {
    // Solana on the relay path only: exactly what v1 shipped, so every v1 test still means what it
    // meant. The forwarding behaviour is tested against `setup_forward`.
    setup_full(messenger_panics, params, |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_SOLANA,
                evm_style: false,
                forward: false,
                max_forward_fee: 0,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    })
}

/// Solana on the relay path, Arc forwarded with a 0.10 USDC cap — the shape planned for mainnet.
fn setup_forward() -> Setup<'static> {
    setup_full(false, default_params(), |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_SOLANA,
                evm_style: false,
                forward: false,
                max_forward_fee: 0,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: ARC_FORWARD_CAP,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    })
}

fn setup_forward_with(params: Params) -> Setup<'static> {
    setup_full(false, params, |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_SOLANA,
                evm_style: false,
                forward: false,
                max_forward_fee: 0,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: ARC_FORWARD_CAP,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    })
}

/// Solana forwarded too (0.15 USDC cap): the case where `recipient_needs_account` decides the path.
fn setup_forward_solana() -> Setup<'static> {
    setup_full(false, default_params(), |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_SOLANA,
                evm_style: false,
                forward: true,
                max_forward_fee: 1_500_000,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: ARC_FORWARD_CAP,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    })
}

fn setup_full(
    messenger_panics: bool,
    params: Params,
    domains_for: fn(&Env) -> Vec<DomainCfg>,
) -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let usdc = sac.address();
    let token = token::Client::new(&env, &usdc);
    let token_admin = token::StellarAssetClient::new(&env, &usdc);

    let messenger_id = env.register(MockMessenger, (messenger_panics,));
    let messenger = MockMessengerClient::new(&env, &messenger_id);

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    let domains: Vec<DomainCfg> = domains_for(&env);

    let wrapper_id = env.register(
        XebraCctpWrapper,
        (
            usdc.clone(),
            messenger_id.clone(),
            admin.clone(),
            pauser.clone(),
            fee_recipient.clone(),
            params,
            domains,
        ),
    );
    let wrapper = XebraCctpWrapperClient::new(&env, &wrapper_id);

    let user = Address::generate(&env);
    token_admin.mint(&user, &10_000_0000000i128); // 10,000 USDC

    Setup {
        env,
        wrapper,
        messenger,
        token,
        token_admin,
        usdc,
        user,
        admin,
        pauser,
        fee_recipient,
    }
}

/// A 32-byte value shaped like a Solana pubkey (no 12-byte zero prefix).
fn solana_recipient(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

/// A 32-byte value shaped like a left-padded EVM address.
fn evm_recipient(env: &Env) -> BytesN<32> {
    let mut b = [0u8; 32];
    for i in 12..32 {
        b[i] = 9;
    }
    BytesN::from_array(env, &b)
}

fn req(s: &Setup, amount: i128) -> BridgeRequest {
    BridgeRequest {
        user: s.user.clone(),
        amount,
        destination_domain: DOMAIN_SOLANA,
        mint_recipient: solana_recipient(&s.env),
        max_fee: 1000000, // 0.1 USDC
        min_finality_threshold: 1000,
        max_wrapper_fee: 100_0000000,
        recipient_needs_account: false,
        recipient_owner: BytesN::from_array(&s.env, &[0u8; 32]),
        // What a frontend supplies from `getLatestLedger` at simulation time.
        approval_expiration_ledger: s.env.ledger().sequence() + 30,
        deadline: s.env.ledger().timestamp() + 600,
    }
}

// ---------------------------------------------------------------------------
// Pure fee math
// ---------------------------------------------------------------------------

#[test]
fn compute_split_uses_bps_when_above_floor() {
    // 1,000 USDC at 10bps = 1 USDC, which is above the 0.5 USDC floor.
    let q = XebraCctpWrapper::compute_split(1_000_0000000, FEE_BPS, MIN_FEE, 0).unwrap();
    assert_eq!(q.fee, 1_0000000);
    assert_eq!(q.net_burned, 999_0000000);
    assert_eq!(q.remainder, 0);
}

#[test]
fn compute_split_uses_floor_when_bps_below_it() {
    // 100 USDC at 10bps = 0.1 USDC, below the 0.5 USDC floor, so the floor wins.
    let q = XebraCctpWrapper::compute_split(100_0000000, FEE_BPS, MIN_FEE, 0).unwrap();
    assert_eq!(q.fee, MIN_FEE);
    assert_eq!(q.net_burned, 100_0000000 - MIN_FEE);
    assert_eq!(q.remainder, 0);
}

#[test]
fn compute_split_normalizes_net_to_ten_stroop_boundary() {
    // Chosen so `amount - fee` is not a multiple of 10.
    let amount = 100_0000007i128;
    let q = XebraCctpWrapper::compute_split(amount, 0, 0, 0).unwrap();
    assert_eq!(q.fee, 0);
    assert_eq!(q.remainder, 7);
    assert_eq!(q.net_burned, 100_0000000);
    assert_eq!(q.net_burned % 10, 0);
    // The user is debited fee + net, never `amount`; the remainder never leaves their wallet.
    assert_eq!(q.fee + q.net_burned + q.remainder, amount);
}

#[test]
fn compute_split_conserves_value_across_a_wide_range() {
    // Stands in for a property test: every split must recompose to exactly `amount`, and
    // `net_burned` must always be canonically representable.
    let mut amount = MIN_TRANSFER;
    while amount < 50_000_0000000 {
        let q = XebraCctpWrapper::compute_split(amount, FEE_BPS, MIN_FEE, 0).unwrap();
        assert_eq!(q.fee + q.net_burned + q.remainder, amount);
        assert_eq!(q.net_burned % 10, 0);
        assert!(q.remainder >= 0 && q.remainder < 10);
        assert!(q.fee >= MIN_FEE);
        assert!(q.net_burned > 0);
        amount = amount + 999_999_7;
    }
}

#[test]
fn compute_split_rejects_amount_at_or_below_fee() {
    // min_fee is 0.5 USDC; an amount equal to it leaves nothing to burn.
    assert_eq!(
        XebraCctpWrapper::compute_split(MIN_FEE, 0, MIN_FEE, 0),
        Err(Error::AmountBelowFee)
    );
}

#[test]
fn compute_split_rejects_parameters_above_hard_ceilings() {
    assert_eq!(
        XebraCctpWrapper::compute_split(100_0000000, 101, 0, 0),
        Err(Error::FeeBpsTooHigh)
    );
    assert_eq!(
        XebraCctpWrapper::compute_split(100_0000000, 10, 6_0000000, 0),
        Err(Error::MinFeeTooHigh)
    );
}

#[test]
fn compute_split_rejects_non_positive_amount() {
    assert_eq!(
        XebraCctpWrapper::compute_split(0, 10, 0, 0),
        Err(Error::AmountNotPositive)
    );
    assert_eq!(
        XebraCctpWrapper::compute_split(-1, 10, 0, 0),
        Err(Error::AmountNotPositive)
    );
}

// ---------------------------------------------------------------------------
// max_fee bounding
// ---------------------------------------------------------------------------

#[test]
fn check_max_fee_rounds_up_to_canonical_boundary() {
    // Rounding down would silently drop the allowance below the quote and downgrade a
    // paid-for Fast transfer to Standard.
    let out = XebraCctpWrapper::check_max_fee(1_000_0000000, 1_000_0001, MAX_CCTP_FEE_BPS).unwrap();
    assert_eq!(out, 1_000_0010);
    assert_eq!(out % 10, 0);
}

#[test]
fn check_max_fee_rejects_absurd_values() {
    let net = 1_000_0000000i128;
    // Half the principal to Circle's fee recipient must never be accepted.
    assert_eq!(
        XebraCctpWrapper::check_max_fee(net, net / 2, MAX_CCTP_FEE_BPS),
        Err(Error::MaxFeeTooHigh)
    );
    // Equal to net panics inside Circle; reject well before that.
    assert_eq!(
        XebraCctpWrapper::check_max_fee(net, net, MAX_CCTP_FEE_BPS),
        Err(Error::MaxFeeExceedsNet)
    );
    assert_eq!(
        XebraCctpWrapper::check_max_fee(net, -1, MAX_CCTP_FEE_BPS),
        Err(Error::MaxFeeNegative)
    );
}

#[test]
fn check_max_fee_allows_the_flat_floor_on_small_transfers() {
    // 10 USDC at 20bps is 0.02 USDC, below Circle's flat fee floor, so the 1 USDC
    // allowance applies — but the net/10 backstop caps it at exactly 1 USDC here.
    let net = 10_0000000i128;
    assert!(XebraCctpWrapper::check_max_fee(net, 1_0000000, MAX_CCTP_FEE_BPS).is_ok());
    assert_eq!(
        XebraCctpWrapper::check_max_fee(net, 1_0000010, MAX_CCTP_FEE_BPS),
        Err(Error::MaxFeeTooHigh)
    );
}

// ---------------------------------------------------------------------------
// The critical argument-order test
// ---------------------------------------------------------------------------

#[test]
fn test_bridge_passes_exact_arguments_to_circle() {
    let s = setup();
    let r = req(&s, 1_000_0000000);
    let q = s.wrapper.bridge(&r);

    let call = s.messenger.last_call().unwrap();

    // Argument-by-argument. A transposition of the two i128s or the two BytesN<32>s would
    // type-check and deploy; this is what catches it.
    assert_eq!(call.caller, s.user, "caller must be the USER, not the wrapper");
    assert_eq!(call.amount, q.net_burned, "amount must be net, not gross");
    assert_eq!(call.destination_domain, DOMAIN_SOLANA);
    assert_eq!(call.mint_recipient, solana_recipient(&s.env));
    assert_eq!(call.burn_token, s.usdc);
    assert_eq!(
        call.destination_caller,
        BytesN::from_array(&s.env, &[0u8; 32]),
        "destination_caller MUST be zero so anyone can mint — a non-zero value here turns a \
         relay outage into permanent fund loss"
    );
    assert_eq!(call.max_fee, r.max_fee);
    assert_eq!(call.min_finality_threshold, 1000);
    // amount and max_fee must not be swapped.
    assert_ne!(call.amount, call.max_fee);
}

#[test]
fn bridge_debits_user_exactly_fee_plus_net_and_accrues_the_fee() {
    let s = setup();
    let before = s.token.balance(&s.user);
    let r = req(&s, 1_000_0000007); // deliberately not a multiple of 10
    let q = s.wrapper.bridge(&r);

    assert_eq!(q.remainder, 7);
    assert_eq!(
        s.token.balance(&s.user),
        before - q.fee - q.net_burned,
        "the sub-10-stroop remainder must stay in the user's wallet"
    );
    assert_eq!(s.wrapper.get_accrued_fees(), q.fee);
    assert_eq!(
        s.token.balance(&s.wrapper.address),
        q.fee,
        "the wrapper holds fees only — never principal"
    );
}

// ---------------------------------------------------------------------------
// No-hang: every failure path must revert the whole transaction
// ---------------------------------------------------------------------------

#[test]
fn bridge_reverts_entirely_when_circle_panics() {
    // The single most important test in the suite. If Circle rejects the burn for any
    // reason, the user must keep every stroop — no fee taken, nothing stranded in the
    // wrapper. This is what would break if anyone ever wrapped the call in `try_*`.
    let s = setup_with(true, default_params());
    let before = s.token.balance(&s.user);

    let r = req(&s, 1_000_0000000);
    let res = s.wrapper.try_bridge(&r);
    assert!(res.is_err());

    assert_eq!(s.token.balance(&s.user), before, "user must be made whole");
    assert_eq!(s.token.balance(&s.wrapper.address), 0);
    assert_eq!(s.wrapper.get_accrued_fees(), 0);
}

#[test]
fn bridge_rejects_when_paused_without_touching_funds() {
    let s = setup();
    s.wrapper.pause(&s.pauser);
    let before = s.token.balance(&s.user);

    let r = req(&s, 1_000_0000000);
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::Paused.into()))
    );
    assert_eq!(s.token.balance(&s.user), before);
}

#[test]
fn bridge_rejects_expired_and_far_future_deadlines() {
    let s = setup();
    let mut r = req(&s, 1_000_0000000);

    r.deadline = s.env.ledger().timestamp();
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::RequestExpired.into()))
    );

    r.deadline = s.env.ledger().timestamp() + 7_200;
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::DeadlineTooFar.into()))
    );
}

#[test]
fn bridge_rejects_unlisted_and_self_domains() {
    let s = setup();
    let mut r = req(&s, 1_000_0000000);

    r.destination_domain = 6; // Base, not allowlisted in this fixture
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::DomainNotAllowed.into()))
    );

    r.destination_domain = DOMAIN_STELLAR;
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::SelfDomain.into())));
}

#[test]
fn bridge_rejects_mint_recipient_of_the_wrong_shape() {
    let s = setup();
    let mut r = req(&s, 1_000_0000000);

    // An EVM-shaped (left-padded) recipient sent to Solana would burn to an unownable
    // address.
    r.mint_recipient = evm_recipient(&s.env);
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::MintRecipientShape.into()))
    );

    r.mint_recipient = BytesN::from_array(&s.env, &[0u8; 32]);
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::MintRecipientZero.into()))
    );
}

#[test]
fn bridge_respects_the_users_own_fee_ceiling() {
    let s = setup();
    let mut r = req(&s, 1_000_0000000);
    r.max_wrapper_fee = 1; // 1 stroop, far below the real fee
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::WrapperFeeAboveUserCap.into()))
    );
}

#[test]
fn bridge_enforces_transfer_bounds() {
    let s = setup();
    let mut r = req(&s, MIN_TRANSFER - 1);
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::AmountBelowMin.into()))
    );

    r.amount = MAX_TRANSFER + 1;
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::AmountAboveMax.into()))
    );
}

#[test]
fn bridge_rejects_bad_finality_thresholds() {
    let s = setup();
    let mut r = req(&s, 1_000_0000000);
    r.min_finality_threshold = 0;
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::BadFinalityThreshold.into()))
    );
    r.min_finality_threshold = 2_001;
    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::BadFinalityThreshold.into()))
    );
}

// ---------------------------------------------------------------------------
// Fee withdrawal
// ---------------------------------------------------------------------------

#[test]
fn withdraw_fees_is_bounded_by_accrued_not_balance() {
    let s = setup();
    s.wrapper.bridge(&req(&s, 1_000_0000000));
    let accrued = s.wrapper.get_accrued_fees();

    // Someone donates USDC directly to the contract. It must NOT become withdrawable —
    // this is the property that stops `withdraw_fees` ever reaching non-fee balance.
    s.token_admin.mint(&s.wrapper.address, &50_0000000i128);

    assert_eq!(
        s.wrapper.try_withdraw_fees(&(accrued + 1)),
        Err(Ok(Error::InsufficientAccruedFees.into()))
    );

    s.wrapper.withdraw_fees(&accrued);
    assert_eq!(s.token.balance(&s.fee_recipient), accrued);
    assert_eq!(s.wrapper.get_accrued_fees(), 0);
    assert_eq!(s.token.balance(&s.wrapper.address), 50_0000000);
}

#[test]
fn withdraw_fees_always_pays_the_stored_recipient() {
    let s = setup();
    s.wrapper.bridge(&req(&s, 1_000_0000000));
    let accrued = s.wrapper.get_accrued_fees();
    s.wrapper.withdraw_fees(&accrued);
    // No entrypoint anywhere accepts a caller-supplied destination.
    assert_eq!(s.token.balance(&s.fee_recipient), accrued);
}

// ---------------------------------------------------------------------------
// Timelock and roles
// ---------------------------------------------------------------------------

#[test]
fn loosening_params_requires_the_full_timelock() {
    let s = setup();
    let mut p = default_params();
    p.fee_bps = 50; // a fee increase

    s.wrapper.propose_params(&p);
    assert_eq!(
        s.wrapper.try_commit_params(),
        Err(Ok(Error::TimelockNotElapsed.into()))
    );
    assert_eq!(s.wrapper.get_params().fee_bps, FEE_BPS, "unchanged until committed");

    s.env.ledger().set_timestamp(1_000_000 + 172_800);
    s.wrapper.commit_params();
    assert_eq!(s.wrapper.get_params().fee_bps, 50);
}

#[test]
fn tightening_params_is_immediate_but_only_downward() {
    let s = setup();
    let mut tighter = default_params();
    tighter.fee_bps = 5;
    tighter.max_transfer = 50_000_0000000;
    s.wrapper.tighten_params(&tighter);
    assert_eq!(s.wrapper.get_params().fee_bps, 5);

    let mut looser = s.wrapper.get_params();
    looser.fee_bps = 20;
    assert_eq!(
        s.wrapper.try_tighten_params(&looser),
        Err(Ok(Error::NotTightening.into()))
    );
}

#[test]
fn pauser_can_cancel_a_pending_fee_increase() {
    let s = setup();
    let mut p = default_params();
    p.fee_bps = 100;
    s.wrapper.propose_params(&p);

    s.wrapper.cancel_pending(&s.pauser);

    s.env.ledger().set_timestamp(1_000_000 + 172_800);
    assert_eq!(
        s.wrapper.try_commit_params(),
        Err(Ok(Error::NothingPending.into()))
    );
    assert_eq!(s.wrapper.get_params().fee_bps, FEE_BPS);
}

#[test]
fn admin_transfer_is_two_step_and_timelocked() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.wrapper.propose_admin(&new_admin);

    assert_eq!(
        s.wrapper.try_accept_admin(),
        Err(Ok(Error::TimelockNotElapsed.into()))
    );
    assert_eq!(s.wrapper.get_admin(), s.admin);

    s.env.ledger().set_timestamp(1_000_000 + 172_800);
    s.wrapper.accept_admin();
    assert_eq!(s.wrapper.get_admin(), new_admin);
}

#[test]
fn min_transfer_cannot_go_below_the_one_usdc_floor() {
    // A compile-time floor like the ceilings: no proposal, from any admin, gets under it.
    let s = setup();

    let mut p = default_params();
    p.min_transfer = 1_0000000 - 1;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::MinTransferTooLow.into()))
    );

    // Exactly the floor is allowed (it loosens, so it goes through the timelock like any loosening).
    let mut p = default_params();
    p.min_transfer = 1_0000000;
    assert!(s.wrapper.try_propose_params(&p).is_ok());
}

#[test]
fn params_can_never_exceed_the_hard_coded_ceilings() {
    // The defence against a compromised admin: these are compile-time constants and there
    // is no upgrade entrypoint, so no proposal can ever get past them.
    let s = setup();

    let mut p = default_params();
    p.fee_bps = 101;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::FeeBpsTooHigh.into()))
    );

    let mut p = default_params();
    p.min_fee = 5_0000001;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::MinFeeTooHigh.into()))
    );

    // The ceiling is Circle's own live per-message cap for USDC, read from mainnet: 10M USDC.
    // Above it the burn would be rejected by Circle anyway; failing here says why.
    let mut p = default_params();
    p.max_transfer = 100_000_000_000_001;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::MaxTransferTooHigh.into()))
    );

    let mut p = default_params();
    p.account_fee = MAX_ACCOUNT_FEE_CEILING + 1;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::AccountFeeTooHigh.into()))
    );

    let mut p = default_params();
    p.max_cctp_fee_bps = 51;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::CctpFeeBpsTooHigh.into()))
    );
}

#[test]
fn removing_a_domain_takes_effect_immediately() {
    let s = setup();
    s.wrapper.remove_domain(&s.pauser, &DOMAIN_SOLANA);
    assert_eq!(
        s.wrapper.try_bridge(&req(&s, 1_000_0000000)),
        Err(Ok(Error::DomainNotAllowed.into()))
    );
}

#[test]
fn quote_matches_what_bridge_actually_charges() {
    let s = setup();
    let amount = 1_234_5678901i128;
    let quoted: Quote = s.wrapper.quote(&amount, &false, &DOMAIN_SOLANA, &1000000);
    let actual = s.wrapper.bridge(&req(&s, amount));
    assert_eq!(quoted, actual);
}


// ---------------------------------------------------------------------------
// Authorization tree stability
//
// Soroban matches every sub-invocation against the signed authorization tree argument by
// argument. The tree is built during simulation and checked during execution, and those always
// happen at different ledgers — so any argument derived from `env.ledger().sequence()` cannot
// match, and the transfer fails with an authorization error rather than a contract error.
//
// This is invisible to every other test in this file, because they all run under
// `mock_all_auths()`, which bypasses matching entirely. These read the *recorded* tree instead.
// ---------------------------------------------------------------------------

/// Pulls the `approve` sub-invocation's expiration-ledger argument out of the recorded auth tree.
fn recorded_approve_expiration(env: &Env, usdc: &Address) -> Option<u32> {
    for (_addr, invocation) in env.auths() {
        for sub in invocation.sub_invocations.iter() {
            let AuthorizedFunction::Contract((contract, name, args)) = &sub.function else {
                continue;
            };
            if contract == usdc && *name == symbol_short!("approve") {
                // approve(from, spender, amount, expiration_ledger)
                let arg = args.get(3)?;
                return u32::try_from_val(env, &arg).ok();
            }
        }
    }
    None
}

#[test]
fn approval_expiry_comes_from_the_request_not_the_ledger() {
    // The whole point: the same signed request must produce the same authorization tree no
    // matter which ledger it is executed in. Before this was signed data, the expiry was
    // `sequence() + 60`, so simulating at ledger N and executing at N+1 produced two different
    // trees and the host rejected every transfer.
    let s = setup();
    s.env.ledger().set_sequence_number(500);
    // Built once, as a wallet would sign it once.
    let r = req(&s, 1_000_0000000);

    s.wrapper.bridge(&r);
    let first = recorded_approve_expiration(&s.env, &s.usdc);

    s.env.ledger().set_sequence_number(507);
    s.wrapper.bridge(&r);
    let second = recorded_approve_expiration(&s.env, &s.usdc);

    assert_eq!(first, Some(r.approval_expiration_ledger));
    assert_eq!(second, Some(r.approval_expiration_ledger));
    assert_eq!(first, second, "the auth tree must not move with the ledger");
}

#[test]
fn rejects_an_approval_expiry_that_has_already_passed() {
    // A transaction that sat unincluded past its allowance window. The SAC would panic with an
    // opaque host error; this fails cleanly so the UI can say "retry".
    let s = setup();
    let mut r = req(&s, 1_000_0000000);
    r.approval_expiration_ledger = s.env.ledger().sequence();
    s.env.ledger().set_sequence_number(s.env.ledger().sequence() + 10);

    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::ApprovalExpiryPast)));
}

#[test]
fn rejects_an_approval_that_would_outlive_the_transfer() {
    // A long-lived allowance to Circle's TokenMessenger is the one thing this design is careful
    // never to leave behind, so the ceiling is enforced on chain rather than trusted to the
    // caller.
    let s = setup();
    let mut r = req(&s, 1_000_0000000);
    r.approval_expiration_ledger = s.env.ledger().sequence() + 100_000;

    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::ApprovalExpiryTooFar))
    );
}


// ---------------------------------------------------------------------------
// The account fee
//
// Solana token-account rent is about 2,039,280 lamports and nobody can ever reclaim it —
// closing the account needs the owner's signature, which a sponsor does not have. Folding that
// into `min_fee` would charge every transfer for a cost only first-time recipients incur, which
// is what forced the floor up high enough to make small transfers unattractive.
// ---------------------------------------------------------------------------

#[test]
fn charges_the_account_fee_only_when_the_destination_needs_one() {
    let s = setup();
    let amount = 10_0000000; // the 10 USDC minimum

    let without = s.wrapper.quote(&amount, &false, &DOMAIN_SOLANA, &1000000);
    let with = s.wrapper.quote(&amount, &true, &DOMAIN_SOLANA, &1000000);

    // At the floor, a first-time recipient pays the rent and a repeat one does not.
    assert_eq!(without.fee, MIN_FEE);
    assert_eq!(without.account_fee, 0);
    assert_eq!(with.fee, MIN_FEE + ACCOUNT_FEE);
    assert_eq!(with.account_fee, ACCOUNT_FEE);
}

#[test]
fn the_account_fee_stacks_on_the_percentage_not_the_floor() {
    // On a large transfer the percentage dominates the floor, and the rent still has to be
    // covered — so it adds rather than being absorbed.
    let s = setup();
    let amount = 10_000_0000000; // 10,000 USDC; 0.10% = 10 USDC, far above the floor
    let q = s.wrapper.quote(&amount, &true, &DOMAIN_SOLANA, &1000000);
    assert_eq!(q.fee, 10_0000000 + ACCOUNT_FEE);
    assert_eq!(q.account_fee, ACCOUNT_FEE);
}

#[test]
fn the_user_is_debited_exactly_what_the_quote_said() {
    // The quote is what the UI shows before signing. If the debit differed, the fee would be
    // whatever the contract felt like at execution.
    let s = setup();
    let amount = 100_0000000;
    let mut r = req(&s, amount);
    r.recipient_needs_account = true;

    let before = s.token.balance(&s.user);
    let q = s.wrapper.bridge(&r);
    let after = s.token.balance(&s.user);

    assert_eq!(q.account_fee, ACCOUNT_FEE);
    assert_eq!(before - after, q.fee + q.net_burned);
    // The sub-10-stroop remainder never leaves the wallet.
    assert_eq!(before - after, amount - q.remainder);
}

#[test]
fn the_account_fee_counts_against_the_user_s_own_fee_ceiling() {
    // `max_wrapper_fee` is the user's protection against a parameter change between signing and
    // execution. It has to cover the total, or the rent would slip past it.
    let s = setup();
    let mut r = req(&s, 100_0000000);
    r.recipient_needs_account = true;
    r.max_wrapper_fee = MIN_FEE; // enough for the percentage part alone, not the rent

    assert_eq!(
        s.wrapper.try_bridge(&r),
        Err(Ok(Error::WrapperFeeAboveUserCap))
    );
}

#[test]
fn the_account_fee_is_capped_in_code_not_just_by_the_admin() {
    // A compromised admin must not be able to price the account fee arbitrarily.
    let s = setup();
    let mut p = default_params();
    p.account_fee = MAX_ACCOUNT_FEE_CEILING + 1;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::AccountFeeTooHigh))
    );
}

#[test]
fn the_burn_carries_the_full_amount_less_the_whole_fee() {
    // The sponsor is paid through `account_fee`, so what Circle burns must be reduced by it —
    // otherwise the rent would come out of our margin rather than the transfer.
    let s = setup();
    let mut r = req(&s, 100_0000000);
    r.recipient_needs_account = true;
    let q = s.wrapper.bridge(&r);

    let call = s.messenger.last_call().expect("Circle must have been called");
    assert_eq!(call.amount, q.net_burned);
    assert_eq!(q.fee, MIN_FEE + ACCOUNT_FEE);
}

// ---------------------------------------------------------------------------
// The pauser cannot be removed instantly
//
// The pauser's veto over pending proposals is the only defence against a stolen admin key
// during the 48h window. While replacing the pauser was instant that defence did not exist:
// one transaction removed it, and then nothing could be cancelled.
// ---------------------------------------------------------------------------

#[test]
fn replacing_the_pauser_waits_out_the_timelock() {
    let s = setup();
    let new_pauser = Address::generate(&s.env);

    let eta = s.wrapper.propose_pauser(&new_pauser);
    assert_eq!(eta, s.env.ledger().timestamp() + TIMELOCK_SECS);
    // Unchanged until committed.
    assert_eq!(s.wrapper.get_pauser(), s.pauser);
    assert_eq!(s.wrapper.try_commit_pauser(), Err(Ok(Error::TimelockNotElapsed)));

    s.env.ledger().set_timestamp(eta);
    s.wrapper.commit_pauser();
    assert_eq!(s.wrapper.get_pauser(), new_pauser);
}

#[test]
fn the_sitting_pauser_can_veto_its_own_replacement() {
    // This is the whole property. An attacker holding the admin key proposes a new pauser to
    // clear the way for a fee grab; the pauser sees `pauser_proposed` and cancels it.
    let s = setup();
    let attacker = Address::generate(&s.env);
    let eta = s.wrapper.propose_pauser(&attacker);

    s.wrapper.cancel_pending(&s.pauser);

    s.env.ledger().set_timestamp(eta);
    assert_eq!(s.wrapper.try_commit_pauser(), Err(Ok(Error::NothingPending)));
    assert_eq!(s.wrapper.get_pauser(), s.pauser);
}

#[test]
fn a_stolen_admin_key_cannot_strip_the_veto_before_grabbing_fees() {
    // The end-to-end version: propose a new pauser and maximum fees together, as an attacker
    // would. The pauser cancels both in one call, and neither lands.
    let s = setup();
    let attacker = Address::generate(&s.env);
    let mut greedy = default_params();
    greedy.fee_bps = 100; // the 1% ceiling
    greedy.min_fee = MAX_MIN_FEE_CEILING;

    s.wrapper.propose_pauser(&attacker);
    let eta = s.wrapper.propose_params(&greedy);

    s.wrapper.cancel_pending(&s.pauser);

    s.env.ledger().set_timestamp(eta);
    assert_eq!(s.wrapper.try_commit_pauser(), Err(Ok(Error::NothingPending)));
    assert_eq!(s.wrapper.try_commit_params(), Err(Ok(Error::NothingPending)));
    assert_eq!(s.wrapper.get_params(), default_params());
    assert_eq!(s.wrapper.get_pauser(), s.pauser);
}


// ===========================================================================
// v2: the forwarding path
//
// What is being protected. On this path Circle takes the WHOLE `max_fee` out of the recipient's
// mint (measured on testnet and mainnet, 2026-09-20), so a signed `max_fee` is a price, and every
// test below that bounds it is guarding the recipient's money. The other half is that the user
// still pays exactly what the quote said and the wrapper still never holds principal.
// ===========================================================================

const ARC_M: i128 = 215_000; // 0.0215 USDC, about Circle's Arc forward fee

fn arc_req(s: &Setup, amount: i128, max_fee: i128) -> BridgeRequest {
    BridgeRequest {
        user: s.user.clone(),
        amount,
        destination_domain: DOMAIN_ARC,
        mint_recipient: evm_recipient(&s.env),
        max_fee,
        // Stellar has no Fast Transfer; Standard is what forwarding was verified with.
        min_finality_threshold: 2000,
        max_wrapper_fee: 100_0000000,
        recipient_needs_account: false,
        recipient_owner: BytesN::from_array(&s.env, &[0u8; 32]),
        approval_expiration_ledger: s.env.ledger().sequence() + 30,
        deadline: s.env.ledger().timestamp() + 600,
    }
}

fn zero32(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

#[test]
fn forward_split_pays_circle_out_of_the_fee_not_on_top_of_it() {
    // 10 USDC to Arc: the familiar 0.5 USDC floor is the fee. 0.0215 of it is Circle's, the rest
    // is ours, and the recipient still gets amount - fee.
    let q = XebraCctpWrapper::compute_forward_split(100_000_000, FEE_BPS, MIN_FEE, ARC_M).unwrap();
    assert!(q.forwarded);
    assert_eq!(q.fee, MIN_FEE);
    assert_eq!(q.forward_fee, ARC_M);
    assert_eq!(q.wrapper_take, MIN_FEE - ARC_M);
    assert_eq!(q.account_fee, 0);
    assert_eq!(q.remainder, 0);
    assert_eq!(q.net_burned, 100_000_000 - (MIN_FEE - ARC_M));
    // What lands on Arc after Circle takes its fee: exactly amount - fee.
    assert_eq!(q.net_burned - q.forward_fee, 100_000_000 - MIN_FEE);
}

#[test]
fn forward_split_passes_gas_through_at_cost_when_it_exceeds_the_fee() {
    // 100 USDC to a chain whose forward fee (1.5 USDC) is above the 0.5 USDC floor: the user pays
    // the gas, we keep nothing on this transfer, and the transfer is not refused.
    let m = 15_000_000;
    let q = XebraCctpWrapper::compute_forward_split(1_000_000_000, FEE_BPS, MIN_FEE, m).unwrap();
    assert_eq!(q.fee, m);
    assert_eq!(q.wrapper_take, 0, "the take must never go negative");
    assert_eq!(q.net_burned, 1_000_000_000);
    assert_eq!(q.net_burned - q.forward_fee, 1_000_000_000 - m);
}

#[test]
fn forward_split_rounds_max_fee_up_to_a_canonical_boundary() {
    let q = XebraCctpWrapper::compute_forward_split(100_000_000, FEE_BPS, MIN_FEE, 215_003).unwrap();
    assert_eq!(q.forward_fee, 215_010);
    assert_eq!(q.forward_fee % 10, 0);
}

#[test]
fn forward_split_refuses_a_zero_or_negative_max_fee() {
    // Circle's forwarder cannot be paid nothing; a zero would only fail after the burn.
    assert_eq!(
        XebraCctpWrapper::compute_forward_split(100_000_000, FEE_BPS, MIN_FEE, 0),
        Err(Error::ForwardFeeZero)
    );
    assert_eq!(
        XebraCctpWrapper::compute_forward_split(100_000_000, FEE_BPS, MIN_FEE, -10),
        Err(Error::MaxFeeNegative)
    );
}

#[test]
fn forward_split_refuses_a_fee_that_would_leave_the_recipient_nothing() {
    // A max_fee equal to the whole burn would deliver zero.
    assert_eq!(
        XebraCctpWrapper::compute_forward_split(60_000_000, FEE_BPS, MIN_FEE, 60_000_000),
        Err(Error::MaxFeeExceedsNet)
    );
}

#[test]
fn forward_split_conserves_value_across_a_wide_range() {
    // Stands in for a property test. For every amount and forward fee, what leaves the user's
    // wallet recomposes to `amount`, and the recipient gets exactly amount - fee - remainder.
    for m in [10i128, 215_000, 1_000_000, 1_500_000, 2_000_000] {
        let mut amount = MIN_TRANSFER;
        while amount < 50_000_0000000 {
            let q = match XebraCctpWrapper::compute_forward_split(amount, FEE_BPS, MIN_FEE, m) {
                Ok(q) => q,
                Err(e) => panic!("amount {amount} fee {m}: {e:?}"),
            };
            assert_eq!(q.wrapper_take + q.net_burned + q.remainder, amount);
            assert_eq!(q.net_burned - q.forward_fee, amount - q.fee - q.remainder);
            assert_eq!(q.net_burned % 10, 0);
            assert!(q.wrapper_take >= 0);
            assert!(q.fee >= q.forward_fee);
            assert!(q.fee >= MIN_FEE, "we never charge less than the floor");
            assert!(q.net_burned > q.forward_fee);
            amount += 999_999_7;
        }
    }
}

#[test]
fn check_forward_fee_enforces_the_domain_cap_and_the_ten_percent_bound() {
    let cfg = DomainCfg {
        domain: DOMAIN_ARC,
        evm_style: true,
        forward: true,
        max_forward_fee: 15_000_000, // 1.5 USDC, deliberately generous
        account_creation: false,
        max_forward_fee_new_account: 0,
    };
    // Over the cap.
    let over = XebraCctpWrapper::compute_forward_split(1_000_000_000, FEE_BPS, MIN_FEE, 15_000_010)
        .unwrap();
    assert_eq!(
        XebraCctpWrapper::check_forward_fee(&over, &cfg),
        Err(Error::ForwardFeeAboveCap)
    );
    // Under the cap but more than a tenth of a small transfer: 1.5 USDC on 10 USDC is 15%.
    let big_on_small =
        XebraCctpWrapper::compute_forward_split(100_000_000, FEE_BPS, MIN_FEE, 15_000_000).unwrap();
    assert_eq!(
        XebraCctpWrapper::check_forward_fee(&big_on_small, &cfg),
        Err(Error::ForwardFeeTooHigh)
    );
    // Both satisfied.
    let ok = XebraCctpWrapper::compute_forward_split(1_000_000_000, FEE_BPS, MIN_FEE, 15_000_000)
        .unwrap();
    assert_eq!(XebraCctpWrapper::check_forward_fee(&ok, &cfg), Ok(()));
}

#[test]
fn the_forward_hook_is_exactly_cctp_forward_padded_to_32_bytes() {
    // The value verified on testnet and mainnet: 0x636374702d666f72776172640000…0000. A change
    // here silently turns every forward into a failed one, so it is pinned.
    assert_eq!(&FORWARD_HOOK[..12], b"cctp-forward");
    assert!(FORWARD_HOOK[12..].iter().all(|b| *b == 0));
    let mut hex = [0u8; 64];
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for (i, b) in FORWARD_HOOK.iter().enumerate() {
        hex[i * 2] = DIGITS[(b >> 4) as usize];
        hex[i * 2 + 1] = DIGITS[(b & 0xf) as usize];
    }
    assert_eq!(
        core::str::from_utf8(&hex).unwrap(),
        "636374702d666f72776172640000000000000000000000000000000000000000"
    );
}

// ---------------------------------------------------------------------------
// The wrapper on the forward path
// ---------------------------------------------------------------------------

#[test]
fn forward_bridge_calls_the_hook_entry_point_with_every_argument_pinned() {
    let s = setup_forward();
    let r = arc_req(&s, 100_000_000, ARC_M);
    let q = s.wrapper.bridge(&r);
    assert!(q.forwarded);

    let call = s.messenger.last_call().expect("Circle must have been called");
    assert_eq!(call.caller, s.user, "the user, never the wrapper, is the caller");
    assert_eq!(call.amount, q.net_burned);
    assert_eq!(call.destination_domain, DOMAIN_ARC);
    assert_eq!(call.mint_recipient, evm_recipient(&s.env));
    assert_eq!(call.burn_token, s.usdc);
    assert_eq!(
        call.destination_caller,
        zero32(&s.env),
        "anyone must be able to mint, or a failed forward strands the transfer"
    );
    assert_eq!(call.max_fee, ARC_M, "Circle is told exactly the fee the user signed");
    assert_eq!(call.min_finality_threshold, 2000);
    assert_eq!(
        call.hook_data,
        Some(Bytes::from_array(&s.env, &FORWARD_HOOK)),
        "exactly the forward hook, nothing else"
    );
}

#[test]
fn forward_bridge_debits_the_user_the_quoted_amount_and_only_our_take_reaches_the_wrapper() {
    let s = setup_forward();
    let before = s.token.balance(&s.user);
    let r = arc_req(&s, 100_000_003, ARC_M); // not a multiple of 10
    let q = s.wrapper.bridge(&r);

    assert_eq!(q.remainder, 3);
    assert_eq!(
        s.token.balance(&s.user),
        before - q.wrapper_take - q.net_burned,
        "the remainder stays with the user"
    );
    assert_eq!(s.wrapper.get_accrued_fees(), q.wrapper_take);
    assert_eq!(
        s.token.balance(&s.wrapper.address),
        q.wrapper_take,
        "the wrapper holds its own take only, never principal and never Circle's fee"
    );
    assert_eq!(s.token.balance(&s.messenger.address), q.net_burned);
    // The recipient's side of the promise: amount - fee - remainder arrives.
    assert_eq!(q.net_burned - q.forward_fee, 100_000_003 - q.fee - q.remainder);
}

#[test]
fn forward_bridge_keeps_nothing_when_gas_alone_meets_the_fee() {
    // With no percentage fee and no floor the whole fee is Circle's: nothing is pulled into the
    // wrapper and nothing accrues, and the solvency invariant still holds.
    let mut p = default_params();
    p.fee_bps = 0;
    p.min_fee = 0;
    let s = setup_forward_with(p);
    let before = s.token.balance(&s.user);
    let q = s.wrapper.bridge(&arc_req(&s, 100_000_000, ARC_M));

    assert_eq!(q.wrapper_take, 0);
    assert_eq!(q.fee, ARC_M);
    assert_eq!(s.wrapper.get_accrued_fees(), 0);
    assert_eq!(s.token.balance(&s.wrapper.address), 0);
    assert_eq!(s.token.balance(&s.user), before - q.net_burned - q.remainder);
}

#[test]
fn forward_bridge_reverts_entirely_when_circle_panics() {
    // The no-hang property, on the new path: if Circle refuses the hook burn the user keeps every
    // stroop — no take pulled, nothing stranded, nothing accrued.
    let s = setup_full(true, default_params(), |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: ARC_FORWARD_CAP,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    });
    let before = s.token.balance(&s.user);
    assert!(s.wrapper.try_bridge(&arc_req(&s, 100_000_000, ARC_M)).is_err());
    assert_eq!(s.token.balance(&s.user), before);
    assert_eq!(s.token.balance(&s.wrapper.address), 0);
    assert_eq!(s.wrapper.get_accrued_fees(), 0);
}

#[test]
fn forward_bridge_rejects_a_max_fee_above_the_domain_cap() {
    // The recipient's protection: Circle would take this in full.
    let s = setup_forward();
    let r = arc_req(&s, 100_000_000, ARC_FORWARD_CAP + 10);
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::ForwardFeeAboveCap)));
    // Exactly at the cap is fine.
    assert!(s.wrapper.try_bridge(&arc_req(&s, 100_000_000, ARC_FORWARD_CAP)).is_ok());
}

#[test]
fn forward_bridge_rejects_a_max_fee_that_is_a_tenth_of_the_transfer() {
    // 10 USDC with a 0.10 cap is fine; but a cap high enough to allow 1.5 USDC must still refuse
    // it on a 10 USDC transfer.
    let s = setup_full(false, default_params(), |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: MAX_FORWARD_FEE_CEILING,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    });
    assert_eq!(
        s.wrapper.try_bridge(&arc_req(&s, 100_000_000, 15_000_000)),
        Err(Ok(Error::ForwardFeeTooHigh))
    );
}

#[test]
fn forward_bridge_rejects_a_zero_max_fee() {
    let s = setup_forward();
    assert_eq!(
        s.wrapper.try_bridge(&arc_req(&s, 100_000_000, 0)),
        Err(Ok(Error::ForwardFeeZero))
    );
}

#[test]
fn the_users_own_fee_ceiling_covers_the_forward_fee_too() {
    // `max_wrapper_fee` bounds the TOTAL the user pays, forward fee included, so a params change
    // landing in the same ledger still cannot overcharge a signed request.
    let s = setup_forward();
    let mut r = arc_req(&s, 100_000_000, ARC_M);
    r.max_wrapper_fee = MIN_FEE - 10; // one canonical unit under the 0.5 USDC fee
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::WrapperFeeAboveUserCap)));
    r.max_wrapper_fee = MIN_FEE;
    assert!(s.wrapper.try_bridge(&r).is_ok());
}

#[test]
fn a_non_forward_domain_still_uses_the_plain_entry_point() {
    let s = setup_forward();
    let q = s.wrapper.bridge(&req(&s, 1_000_0000000)); // Solana, forward off
    assert!(!q.forwarded);
    assert_eq!(q.forward_fee, 0);
    assert_eq!(q.wrapper_take, q.fee);
    let call = s.messenger.last_call().unwrap();
    assert_eq!(call.hook_data, None, "the relay path must not carry a hook");
}

#[test]
fn a_recipient_needing_an_account_is_kept_on_the_relay_path_even_on_a_forwarded_domain() {
    // The plain forward hook does not create a Solana token account, so a first-time recipient
    // cannot be forwarded with it. That transfer must fall to the relay path — paying the account
    // fee that funds the relay creating it — instead of being refused or forwarded into a mint that
    // cannot land. (Circle's extended ATA-creation hook would lift this; not built here.)
    let s = setup_forward_solana();

    // 100 USDC, where the 0.5 USDC floor (not the 0.10%) is the base fee.
    let mut needs = req(&s, 100_0000000);
    needs.recipient_needs_account = true;
    let q = s.wrapper.bridge(&needs);
    assert!(!q.forwarded);
    assert_eq!(q.fee, MIN_FEE + ACCOUNT_FEE);
    assert_eq!(s.messenger.last_call().unwrap().hook_data, None);

    // The same domain with an existing account forwards.
    let mut has = req(&s, 100_0000000);
    has.max_fee = 1_000_000; // within the 0.15 cap
    let q2 = s.wrapper.bridge(&has);
    assert!(q2.forwarded);
    assert_eq!(q2.account_fee, 0);
    assert_eq!(
        s.messenger.last_call().unwrap().hook_data,
        Some(Bytes::from_array(&s.env, &FORWARD_HOOK))
    );
}

#[test]
fn quote_agrees_with_what_bridge_charges_on_the_forward_path() {
    let s = setup_forward();
    let quoted = s.wrapper.quote(&100_000_000, &false, &DOMAIN_ARC, &ARC_M);
    let charged = s.wrapper.bridge(&arc_req(&s, 100_000_000, ARC_M));
    assert_eq!(quoted, charged);
}

#[test]
fn quote_needs_a_known_domain_and_applies_the_same_bounds() {
    let s = setup_forward();
    assert_eq!(
        s.wrapper.try_quote(&100_000_000, &false, &99, &ARC_M),
        Err(Ok(Error::DomainNotAllowed))
    );
    assert_eq!(
        s.wrapper
            .try_quote(&100_000_000, &false, &DOMAIN_ARC, &(ARC_FORWARD_CAP + 10)),
        Err(Ok(Error::ForwardFeeAboveCap))
    );
    // On the relay path `max_fee` does not change the price.
    let a = s.wrapper.quote(&1_000_0000000, &false, &DOMAIN_SOLANA, &10);
    let b = s.wrapper.quote(&1_000_0000000, &false, &DOMAIN_SOLANA, &9_999_990);
    assert_eq!(a, b);
}

// ---------------------------------------------------------------------------
// Domain administration: the new surface a stolen key could try to abuse
// ---------------------------------------------------------------------------

#[test]
fn raising_a_forward_cap_waits_out_the_timelock() {
    let s = setup_forward();
    let raised = DomainCfg {
        domain: DOMAIN_ARC,
        evm_style: true,
        forward: true,
        max_forward_fee: ARC_FORWARD_CAP + 500_000,
        account_creation: false,
        max_forward_fee_new_account: 0,
    };
    let eta = s.wrapper.propose_domain(&raised);
    assert_eq!(eta, s.env.ledger().timestamp() + TIMELOCK_SECS);
    // Unchanged until committed: the old cap still binds.
    assert_eq!(
        s.wrapper.try_bridge(&arc_req(&s, 100_000_000, ARC_FORWARD_CAP + 10)),
        Err(Ok(Error::ForwardFeeAboveCap))
    );
    assert_eq!(s.wrapper.try_commit_domain(), Err(Ok(Error::TimelockNotElapsed)));

    s.env.ledger().set_timestamp(eta);
    s.wrapper.commit_domain();
    assert!(s
        .wrapper
        .try_bridge(&arc_req(&s, 100_000_000, ARC_FORWARD_CAP + 10))
        .is_ok());
}

#[test]
fn the_pauser_can_veto_a_pending_forward_change() {
    // A stolen admin key proposing a looser cap is exactly what the pauser exists to stop.
    let s = setup_forward();
    let eta = s.wrapper.propose_domain(&DomainCfg {
        domain: DOMAIN_ARC,
        evm_style: true,
        forward: true,
        max_forward_fee: MAX_FORWARD_FEE_CEILING,
        account_creation: false,
        max_forward_fee_new_account: 0,
    });
    s.wrapper.cancel_pending(&s.pauser);
    s.env.ledger().set_timestamp(eta);
    assert_eq!(s.wrapper.try_commit_domain(), Err(Ok(Error::NothingPending)));
}

#[test]
fn a_no_op_domain_proposal_is_refused_and_bad_forward_configs_are_rejected() {
    let s = setup_forward();
    let unchanged = DomainCfg {
        domain: DOMAIN_ARC,
        evm_style: true,
        forward: true,
        max_forward_fee: ARC_FORWARD_CAP,
        account_creation: false,
        max_forward_fee_new_account: 0,
    };
    assert_eq!(
        s.wrapper.try_propose_domain(&unchanged),
        Err(Ok(Error::DomainAlreadyAllowed))
    );

    // A cap above the compile-time ceiling cannot be configured by anyone.
    let mut too_high = unchanged.clone();
    too_high.max_forward_fee = MAX_FORWARD_FEE_CEILING + 10;
    assert_eq!(
        s.wrapper.try_propose_domain(&too_high),
        Err(Ok(Error::BadForwardConfig))
    );
    // `forward` with no cap could only ever fail.
    let mut no_cap = unchanged.clone();
    no_cap.max_forward_fee = 0;
    assert_eq!(
        s.wrapper.try_propose_domain(&no_cap),
        Err(Ok(Error::BadForwardConfig))
    );
    let mut negative = unchanged;
    negative.max_forward_fee = -1;
    assert_eq!(
        s.wrapper.try_propose_domain(&negative),
        Err(Ok(Error::BadForwardConfig))
    );
}

#[test]
fn the_pauser_can_switch_forwarding_off_instantly_and_the_relay_path_takes_over() {
    // The kill switch. If Circle's service misbehaves or changes its hook format, forwarding must
    // stop now, without the 48h timelock and without the admin — and transfers must keep working.
    let s = setup_forward();
    assert!(s.wrapper.bridge(&arc_req(&s, 100_000_000, ARC_M)).forwarded);

    s.wrapper.tighten_domain(&s.pauser, &DOMAIN_ARC, &false, &ARC_FORWARD_CAP, &false, &0);

    let q = s.wrapper.bridge(&arc_req(&s, 100_000_000, ARC_M));
    assert!(!q.forwarded);
    assert_eq!(s.messenger.last_call().unwrap().hook_data, None);
    assert_eq!(q.fee, MIN_FEE);
}

#[test]
fn tightening_can_lower_a_cap_but_never_raise_it_or_turn_forwarding_on() {
    let s = setup_forward();

    // Lower: takes effect at once.
    s.wrapper.tighten_domain(&s.admin, &DOMAIN_ARC, &true, &100_000, &false, &0);
    assert_eq!(
        s.wrapper.try_bridge(&arc_req(&s, 100_000_000, ARC_M)),
        Err(Ok(Error::ForwardFeeAboveCap))
    );

    // Raise: refused, that is a proposal.
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.admin, &DOMAIN_ARC, &true, &(ARC_FORWARD_CAP), &false, &0),
        Err(Ok(Error::NotTightening))
    );
    // Turn forwarding on for a domain that has it off: refused.
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.admin, &DOMAIN_SOLANA, &true, &100_000, &false, &0),
        Err(Ok(Error::NotTightening))
    );
    // A call that changes nothing is refused too.
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.admin, &DOMAIN_ARC, &true, &100_000, &false, &0),
        Err(Ok(Error::NotTightening))
    );
}

#[test]
fn only_the_admin_or_pauser_can_tighten_and_only_a_known_domain() {
    let s = setup_forward();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&stranger, &DOMAIN_ARC, &false, &ARC_FORWARD_CAP, &false, &0),
        Err(Ok(Error::NotAuthorized))
    );
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.pauser, &99, &false, &0, &false, &0),
        Err(Ok(Error::DomainNotAllowed))
    );
}


// ===========================================================================
// v2: the forwarder creates the recipient's Solana token account
//
// Circle's forwarder can create the USDC token account as part of the forward, given an extended
// hook (`cctp-forward`, version 0, length 33, a flag byte, the owner's 32 bytes). Proven on mainnet
// for Stellar -> Solana (docs/forwarding-wrapper.md). What is protected here: the hook is built by
// this contract from signed fields and nothing else, the fee for it has its own cap, and the wallet
// address can never be confused with the token account.
// ===========================================================================

/// The exact 65 bytes Circle's forwarder accepted on mainnet (burn 7dcf762a…ada79): the fixed header
/// with length 33, the ATA-creation flag, then the owner's public key.
const PROVEN_ACCOUNT_HOOK: [u8; 65] = [0x63, 0x63, 0x74, 0x70, 0x2d, 0x66, 0x6f, 0x72, 0x77, 0x61, 0x72, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x01, 0x9e, 0x2d, 0xb9, 0xde, 0x8d, 0x00, 0x82, 0x10, 0x50, 0x2e, 0xe1, 0x85, 0x1d, 0xdd, 0xe8, 0x21, 0xa3, 0x23, 0x9b, 0x03, 0x82, 0x43, 0xa9, 0x51, 0xc4, 0xb6, 0x4e, 0xd4, 0xdf, 0x6f, 0x98, 0x05];
/// The owner that hook was built for.
const PROVEN_OWNER: [u8; 32] = [0x9e, 0x2d, 0xb9, 0xde, 0x8d, 0x00, 0x82, 0x10, 0x50, 0x2e, 0xe1, 0x85, 0x1d, 0xdd, 0xe8, 0x21, 0xa3, 0x23, 0x9b, 0x03, 0x82, 0x43, 0xa9, 0x51, 0xc4, 0xb6, 0x4e, 0xd4, 0xdf, 0x6f, 0x98, 0x05];

const SOLANA_PLAIN_CAP: i128 = 1_500_000; // 0.15 USDC
const SOLANA_NEW_ACCOUNT_CAP: i128 = 4_000_000; // 0.40 USDC
const NEW_ACCOUNT_M: i128 = 3_615_410; // 0.361541, what Circle charged on mainnet

/// Solana forwarded with account creation on, plus Arc forwarded.
fn setup_forward_accounts() -> Setup<'static> {
    setup_full(false, default_params(), |env| {
        vec![
            env,
            DomainCfg {
                domain: DOMAIN_SOLANA,
                evm_style: false,
                forward: true,
                max_forward_fee: SOLANA_PLAIN_CAP,
                account_creation: true,
                max_forward_fee_new_account: SOLANA_NEW_ACCOUNT_CAP,
            },
            DomainCfg {
                domain: DOMAIN_ARC,
                evm_style: true,
                forward: true,
                max_forward_fee: ARC_FORWARD_CAP,
                account_creation: false,
                max_forward_fee_new_account: 0,
            },
        ]
    })
}

fn owner_of(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

/// A first-time Solana recipient: the token account does not exist, so the request names its owner.
fn new_account_req(s: &Setup, amount: i128, max_fee: i128, owner: BytesN<32>) -> BridgeRequest {
    let mut r = req(s, amount);
    r.max_fee = max_fee;
    r.min_finality_threshold = 2000;
    r.recipient_needs_account = true;
    r.recipient_owner = owner;
    r
}

#[test]
fn the_account_hook_is_the_exact_65_bytes_mainnet_accepted() {
    let env = Env::default();
    let owner = BytesN::from_array(&env, &PROVEN_OWNER);
    let hook = XebraCctpWrapper::forward_hook_with_account(&env, &owner);
    assert_eq!(hook, Bytes::from_array(&env, &PROVEN_ACCOUNT_HOOK));
    assert_eq!(hook.len(), 65);
}

#[test]
fn the_account_hook_is_the_fixed_header_the_flag_and_the_owner_and_nothing_else() {
    let env = Env::default();
    let a = XebraCctpWrapper::forward_hook_with_account(&env, &owner_of(&env, 0x11));
    let b = XebraCctpWrapper::forward_hook_with_account(&env, &owner_of(&env, 0x22));
    let mut ab = [0u8; 65];
    let mut bb = [0u8; 65];
    a.copy_into_slice(&mut ab);
    b.copy_into_slice(&mut bb);
    // Header and flag are identical for every owner; only the last 32 bytes differ.
    assert_eq!(&ab[..33], &bb[..33]);
    assert_eq!(&ab[..24], &FORWARD_HOOK[..24], "magic");
    assert_eq!(&ab[24..28], &[0, 0, 0, 0], "version 0");
    assert_eq!(&ab[28..32], &[0, 0, 0, 33], "payload length 33, big-endian");
    assert_eq!(ab[32], 1, "ATA-creation flag");
    assert_eq!(&ab[33..], &[0x11u8; 32]);
    assert_eq!(&bb[33..], &[0x22u8; 32]);
}

#[test]
fn a_first_time_recipient_is_forwarded_with_the_account_hook() {
    let s = setup_forward_accounts();
    let owner = owner_of(&s.env, 3);
    let q = s
        .wrapper
        .bridge(&new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, owner.clone()));

    assert!(q.forwarded);
    assert!(q.account_created);
    assert_eq!(q.account_fee, 0, "rent is inside Circle's fee, not a separate charge");

    let call = s.messenger.last_call().expect("Circle must have been called");
    assert_eq!(call.caller, s.user);
    assert_eq!(call.destination_domain, DOMAIN_SOLANA);
    assert_eq!(
        call.mint_recipient,
        solana_recipient(&s.env),
        "the token account, never the wallet"
    );
    assert_eq!(call.destination_caller, zero32(&s.env));
    assert_eq!(call.max_fee, q.forward_fee);
    assert_eq!(call.min_finality_threshold, 2000);
    assert_eq!(
        call.hook_data,
        Some(XebraCctpWrapper::forward_hook_with_account(&s.env, &owner)),
        "the account-creation hook, built from the signed owner"
    );
}

#[test]
fn account_creation_is_priced_out_of_the_fee_and_the_recipient_gets_amount_minus_fee() {
    // 10 USDC, the 0.5 USDC fee floor, and the 0.36 USDC Circle charged on mainnet to create an
    // account. It comes out of the fee: we keep the difference, the recipient gets amount - fee.
    let s = setup_forward_accounts();
    let before = s.token.balance(&s.user);
    let q = s
        .wrapper
        .bridge(&new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, owner_of(&s.env, 3)));

    assert_eq!(q.fee, MIN_FEE);
    assert_eq!(q.forward_fee, NEW_ACCOUNT_M);
    assert_eq!(q.wrapper_take, MIN_FEE - NEW_ACCOUNT_M);
    assert_eq!(q.net_burned - q.forward_fee, 100_000_000 - MIN_FEE);
    assert_eq!(s.token.balance(&s.user), before - q.wrapper_take - q.net_burned);
    assert_eq!(s.wrapper.get_accrued_fees(), q.wrapper_take);
    assert_eq!(s.token.balance(&s.wrapper.address), q.wrapper_take);
}

#[test]
fn account_creation_has_its_own_cap_and_the_plain_cap_does_not_apply_to_it() {
    let s = setup_forward_accounts();
    // 0.36 is above the 0.15 plain cap but inside the 0.40 account cap: allowed with an account…
    assert!(s
        .wrapper
        .try_bridge(&new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, owner_of(&s.env, 3)))
        .is_ok());
    // …and refused for an ordinary transfer to an existing account.
    let mut plain = req(&s, 100_000_000);
    plain.max_fee = NEW_ACCOUNT_M;
    plain.min_finality_threshold = 2000;
    assert_eq!(s.wrapper.try_bridge(&plain), Err(Ok(Error::ForwardFeeAboveCap)));
}

#[test]
fn the_account_cap_is_enforced_and_nothing_gets_past_it() {
    let s = setup_forward_accounts();
    assert_eq!(
        s.wrapper.try_bridge(&new_account_req(
            &s,
            100_000_000,
            SOLANA_NEW_ACCOUNT_CAP + 10,
            owner_of(&s.env, 3)
        )),
        Err(Ok(Error::ForwardFeeAboveCap))
    );
    // Exactly at the cap is fine.
    assert!(s
        .wrapper
        .try_bridge(&new_account_req(
            &s,
            100_000_000,
            SOLANA_NEW_ACCOUNT_CAP,
            owner_of(&s.env, 3)
        ))
        .is_ok());
}

#[test]
fn a_plain_forward_to_an_existing_account_still_uses_the_plain_hook() {
    let s = setup_forward_accounts();
    let mut r = req(&s, 100_000_000);
    r.max_fee = 1_000_000;
    r.min_finality_threshold = 2000;
    let q = s.wrapper.bridge(&r);
    assert!(q.forwarded);
    assert!(!q.account_created);
    assert_eq!(
        s.messenger.last_call().unwrap().hook_data,
        Some(Bytes::from_array(&s.env, &FORWARD_HOOK)),
        "no owner, no creation flag: the 32-byte hook"
    );
}

#[test]
fn creating_an_account_needs_an_owner() {
    let s = setup_forward_accounts();
    let r = new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, zero32(&s.env));
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::RecipientOwnerMissing)));
}

#[test]
fn an_owner_is_refused_when_the_account_does_not_need_creating() {
    // The signed request must mean one thing: an owner is only ever present when it is used.
    let s = setup_forward_accounts();
    let mut r = req(&s, 100_000_000);
    r.max_fee = 1_000_000;
    r.min_finality_threshold = 2000;
    r.recipient_owner = owner_of(&s.env, 3);
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::RecipientOwnerUnexpected)));
}

#[test]
fn the_wallet_address_can_never_be_the_mint_recipient() {
    // Passing the wallet where the token account belongs stranded the first mainnet burn. The
    // contract cannot derive the account, but it can refuse this exact confusion.
    let s = setup_forward_accounts();
    let same = solana_recipient(&s.env);
    let r = new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, same);
    assert_eq!(s.wrapper.try_bridge(&r), Err(Ok(Error::MintRecipientIsOwner)));
}

#[test]
fn with_account_creation_off_a_new_recipient_stays_on_the_relay_path_and_may_name_its_owner() {
    // Solana forwarded but account creation left off: the v1 behaviour, unchanged. The owner is
    // allowed here because a relay needs it to create the account itself.
    let s = setup_forward_solana();
    let mut r = req(&s, 100_000_0000);
    r.recipient_needs_account = true;
    r.recipient_owner = owner_of(&s.env, 3);
    let q = s.wrapper.bridge(&r);
    assert!(!q.forwarded);
    assert!(!q.account_created);
    assert_eq!(q.account_fee, ACCOUNT_FEE);
    assert_eq!(s.messenger.last_call().unwrap().hook_data, None);
}

#[test]
fn quote_agrees_with_bridge_on_the_account_creation_path() {
    let s = setup_forward_accounts();
    let quoted = s
        .wrapper
        .quote(&100_000_000, &true, &DOMAIN_SOLANA, &NEW_ACCOUNT_M);
    let charged = s
        .wrapper
        .bridge(&new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, owner_of(&s.env, 3)));
    assert_eq!(quoted, charged);
    assert!(quoted.account_created);
}

// ---------------------------------------------------------------------------
// Configuration: what an admin can and cannot set
// ---------------------------------------------------------------------------

fn solana_cfg(forward: bool, evm_style: bool, creation: bool, new_cap: i128) -> DomainCfg {
    DomainCfg {
        domain: DOMAIN_SOLANA,
        evm_style,
        forward,
        max_forward_fee: SOLANA_PLAIN_CAP,
        account_creation: creation,
        max_forward_fee_new_account: new_cap,
    }
}

#[test]
fn account_creation_config_must_make_sense() {
    let s = setup_forward();
    // creation on an EVM-shaped destination: the hook is Solana's
    assert_eq!(
        s.wrapper.try_propose_domain(&solana_cfg(true, true, true, 4_000_000)),
        Err(Ok(Error::BadForwardConfig))
    );
    // creation without forwarding: nothing to create it
    assert_eq!(
        s.wrapper.try_propose_domain(&solana_cfg(false, false, true, 4_000_000)),
        Err(Ok(Error::BadForwardConfig))
    );
    // creation with no cap could never succeed
    assert_eq!(
        s.wrapper.try_propose_domain(&solana_cfg(true, false, true, 0)),
        Err(Ok(Error::BadForwardConfig))
    );
    // a cap above the compile-time ceiling
    assert_eq!(
        s.wrapper
            .try_propose_domain(&solana_cfg(true, false, true, MAX_FORWARD_FEE_CEILING + 10)),
        Err(Ok(Error::BadForwardConfig))
    );
    // a cap with creation off is a contradiction
    assert_eq!(
        s.wrapper.try_propose_domain(&solana_cfg(true, false, false, 4_000_000)),
        Err(Ok(Error::BadForwardConfig))
    );
}

#[test]
fn enabling_account_creation_waits_out_the_timelock_and_the_pauser_can_veto_it() {
    let s = setup_forward_solana(); // Solana forwarded, creation off
    let cfg = solana_cfg(true, false, true, SOLANA_NEW_ACCOUNT_CAP);
    let eta = s.wrapper.propose_domain(&cfg);
    // Until committed, a new recipient is still on the relay path.
    let mut r = req(&s, 100_0000000);
    r.recipient_needs_account = true;
    assert!(!s.wrapper.bridge(&r).forwarded);
    assert_eq!(s.wrapper.try_commit_domain(), Err(Ok(Error::TimelockNotElapsed)));

    // The pauser vetoes a second proposal outright.
    s.wrapper.cancel_pending(&s.pauser);
    s.env.ledger().set_timestamp(eta);
    assert_eq!(s.wrapper.try_commit_domain(), Err(Ok(Error::NothingPending)));
}

#[test]
fn tightening_can_switch_account_creation_off_or_lower_its_cap_but_never_raise_or_enable_it() {
    let s = setup_forward_accounts();
    let plain = SOLANA_PLAIN_CAP;

    // Lower the account cap: takes effect at once.
    s.wrapper
        .tighten_domain(&s.pauser, &DOMAIN_SOLANA, &true, &plain, &true, &1_000_000);
    assert_eq!(
        s.wrapper.try_bridge(&new_account_req(&s, 100_000_000, NEW_ACCOUNT_M, owner_of(&s.env, 3))),
        Err(Ok(Error::ForwardFeeAboveCap))
    );
    // Raise it again: refused, that is a proposal.
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.pauser, &DOMAIN_SOLANA, &true, &plain, &true, &2_000_000),
        Err(Ok(Error::NotTightening))
    );
    // Switch creation off: a new recipient falls back to the relay path.
    s.wrapper
        .tighten_domain(&s.pauser, &DOMAIN_SOLANA, &true, &plain, &false, &0);
    let mut r = req(&s, 100_0000000);
    r.recipient_needs_account = true;
    let q = s.wrapper.bridge(&r);
    assert!(!q.forwarded);
    assert_eq!(q.account_fee, ACCOUNT_FEE);
    // Switch it back on instantly: refused.
    assert_eq!(
        s.wrapper
            .try_tighten_domain(&s.pauser, &DOMAIN_SOLANA, &true, &plain, &true, &1_000_000),
        Err(Ok(Error::NotTightening))
    );
}

#[test]
fn switching_forwarding_off_switches_account_creation_off_with_it() {
    // Creation depends on forwarding, so the kill switch must not need two steps or leave a
    // half-configured domain: turning `forward` off normalises the rest.
    let s = setup_forward_accounts();
    s.wrapper
        .tighten_domain(&s.pauser, &DOMAIN_SOLANA, &false, &SOLANA_PLAIN_CAP, &true, &SOLANA_NEW_ACCOUNT_CAP);
    let cfg = s
        .wrapper
        .get_domains()
        .iter()
        .find(|d| d.domain == DOMAIN_SOLANA)
        .unwrap();
    assert!(!cfg.forward);
    assert!(!cfg.account_creation);
    assert_eq!(cfg.max_forward_fee_new_account, 0);
}
