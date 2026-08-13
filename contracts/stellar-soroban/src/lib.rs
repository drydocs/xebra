#![no_std]

//! XebraEscrow (Soroban) — Stellar-as-source escrow for the Stellar -> Solana corridor.
//!
//! Mirrors `contracts/arc-evm/src/XebraEscrow.sol`'s state machine and economics 1:1
//! (`Open -> Claimed -> Finalized`, `Open -> Refunded`, `Claimed -> Challenged ->
//! (Finalized | Refunded)`; 10%-of-source bond floored at a USDC-equivalent minimum;
//! symmetric challenger bond; single v1 admin arbiter) with the Soroban-native adaptations
//! documented inline where the two platforms genuinely differ. See docs/architecture.md
//! §1-3 for the full design rationale; this file implements it.
//!
//! Soroban-vs-Arc adaptations, and why:
//! - **Signing**: Arc uses EIP-712 wallet signatures verified by `ecrecover`. Soroban has no
//!   such primitive; instead `open` calls `intent.user.require_auth_for_args(...)`, which
//!   binds the caller's signature to these exact argument bytes via a detached Soroban
//!   authorization entry — the host enforces this, so there is no manual signature-recovery
//!   code in this contract at all (see docs/architecture.md §2).
//! - **Bonds**: Arc collects solver/challenger bonds via `payable` (native ETH-equivalent),
//!   which works there because Arc's native gas token is USDC-denominated 1:1. Stellar's
//!   native gas token is XLM, not USDC — there is no equivalent implicit-payable trick here.
//!   Bonds are instead posted as an explicit transfer of the *same* `source_token` (the USDC
//!   Stellar Asset Contract) used for the escrowed amount, authorized by the caller's
//!   `require_auth` (enforced by the token contract itself). A pleasant side effect: because
//!   bond and principal are the same token here (unlike Arc's ERC-20-plus-native split),
//!   `finalize`/`resolve` payouts collapse into a single transfer instead of two.
//! - **Decimals**: Stellar/Soroban token amounts are always 7-decimal fixed-point (a Stellar
//!   protocol convention), unlike Arc's 6-decimal USDC ERC-20. `MIN_BOND` below is sized in
//!   7-decimal units accordingly — it is not a typo relative to the Arc contract's 6-decimal
//!   `MIN_BOND`.
//! - **Storage TTL**: Soroban persistent storage has an explicit rent/TTL model Arc doesn't
//!   have. Every state transition bumps the escrow entry's TTL well past the longest possible
//!   remaining lifecycle so an entry can never be evicted mid-flight (see `bump_escrow_ttl`).
//! - **Destination proof reference**: Arc's `claim` takes a `bytes32 stellarTxHash` because
//!   the destination in that corridor (Stellar) has 32-byte transaction hashes. This
//!   contract's destination is Solana, whose transaction signatures are 64 bytes, but rather
//!   than hard-code that width this contract accepts a variable-length `Bytes` reference so
//!   the same contract shape works if it's ever redeployed against a differently-shaped
//!   destination chain — the escrow's job is to hold a bonded, falsifiable assertion, not to
//!   understand any particular chain's transaction format (see docs/architecture.md §4, §7).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Chain identifiers, matching `packages/intent-schema`'s `ChainId` enum
/// (docs/architecture.md §1). Only `Solana` is a live destination in v1.
pub const CHAIN_ARC_EVM: u32 = 1;
pub const CHAIN_STELLAR: u32 = 2;
pub const CHAIN_SOLANA: u32 = 3;

