use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Bytes, BytesN, Env};

use crate::{Error, Intent, Status, XebraEscrow, XebraEscrowClient, CHAIN_SOLANA};

const CHALLENGE_WINDOW: u64 = 1800; // 30 min, testnet default

// token_admin/arbiter aren't read by every test but are part of the fixture's shape; `resolve`'s
// arbiter-authorization check is host-enforced (`arbiter.require_auth()` against the *stored*
// arbiter, not `caller == arbiter`) so, unlike Arc's hand-rolled check, there is no
// contract-logic branch here to exercise with a "wrong arbiter" unit test — `mock_all_auths()`
// deliberately bypasses that host-level check the same way it bypasses `open`'s signature check.
#[allow(dead_code)]
struct Setup<'a> {
    env: Env,
    escrow: XebraEscrowClient<'a>,
    token: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
    user: Address,
    solver: Address,
    challenger: Address,
    arbiter: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let token_issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_issuer);
    let token = token::Client::new(&env, &sac.address());
    let token_admin = token::StellarAssetClient::new(&env, &sac.address());

    let arbiter = Address::generate(&env);
    let escrow_id = env.register(
        XebraEscrow,
        (sac.address(), arbiter.clone(), CHALLENGE_WINDOW),
    );
    let escrow = XebraEscrowClient::new(&env, &escrow_id);

    let user = Address::generate(&env);
    let solver = Address::generate(&env);
    let challenger = Address::generate(&env);

    token_admin.mint(&user, &1_000_0000000i128); // 1,000 USDC, 7 decimals
    token_admin.mint(&solver, &100_0000000i128);
    token_admin.mint(&challenger, &100_0000000i128);

    Setup {
        env,
        escrow,
        token,
        token_admin,
        user,
        solver,
        challenger,
        arbiter,
    }
}

fn default_intent(s: &Setup, nonce: u128) -> Intent {
    Intent {
        user: s.user.clone(),
        source_token: s.token.address.clone(),
        source_amount: 100_0000000i128, // 100 USDC, 7 decimals
        dest_chain: CHAIN_SOLANA,
        dest_asset: BytesN::from_array(&s.env, &[0u8; 32]), // native SOL, placeholder
        min_dest_amount: 900_000_000i128,
        dest_address: BytesN::from_array(&s.env, &[7u8; 32]),
        expiry: s.env.ledger().timestamp() + 3600,
        nonce,
    }
}

fn open_default(s: &Setup) -> (BytesN<32>, Intent) {
    let intent = default_intent(s, 1);
    let hash = s.escrow.open(&intent);
    (hash, intent)
}

fn claim_default(s: &Setup, intent_hash: &BytesN<32>) {
    let dest_tx_ref = Bytes::from_array(&s.env, &[9u8; 64]);
    s.escrow
        .claim(intent_hash, &s.solver, &dest_tx_ref, &900_000_000i128);
}

// --- open --------------------------------------------------------------

#[test]
fn open_pulls_escrow_and_sets_status() {
    let s = setup();
    let (hash, _intent) = open_default(&s);

    assert_eq!(s.escrow.status_of(&hash), Status::Open);
    assert_eq!(s.token.balance(&s.escrow.address), 100_0000000i128);
    assert_eq!(s.token.balance(&s.user), 900_0000000i128);
}

#[test]
fn open_rejects_reused_nonce() {
    let s = setup();
    let (_hash, intent) = open_default(&s);

    let mut replay = intent.clone();
    replay.dest_address = BytesN::from_array(&s.env, &[1u8; 32]);

    let result = s.escrow.try_open(&replay);
    assert_eq!(result, Err(Ok(Error::NonceTooLow)));
}

#[test]
fn open_rejects_expired_intent() {
    let s = setup();
    let mut intent = default_intent(&s, 1);
    intent.expiry = s.env.ledger().timestamp();

    let result = s.escrow.try_open(&intent);
    assert_eq!(result, Err(Ok(Error::IntentExpired)));
}

#[test]
fn open_rejects_wrong_source_token() {
    let s = setup();
    let mut intent = default_intent(&s, 1);
    let other_issuer = Address::generate(&s.env);
    let other_sac = s.env.register_stellar_asset_contract_v2(other_issuer);
    intent.source_token = other_sac.address();

    let result = s.escrow.try_open(&intent);
    assert_eq!(result, Err(Ok(Error::InvalidSourceToken)));
}

