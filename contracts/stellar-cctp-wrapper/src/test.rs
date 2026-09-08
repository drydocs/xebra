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

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, BytesN, Env, Vec,
};

use crate::{
    BridgeRequest, DomainCfg, Error, Params, Quote, XebraCctpWrapper, XebraCctpWrapperClient,
    DOMAIN_SOLANA, DOMAIN_STELLAR,
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
    }
}

fn setup() -> Setup<'static> {
    setup_with(false, default_params())
}

fn setup_with(messenger_panics: bool, params: Params) -> Setup<'static> {
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

    let domains: Vec<DomainCfg> = vec![
        &env,
        DomainCfg {
            domain: DOMAIN_SOLANA,
            evm_style: false,
        },
    ];

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
        deadline: s.env.ledger().timestamp() + 600,
    }
}

// ---------------------------------------------------------------------------
// Pure fee math
// ---------------------------------------------------------------------------

#[test]
fn compute_split_uses_bps_when_above_floor() {
    // 1,000 USDC at 10bps = 1 USDC, which is above the 0.5 USDC floor.
    let q = XebraCctpWrapper::compute_split(1_000_0000000, FEE_BPS, MIN_FEE).unwrap();
    assert_eq!(q.fee, 1_0000000);
    assert_eq!(q.net_burned, 999_0000000);
    assert_eq!(q.remainder, 0);
}

#[test]
fn compute_split_uses_floor_when_bps_below_it() {
    // 100 USDC at 10bps = 0.1 USDC, below the 0.5 USDC floor, so the floor wins.
    let q = XebraCctpWrapper::compute_split(100_0000000, FEE_BPS, MIN_FEE).unwrap();
    assert_eq!(q.fee, MIN_FEE);
    assert_eq!(q.net_burned, 100_0000000 - MIN_FEE);
    assert_eq!(q.remainder, 0);
}

#[test]
fn compute_split_normalizes_net_to_ten_stroop_boundary() {
    // Chosen so `amount - fee` is not a multiple of 10.
    let amount = 100_0000007i128;
    let q = XebraCctpWrapper::compute_split(amount, 0, 0).unwrap();
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
        let q = XebraCctpWrapper::compute_split(amount, FEE_BPS, MIN_FEE).unwrap();
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
        XebraCctpWrapper::compute_split(MIN_FEE, 0, MIN_FEE),
        Err(Error::AmountBelowFee)
    );
}

#[test]
fn compute_split_rejects_parameters_above_hard_ceilings() {
    assert_eq!(
        XebraCctpWrapper::compute_split(100_0000000, 101, 0),
        Err(Error::FeeBpsTooHigh)
    );
    assert_eq!(
        XebraCctpWrapper::compute_split(100_0000000, 10, 6_0000000),
        Err(Error::MinFeeTooHigh)
    );
}

#[test]
fn compute_split_rejects_non_positive_amount() {
    assert_eq!(
        XebraCctpWrapper::compute_split(0, 10, 0),
        Err(Error::AmountNotPositive)
    );
    assert_eq!(
        XebraCctpWrapper::compute_split(-1, 10, 0),
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

    let mut p = default_params();
    p.max_transfer = 250_000_0000001;
    assert_eq!(
        s.wrapper.try_propose_params(&p),
        Err(Ok(Error::MaxTransferTooHigh.into()))
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
    let quoted: Quote = s.wrapper.quote(&amount);
    let actual = s.wrapper.bridge(&req(&s, amount));
    assert_eq!(quoted, actual);
}