#[contracttype]
#[derive(Clone)]
pub struct Intent {
    /// Refund recipient on Stellar; also the address whose auth this call requires.
    pub user: Address,
    /// USDC Stellar Asset Contract address.
    pub source_token: Address,
    /// 7 decimals (Stellar convention).
    pub source_amount: i128,
    /// `ChainId` of the destination chain (`CHAIN_SOLANA` in v1).
    pub dest_chain: u32,
    /// Canonical `AssetRef.assetId` on the destination chain (e.g. a raw SPL mint pubkey).
    pub dest_asset: BytesN<32>,
    /// Destination-chain-native decimals for `dest_asset`.
    pub min_dest_amount: i128,
    /// Canonical `ChainAddress.raw` on the destination chain (e.g. a raw Solana pubkey).
    pub dest_address: BytesN<32>,
    pub expiry: u64,
    pub nonce: u128,
}

#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Claimed,
    Challenged,
    Finalized,
    Refunded,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowEntry {
    pub user: Address,
    pub source_token: Address,
    pub source_amount: i128,
    pub dest_chain: u32,
    pub expiry: u64,
    pub status: Status,
    pub solver: Option<Address>,
    /// Solver's asserted destination-chain delivery tx reference (e.g. a Solana tx signature).
    pub dest_tx_ref: Option<Bytes>,
    pub delivered_amount: i128,
    pub solver_bond: i128,
    pub claimed_at: u64,
    pub challenger: Option<Address>,
    pub challenger_bond: i128,
}