// --- claim ---------------------------------------------------------------

#[test]
fn claim_moves_state_to_claimed_and_pulls_bond() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    let solver_before = s.token.balance(&s.solver);

    claim_default(&s, &hash);

    assert_eq!(s.escrow.status_of(&hash), Status::Claimed);
    let required = s.escrow.required_bond(&100_0000000i128);
    assert_eq!(s.token.balance(&s.solver), solver_before - required);

    let entry = s.escrow.get_escrow(&hash);
    assert_eq!(entry.solver, Some(s.solver.clone()));
}

#[test]
fn claim_rejects_double_claim() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    let dest_tx_ref = Bytes::from_array(&s.env, &[1u8; 64]);
    let result = s
        .escrow
        .try_claim(&hash, &s.challenger, &dest_tx_ref, &900_000_000i128);
    assert_eq!(result, Err(Ok(Error::NotOpen)));
}

// --- finalize (unchallenged happy path) -----------------------------------

#[test]
fn finalize_pays_solver_after_window() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    s.env
        .ledger()
        .set_timestamp(s.env.ledger().timestamp() + CHALLENGE_WINDOW + 1);

    let solver_before = s.token.balance(&s.solver);
    s.escrow.finalize(&hash);

    let required = s.escrow.required_bond(&100_0000000i128);
    assert_eq!(
        s.token.balance(&s.solver),
        solver_before + 100_0000000i128 + required
    );
    assert_eq!(s.escrow.status_of(&hash), Status::Finalized);
}

#[test]
fn finalize_rejects_while_window_open() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    let result = s.escrow.try_finalize(&hash);
    assert_eq!(result, Err(Ok(Error::ChallengeWindowOpen)));
}

// --- refund (no fill) ------------------------------------------------------

#[test]
fn refund_returns_funds_after_expiry() {
    let s = setup();
    let (hash, intent) = open_default(&s);

    s.env.ledger().set_timestamp(intent.expiry + 1);
    s.escrow.refund(&hash);

    assert_eq!(s.token.balance(&s.user), 1_000_0000000i128);
    assert_eq!(s.escrow.status_of(&hash), Status::Refunded);
}

#[test]
fn refund_rejects_before_expiry() {
    let s = setup();
    let (hash, _intent) = open_default(&s);

    let result = s.escrow.try_refund(&hash);
    assert_eq!(result, Err(Ok(Error::IntentNotExpired)));
}

// --- dispute: challenge + resolve(claim_valid = true) ----------------------

#[test]
fn dispute_resolve_valid_pays_solver_both_bonds() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    s.escrow.challenge(&hash, &s.challenger);
    let solver_before = s.token.balance(&s.solver);

    s.escrow.resolve(&hash, &true);

    let required = s.escrow.required_bond(&100_0000000i128);
    assert_eq!(
        s.token.balance(&s.solver),
        solver_before + 100_0000000i128 + required + required
    );
    assert_eq!(s.escrow.status_of(&hash), Status::Finalized);
}

// --- dispute: challenge + resolve(claim_valid = false) ----------------------

#[test]
fn dispute_resolve_invalid_refunds_user_slashes_liar() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    s.escrow.challenge(&hash, &s.challenger);
    let challenger_before = s.token.balance(&s.challenger);

    s.escrow.resolve(&hash, &false);

    assert_eq!(s.token.balance(&s.user), 1_000_0000000i128);
    let required = s.escrow.required_bond(&100_0000000i128);
    assert_eq!(
        s.token.balance(&s.challenger),
        challenger_before + required + required
    );
    assert_eq!(s.escrow.status_of(&hash), Status::Refunded);
}

#[test]
fn challenge_rejects_after_window_closes() {
    let s = setup();
    let (hash, _intent) = open_default(&s);
    claim_default(&s, &hash);

    s.env
        .ledger()
        .set_timestamp(s.env.ledger().timestamp() + CHALLENGE_WINDOW + 1);

    let result = s.escrow.try_challenge(&hash, &s.challenger);
    assert_eq!(result, Err(Ok(Error::ChallengeWindowClosed)));
}

#[test]
fn required_bond_never_below_minimum() {
    let s = setup();
    // 10 USDC source -> 10% would be 1 USDC, floored up to the 25 USDC minimum.
    let bond = s.escrow.required_bond(&10_0000000i128);
    assert_eq!(bond, 25_0000000i128);
}