#[contracttype]
pub enum DataKey {
    Usdc,
    Arbiter,
    ChallengeWindow,
    Escrow(BytesN<32>),
    LastNonce(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    ZeroAddress = 1,
    InvalidSourceToken = 2,
    IntentExpired = 3,
    IntentNotExpired = 4,
    NonceTooLow = 5,
    IntentAlreadyExists = 6,
    EscrowNotFound = 7,
    NotOpen = 8,
    NotClaimed = 9,
    NotChallenged = 10,
    ChallengeWindowClosed = 11,
    ChallengeWindowOpen = 12,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct IntentOpened {
    pub intent_hash: BytesN<32>,
    pub user: Address,
    pub source_token: Address,
    pub source_amount: i128,
    pub dest_chain: u32,
    pub dest_asset: BytesN<32>,
    pub min_dest_amount: i128,
    pub dest_address: BytesN<32>,
    pub expiry: u64,
    pub nonce: u128,
}

#[contractevent]
pub struct IntentClaimed {
    pub intent_hash: BytesN<32>,
    pub solver: Address,
    pub dest_tx_ref: Bytes,
    pub delivered_amount: i128,
    pub solver_bond: i128,
    pub challenge_deadline: u64,
}

#[contractevent]
pub struct IntentChallenged {
    pub intent_hash: BytesN<32>,
    pub challenger: Address,
    pub challenger_bond: i128,
}

#[contractevent]
pub struct IntentResolved {
    pub intent_hash: BytesN<32>,
    pub claim_valid: bool,
}

#[contractevent]
pub struct IntentFinalized {
    pub intent_hash: BytesN<32>,
    pub solver: Address,
    pub source_amount: i128,
}

#[contractevent]
pub struct IntentRefunded {
    pub intent_hash: BytesN<32>,
    pub to: Address,
    pub source_amount: i128,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOND_BPS: i128 = 1_000; // 10%
const BPS_DENOMINATOR: i128 = 10_000;
/// 25 USDC, 7 decimals (Stellar convention — see module doc comment on decimals).
const MIN_BOND: i128 = 25_000_0000;

/// ~5s average ledger close time on Stellar.
const LEDGERS_PER_DAY: u32 = 17_280;
/// Bump an escrow entry's TTL whenever it has less than this many ledgers left...
const ESCROW_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 3;
/// ...extending it out to this many ledgers from now. Comfortably covers the longest
/// realistic lifecycle (mainnet 24h challenge window plus operational latency to finalize).
const ESCROW_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 14;
const INSTANCE_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const INSTANCE_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 180;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct XebraEscrow;

#[contractimpl]
impl XebraEscrow {
    /// `usdc`: the Stellar Asset Contract intents must use as `source_token` (constrained here
    /// rather than trusting whatever address a signed intent names, same hardening rationale
    /// as the Arc contract's immutable `usdc`). `arbiter`: v1's single trusted role, ideally a
    /// KMS-backed signer (docs/architecture.md §8), not a raw key. `challenge_window_secs`:
    /// 1800 (30 min) testnet / 86400 (24h) mainnet default per spec.
    pub fn __constructor(env: Env, usdc: Address, arbiter: Address, challenge_window_secs: u64) {
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage()
            .instance()
            .set(&DataKey::ChallengeWindow, &challenge_window_secs);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// Binds `intent.user`'s authorization to these exact argument bytes (Stellar's EIP-712
    /// equivalent, see module doc comment), pulls `source_amount` of `source_token`, opens the
    /// escrow. Permissionless: anyone may submit on the user's behalf as long as the
    /// authorization entry is valid (e.g. a relay paying the user's Stellar network fee).
    pub fn open(env: Env, intent: Intent) -> Result<BytesN<32>, Error> {
        if intent.expiry <= env.ledger().timestamp() {
            return Err(Error::IntentExpired);
        }
        let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
        if intent.source_token != usdc {
            return Err(Error::InvalidSourceToken);
        }

        let last_nonce: u128 = env
            .storage()
            .persistent()
            .get(&DataKey::LastNonce(intent.user.clone()))
            .unwrap_or(0);
        if intent.nonce <= last_nonce {
            return Err(Error::NonceTooLow);
        }

        intent
            .user
            .require_auth_for_args((intent.clone(),).into_val(&env));

        let intent_hash = Self::hash_intent(env.clone(), intent.clone());
        let key = DataKey::Escrow(intent_hash.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::IntentAlreadyExists);
        }

        // Effects before the external token call (checks-effects-interactions): a reentrant
        // `open` for the same user/nonce fails NonceTooLow before `transfer` can run twice.
        env.storage()
            .persistent()
            .set(&DataKey::LastNonce(intent.user.clone()), &intent.nonce);
        let entry = EscrowEntry {
            user: intent.user.clone(),
            source_token: intent.source_token.clone(),
            source_amount: intent.source_amount,
            dest_chain: intent.dest_chain,
            expiry: intent.expiry,
            status: Status::Open,
            solver: None,
            dest_tx_ref: None,
            delivered_amount: 0,
            solver_bond: 0,
            claimed_at: 0,
            challenger: None,
            challenger_bond: 0,
        };
        env.storage().persistent().set(&key, &entry);
        Self::bump_escrow_ttl(&env, &key);
        Self::bump_nonce_ttl(&env, &intent.user);

        let token = token::Client::new(&env, &intent.source_token);
        token.transfer(
            &intent.user,
            &env.current_contract_address(),
            &intent.source_amount,
        );

        IntentOpened {
            intent_hash: intent_hash.clone(),
            user: intent.user,
            source_token: intent.source_token,
            source_amount: intent.source_amount,
            dest_chain: intent.dest_chain,
            dest_asset: intent.dest_asset,
            min_dest_amount: intent.min_dest_amount,
            dest_address: intent.dest_address,
            expiry: intent.expiry,
            nonce: intent.nonce,
        }
        .publish(&env);

        Ok(intent_hash)
    }

    /// Solver posts a bond (as a `source_token` transfer, see module doc comment) and asserts
    /// "I delivered on the destination chain in this tx", starting the challenge window.
    /// `dest_tx_ref` + `delivered_amount` are a falsifiable claim, verifiable by anyone against
    /// the destination chain's own RPC — this contract does not and cannot check them itself.
    pub fn claim(
        env: Env,
        intent_hash: BytesN<32>,
        solver: Address,
        dest_tx_ref: Bytes,
        delivered_amount: i128,
    ) -> Result<(), Error> {
        solver.require_auth();

        let key = DataKey::Escrow(intent_hash.clone());
        let mut e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;

        if e.status != Status::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().timestamp() > e.expiry {
            return Err(Error::IntentExpired);
        }

        let bond = Self::required_bond(e.source_amount);
        let token = token::Client::new(&env, &e.source_token);
        token.transfer(&solver, &env.current_contract_address(), &bond);

        e.status = Status::Claimed;
        e.solver = Some(solver.clone());
        e.dest_tx_ref = Some(dest_tx_ref.clone());
        e.delivered_amount = delivered_amount;
        e.solver_bond = bond;
        e.claimed_at = env.ledger().timestamp();
        let challenge_deadline = e.claimed_at + Self::challenge_window(&env);

        env.storage().persistent().set(&key, &e);
        Self::bump_escrow_ttl(&env, &key);

        IntentClaimed {
            intent_hash,
            solver,
            dest_tx_ref,
            delivered_amount,
            solver_bond: bond,
            challenge_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// Anyone may post a matching bond within the challenge window to freeze the claim for
    /// arbiter resolution. Symmetric stakes: challenger bond == solver bond.
    pub fn challenge(env: Env, intent_hash: BytesN<32>, challenger: Address) -> Result<(), Error> {
        challenger.require_auth();

        let key = DataKey::Escrow(intent_hash.clone());
        let mut e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;

        if e.status != Status::Claimed {
            return Err(Error::NotClaimed);
        }
        if env.ledger().timestamp() > e.claimed_at + Self::challenge_window(&env) {
            return Err(Error::ChallengeWindowClosed);
        }

        let token = token::Client::new(&env, &e.source_token);
        token.transfer(&challenger, &env.current_contract_address(), &e.solver_bond);

        e.status = Status::Challenged;
        e.challenger = Some(challenger.clone());
        e.challenger_bond = e.solver_bond;

        env.storage().persistent().set(&key, &e.clone());
        Self::bump_escrow_ttl(&env, &key);

        IntentChallenged {
            intent_hash,
            challenger,
            challenger_bond: e.challenger_bond,
        }
        .publish(&env);

        Ok(())
    }

    /// v1's single trusted role, invoked only when a challenge lands. Pays the escrow + loser's
    /// bond to the honest side in one transfer (bond and principal share a token on this
    /// contract — see module doc comment). Every claim is publicly verifiable against the
    /// destination chain, so a dishonest resolution here is provably dishonest, in public,
    /// permanently (see docs/architecture.md and the base spec's "Trust model").
    pub fn resolve(env: Env, intent_hash: BytesN<32>, claim_valid: bool) -> Result<(), Error> {
        let arbiter: Address = env.storage().instance().get(&DataKey::Arbiter).unwrap();
        arbiter.require_auth();

        let key = DataKey::Escrow(intent_hash.clone());
        let mut e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        if e.status != Status::Challenged {
            return Err(Error::NotChallenged);
        }

        let solver = e.solver.clone().unwrap();
        let challenger = e.challenger.clone().unwrap();
        let bond_payout = e.solver_bond + e.challenger_bond;
        let source_amount = e.source_amount;
        let token = token::Client::new(&env, &e.source_token);

        IntentResolved {
            intent_hash: intent_hash.clone(),
            claim_valid,
        }
        .publish(&env);

        if claim_valid {
            e.status = Status::Finalized;
            e.solver_bond = 0;
            e.challenger_bond = 0;
            env.storage().persistent().set(&key, &e);
            Self::bump_escrow_ttl(&env, &key);

            token.transfer(
                &env.current_contract_address(),
                &solver,
                &(source_amount + bond_payout),
            );

            IntentFinalized {
                intent_hash,
                solver,
                source_amount,
            }
            .publish(&env);
        } else {
            let user = e.user.clone();
            e.status = Status::Refunded;
            e.solver_bond = 0;
            e.challenger_bond = 0;
            env.storage().persistent().set(&key, &e);
            Self::bump_escrow_ttl(&env, &key);

            token.transfer(&env.current_contract_address(), &user, &source_amount);
            token.transfer(&env.current_contract_address(), &challenger, &bond_payout);

            IntentRefunded {
                intent_hash,
                to: user,
                source_amount,
            }
            .publish(&env);
        }

        Ok(())
    }

    /// After an unchallenged window elapses, anyone may finalize: escrowed principal + bond
    /// returned to the solver in a single transfer.
    pub fn finalize(env: Env, intent_hash: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Escrow(intent_hash.clone());
        let mut e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        if e.status != Status::Claimed {
            return Err(Error::NotClaimed);
        }
        if env.ledger().timestamp() <= e.claimed_at + Self::challenge_window(&env) {
            return Err(Error::ChallengeWindowOpen);
        }

        let solver = e.solver.clone().unwrap();
        let payout = e.source_amount + e.solver_bond;
        let source_amount = e.source_amount;

        e.status = Status::Finalized;
        e.solver_bond = 0;
        env.storage().persistent().set(&key, &e);
        Self::bump_escrow_ttl(&env, &key);

        let token = token::Client::new(&env, &e.source_token);
        token.transfer(&env.current_contract_address(), &solver, &payout);

        IntentFinalized {
            intent_hash,
            solver,
            source_amount,
        }
        .publish(&env);

        Ok(())
    }

    /// After expiry with no live claim, anyone may return the escrowed principal to the user —
    /// the user doesn't even need to come back themselves.
    pub fn refund(env: Env, intent_hash: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Escrow(intent_hash.clone());
        let mut e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        if e.status != Status::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().timestamp() <= e.expiry {
            return Err(Error::IntentNotExpired);
        }

        let user = e.user.clone();
        let source_amount = e.source_amount;
        e.status = Status::Refunded;
        env.storage().persistent().set(&key, &e);
        Self::bump_escrow_ttl(&env, &key);

        let token = token::Client::new(&env, &e.source_token);
        token.transfer(&env.current_contract_address(), &user, &source_amount);

        IntentRefunded {
            intent_hash,
            to: user,
            source_amount,
        }
        .publish(&env);

        Ok(())
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// The single 32-byte spine that identifies this escrow entry, travels as the falsifiable
    /// reference the solver's `claim` asserts delivery against, and is what a challenger or
    /// indexer looks up. `keccak256` over the intent's canonical Soroban-XDR encoding — chosen
    /// for parity with Arc's `keccak256`-based EIP-712 digest, even though the two chains use
    /// different underlying encodings (see module doc comment).
    pub fn hash_intent(env: Env, intent: Intent) -> BytesN<32> {
        let xdr: Bytes = intent.to_xdr(&env);
        env.crypto().keccak256(&xdr).to_bytes()
    }

    /// Bond required to `claim` or `challenge` an escrow of `source_amount`: 10%, floored at
    /// 25 USDC-equivalent (7 decimals).
    pub fn required_bond(source_amount: i128) -> i128 {
        let pct = (source_amount * BOND_BPS) / BPS_DENOMINATOR;
        if pct > MIN_BOND {
            pct
        } else {
            MIN_BOND
        }
    }

    pub fn status_of(env: Env, intent_hash: BytesN<32>) -> Result<Status, Error> {
        let e: EscrowEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(intent_hash))
            .ok_or(Error::EscrowNotFound)?;
        Ok(e.status)
    }

    pub fn get_escrow(env: Env, intent_hash: BytesN<32>) -> Result<EscrowEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(intent_hash))
            .ok_or(Error::EscrowNotFound)
    }

    // -----------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------

    fn challenge_window(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ChallengeWindow)
            .unwrap()
    }

    fn bump_escrow_ttl(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, ESCROW_TTL_THRESHOLD, ESCROW_TTL_EXTEND_TO);
    }

    fn bump_nonce_ttl(env: &Env, user: &Address) {
        env.storage().persistent().extend_ttl(
            &DataKey::LastNonce(user.clone()),
            ESCROW_TTL_THRESHOLD,
            ESCROW_TTL_EXTEND_TO,
        );
    }
}

#[cfg(test)]
mod test;
