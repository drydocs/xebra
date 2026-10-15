// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Circle's TokenMessengerV2, the two functions used. Read from the live implementation on Arc
/// mainnet and testnet: `depositForBurnWithHook` is selector 0x779b432d (`pnpm check:evm`), and
/// `localMessageTransmitter()` answers on both.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;

    function localMessageTransmitter() external view returns (address);
}

interface IMessageTransmitterV2 {
    function localDomain() external view returns (uint32);
}

/// @title XebraCctpWrapper (EVM)
/// @notice Takes Xebra's fee on a USDC transfer out of an EVM chain over Circle's CCTP V2, and has
/// Circle's Forwarding Service deliver it. The Solidity counterpart of
/// `contracts/stellar-cctp-wrapper-v2`, built for Arc first and written so the same bytecode can
/// be deployed on any EVM chain Circle forwards from.
///
/// # What it keeps from the Soroban wrapper
///
/// The fee model (`computeSplit`), the compile-time ceilings no admin can exceed, the per-domain
/// allowlist with its delivery-fee caps, the fixed forward hook a caller can never supply, the
/// user's own signed ceiling on the fee (`maxWrapperFee`) and deadline, and the governance: every
/// change that loosens anything waits 48 hours, every change that tightens is instant, and the
/// pauser can stop transfers and veto pending changes but not restart or change anything.
///
/// # What is different on an EVM chain, and why
///
///   - **The principal passes through this contract.** Circle's EVM messenger burns from
///     `msg.sender`, so the burn has to be made by this contract with USDC it holds. The full
///     amount is pulled, exactly `netBurned` is approved to the messenger and burned, and the
///     transaction reverts unless the allowance is back to zero and the contract still holds at
///     least what it owes the fee recipient. Nothing but accrued fees is ever left here between
///     transactions — but inside one, the principal is here, which the Soroban wrapper never
///     allowed. That is the boundary this contract adds, and why its maximum transfer starts low.
///   - **Forwarded only.** There is no relay any more, so a domain on the list is a domain Circle
///     forwards to; the Soroban `forward` switch and its relay path have no counterpart. Removing a
///     domain is the kill switch.
///   - **Fast transfers.** Circle charges a Fast transfer a speed fee on top of delivery, so the
///     cap on `maxFee` for finality 1000 adds `maxFastFeeBps` of the burned amount.
///   - **Six decimals.** EVM USDC and CCTP's canonical amount agree, so there is no remainder.
contract XebraCctpWrapper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    struct Params {
        /// Xebra's percentage fee, in basis points of the amount.
        uint16 feeBps;
        /// The least the fee can be, in USDC units (6 decimals).
        uint256 minFee;
        uint256 minTransfer;
        uint256 maxTransfer;
        /// How far a Fast transfer's `maxFee` may exceed the domain's delivery cap: Circle's speed
        /// fee, as basis points of the amount burned.
        uint16 maxFastFeeBps;
    }

    /// One destination. On the list means Circle forwards there. `evmStyle` selects the shape of
    /// the recipient: an EVM address is 20 bytes left-padded into 32, a Solana account fills all 32.
    struct DomainCfg {
        uint32 domain;
        bool evmStyle;
        /// The most a transfer's `maxFee` may be for delivery, which Circle charges in full.
        uint256 maxForwardFee;
        /// Circle's forwarder can open the recipient's Solana USDC account as part of the delivery
        /// (the 65-byte hook). Only for a non-EVM destination.
        bool accountCreation;
        /// The cap when it does: opening the account roughly doubles the fee. Zero otherwise.
        uint256 maxForwardFeeNewAccount;
    }

    /// Everything the sender commits to. The sender is `msg.sender`; there is no one else.
    struct BridgeRequest {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        /// Circle's fee, charged in full at the destination: delivery, plus the speed fee for Fast.
        uint256 maxFee;
        /// 1000 for Fast, 2000 for Standard.
        uint32 minFinalityThreshold;
        /// The Solana wallet Circle should open `mintRecipient` for, when it does not exist yet.
        /// Zero otherwise, and never `mintRecipient` itself: the wallet in place of its token
        /// account is the mistake that stranded the first mainnet burn.
        bytes32 recipientOwner;
        /// The sender's own ceiling on the total fee, so a change committed in the same block
        /// cannot charge more than they agreed to.
        uint256 maxWrapperFee;
        uint64 deadline;
    }

    struct Quote {
        uint256 amount;
        /// Everything the sender pays besides what the recipient gets: `max(percentage-or-floor,
        /// maxFee)`. The recipient receives `amount - fee`.
        uint256 fee;
        uint256 netBurned;
        /// Circle's fee, taken from the burn at the destination.
        uint256 forwardFee;
        /// What this contract keeps: `fee - forwardFee`. Never negative.
        uint256 wrapperTake;
        bool accountCreated;
    }

    struct PendingParams {
        Params params;
        uint64 eta;
    }

    struct PendingAddress {
        address addr;
        uint64 eta;
    }

    struct PendingDomain {
        DomainCfg cfg;
        uint64 eta;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint256 private constant BPS = 10_000;

    /// Ceilings no admin, compromised or otherwise, can exceed. Compile-time, and there is no
    /// upgrade path. The same figures as the Soroban wrapper, in 6-decimal units.
    uint16 public constant MAX_FEE_BPS_CEILING = 100; // 1%
    uint256 public constant MAX_MIN_FEE_CEILING = 5_000_000; // 5 USDC
    uint256 public constant MIN_TRANSFER_FLOOR = 1_000_000; // 1 USDC
    /// Circle's per-message burn limit for USDC, 10M. `params.maxTransfer` is the lever below it.
    uint256 public constant MAX_TRANSFER_CEILING = 10_000_000_000_000;
    uint256 public constant MAX_FORWARD_FEE_CEILING = 2_000_000; // 2 USDC
    /// Circle's Fast fee is a fraction of a basis point to about a basis point on the chains it is
    /// offered from; this leaves room and no more.
    uint16 public constant MAX_FAST_FEE_BPS_CEILING = 10; // 0.1%
    /// Circle's fee may never be more than a tenth of what is burned.
    uint256 public constant MAX_FEE_FRACTION_DENOM = 10;
    uint64 public constant MAX_DEADLINE_HORIZON = 3600;
    uint64 public constant TIMELOCK = 48 hours;

    uint32 public constant FINALITY_FAST = 1000;
    uint32 public constant FINALITY_STANDARD = 2000;

    /// Circle's Forwarding Service hook, version 0: `"cctp-forward"` right-padded to 32 bytes. The
    /// same bytes as the Soroban wrapper's `FORWARD_HOOK`, which mainnet has accepted on every
    /// forwarded transfer. Built here; a caller never supplies hook data.
    bytes32 public constant FORWARD_HOOK = 0x636374702d666f72776172640000000000000000000000000000000000000000;

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    /// Fixed for the life of the contract. A Circle migration means a redeploy, which strands
    /// nobody because nothing but fees is held between transactions.
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;
    /// This chain's CCTP domain, read from Circle's transmitter at deployment. A burn to it would
    /// be destroyed, not delivered, so it can never be on the list.
    uint32 public immutable localDomain;

    address public admin;
    address public pauser;
    address public feeRecipient;
    bool public paused;
    /// What the fee recipient is owed. The only USDC this contract may hold between transactions.
    uint256 public accruedFees;
    uint64 public seq;

    Params private _params;
    mapping(uint32 => DomainCfg) private _domains;
    /// 1-based position in `_domainIds`; zero means not on the list.
    mapping(uint32 => uint256) private _domainPosition;
    uint32[] private _domainIds;

    PendingParams private _pendingParams;
    PendingAddress private _pendingAdmin;
    PendingAddress private _pendingPauser;
    PendingAddress private _pendingFeeRecipient;
    PendingDomain private _pendingDomain;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event BridgeInitiated(
        bytes32 indexed transferId,
        uint64 indexed seq,
        address indexed user,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 fee,
        uint256 netBurned,
        uint256 forwardFee,
        uint256 wrapperTake,
        uint32 minFinalityThreshold,
        bytes32 recipientOwner
    );
    event FeesWithdrawn(address indexed to, uint256 amount, uint256 accruedAfter);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event ParamsProposed(Params params, uint64 eta);
    event ParamsCommitted(Params params);
    event ParamsTightened(Params params);
    event PendingCancelled(address indexed by);
    event AdminProposed(address indexed newAdmin, uint64 eta);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event PauserProposed(address indexed newPauser, uint64 eta);
    event PauserChanged(address indexed oldPauser, address indexed newPauser);
    event FeeRecipientProposed(address indexed newRecipient, uint64 eta);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event DomainProposed(DomainCfg cfg, uint64 eta);
    event DomainAdded(DomainCfg cfg);
    event DomainTightened(DomainCfg cfg, address indexed by);
    event DomainRemoved(uint32 indexed domain, address indexed by);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error NotAuthorized();
    error ZeroAddress();
    error IsPaused();
    error NotPaused();
    error RequestExpired();
    error DeadlineTooFar();
    error SelfDomain();
    error DomainNotAllowed();
    error DomainAlreadyAllowed();
    error MintRecipientZero();
    error MintRecipientShape();
    error BadFinalityThreshold();
    error AmountBelowMin();
    error AmountAboveMax();
    error ForwardFeeZero();
    error MaxFeeExceedsNet();
    error ForwardFeeAboveCap();
    error ForwardFeeTooHigh();
    error WrapperFeeAboveUserCap();
    error RecipientOwnerUnexpected();
    error MintRecipientIsOwner();
    error FeeBpsTooHigh();
    error MinFeeTooHigh();
    error MinTransferTooLow();
    error MaxTransferTooHigh();
    error BadTransferRange();
    error FastFeeBpsTooHigh();
    error BadForwardConfig();
    error NothingPending();
    error TimelockNotElapsed();
    error NotTightening();
    error AmountNotPositive();
    error InsufficientAccruedFees();
    error AmountNotReceived();
    error AllowanceLeft();
    error InvariantViolated();

    // ---------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------

    constructor(
        IERC20 usdc_,
        ITokenMessengerV2 tokenMessenger_,
        address admin_,
        address pauser_,
        address feeRecipient_,
        Params memory params_,
        DomainCfg[] memory domains_
    ) {
        if (
            address(usdc_) == address(0) || address(tokenMessenger_) == address(0) || admin_ == address(0)
                || pauser_ == address(0) || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        tokenMessenger = tokenMessenger_;
        localDomain = IMessageTransmitterV2(tokenMessenger_.localMessageTransmitter()).localDomain();
        admin = admin_;
        pauser = pauser_;
        feeRecipient = feeRecipient_;
        _validateParams(params_);
        _params = params_;
        for (uint256 i = 0; i < domains_.length; i++) {
            DomainCfg memory cfg = domains_[i];
            _validateDomainCfg(cfg);
            if (_domainPosition[cfg.domain] != 0) revert DomainAlreadyAllowed();
            _setDomain(cfg);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The transfer
    // ---------------------------------------------------------------------------------------------

    /// Takes `req.amount` from the sender, keeps Xebra's part, and burns the rest to the
    /// destination with Circle's forward hook, so Circle mints `amount - fee` to the recipient.
    /// The sender approves this contract for `req.amount` first.
    function bridge(BridgeRequest calldata req) external nonReentrant returns (Quote memory q) {
        if (paused) revert IsPaused();
        if (req.deadline <= block.timestamp) revert RequestExpired();
        if (req.deadline > block.timestamp + MAX_DEADLINE_HORIZON) revert DeadlineTooFar();

        // A burn to a domain Circle does not forward to, or to this chain, is destroyed rather than
        // stuck, so this is an allowlist.
        if (_domainPosition[req.destinationDomain] == 0) revert DomainNotAllowed();
        DomainCfg memory cfg = _domains[req.destinationDomain];
        _checkMintRecipient(req.mintRecipient, cfg.evmStyle);
        if (req.minFinalityThreshold != FINALITY_FAST && req.minFinalityThreshold != FINALITY_STANDARD) {
            revert BadFinalityThreshold();
        }

        Params memory p = _params;
        if (req.amount < p.minTransfer) revert AmountBelowMin();
        if (req.amount > p.maxTransfer) revert AmountAboveMax();

        // The owner means one thing: open this account. Only where that is offered, and never the
        // wallet standing in for its own token account.
        bool createsAccount = req.recipientOwner != bytes32(0);
        if (createsAccount) {
            if (!cfg.accountCreation) revert RecipientOwnerUnexpected();
            if (req.recipientOwner == req.mintRecipient) revert MintRecipientIsOwner();
        }

        q = computeSplit(req.amount, p.feeBps, p.minFee, req.maxFee);
        q.accountCreated = createsAccount;
        checkForwardFee(q, cfg, req.minFinalityThreshold, p.maxFastFeeBps);
        if (q.fee > req.maxWrapperFee) revert WrapperFeeAboveUserCap();

        // Effects before interactions.
        uint64 transferSeq = ++seq;
        uint256 accruedAfter = accruedFees + q.wrapperTake;
        accruedFees = accruedAfter;

        // Interactions. The whole amount comes in, because Circle burns from this contract, and it
        // must arrive whole: a token that delivered less would leave the burn short of the books.
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), req.amount);
        if (usdc.balanceOf(address(this)) - before != req.amount) revert AmountNotReceived();

        usdc.forceApprove(address(tokenMessenger), q.netBurned);
        tokenMessenger.depositForBurnWithHook(
            q.netBurned,
            req.destinationDomain,
            req.mintRecipient,
            address(usdc),
            // Zero, always: anyone may submit the mint, which keeps a failed forward recoverable at
            // /claim. Circle's forwarder requires it too.
            bytes32(0),
            q.forwardFee,
            req.minFinalityThreshold,
            createsAccount ? forwardHookWithAccount(req.recipientOwner) : abi.encodePacked(FORWARD_HOOK)
        );

        // Circle took exactly what was approved, and what remains covers what is owed. Either
        // failing means something burned more or less than the books say: fail closed.
        if (usdc.allowance(address(this), address(tokenMessenger)) != 0) revert AllowanceLeft();
        if (usdc.balanceOf(address(this)) < accruedAfter) revert InvariantViolated();

        emit BridgeInitiated(
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    transferSeq,
                    msg.sender,
                    q.netBurned,
                    req.destinationDomain,
                    req.mintRecipient
                )
            ),
            transferSeq,
            msg.sender,
            req.destinationDomain,
            req.mintRecipient,
            q.amount,
            q.fee,
            q.netBurned,
            q.forwardFee,
            q.wrapperTake,
            req.minFinalityThreshold,
            req.recipientOwner
        );
    }

    /// The fee split, pure so it can be tested and quoted without state. The same as the Soroban
    /// wrapper's forward path, without the 7-to-6 decimal rounding:
    ///
    ///     base         = max(amount * feeBps, minFee)
    ///     fee          = max(base, maxFee)       Circle's fee is paid out of ours, not on top
    ///     wrapperTake  = fee - maxFee
    ///     netBurned    = amount - wrapperTake
    ///     recipient    = netBurned - maxFee      = amount - fee
    ///
    /// When Circle's fee is at least `base`, the sender pays Circle's fee and Xebra keeps nothing on
    /// that transfer. The caps on `maxFee` are `checkForwardFee`'s, which needs the domain.
    function computeSplit(uint256 amount, uint16 feeBps, uint256 minFee, uint256 maxFee)
        public
        pure
        returns (Quote memory q)
    {
        if (amount == 0) revert AmountNotPositive();
        if (feeBps > MAX_FEE_BPS_CEILING) revert FeeBpsTooHigh();
        if (minFee > MAX_MIN_FEE_CEILING) revert MinFeeTooHigh();
        if (maxFee == 0) revert ForwardFeeZero();

        uint256 pct = amount * feeBps / BPS;
        uint256 base = pct > minFee ? pct : minFee;
        uint256 fee = base > maxFee ? base : maxFee;
        if (fee >= amount) revert MaxFeeExceedsNet();
        uint256 wrapperTake = fee - maxFee;
        uint256 netBurned = amount - wrapperTake;
        // The recipient must receive something: Circle takes `maxFee` out of `netBurned`.
        if (netBurned <= maxFee) revert MaxFeeExceedsNet();
        if (wrapperTake + netBurned != amount || netBurned - maxFee != amount - fee) revert InvariantViolated();

        q = Quote({
            amount: amount,
            fee: fee,
            netBurned: netBurned,
            forwardFee: maxFee,
            wrapperTake: wrapperTake,
            accountCreated: false
        });
    }

    /// The bounds on `maxFee`, which Circle charges in full: the destination's cap (its own for
    /// opening an account), plus the speed fee allowance for Fast, and never above a tenth of what
    /// is burned.
    function checkForwardFee(Quote memory q, DomainCfg memory cfg, uint32 minFinalityThreshold, uint16 maxFastFeeBps)
        public
        pure
    {
        uint256 cap = q.accountCreated ? cfg.maxForwardFeeNewAccount : cfg.maxForwardFee;
        if (minFinalityThreshold == FINALITY_FAST) {
            cap += _ceilDiv(q.netBurned * maxFastFeeBps, BPS);
        }
        if (q.forwardFee > cap) revert ForwardFeeAboveCap();
        if (q.forwardFee > q.netBurned / MAX_FEE_FRACTION_DENOM) revert ForwardFeeTooHigh();
    }

    /// What a transfer would cost, with the same checks as `bridge` short of the sender's own.
    function quote(uint256 amount, uint32 destinationDomain, uint256 maxFee, uint32 minFinalityThreshold, bool createsAccount)
        external
        view
        returns (Quote memory q)
    {
        Params memory p = _params;
        if (amount < p.minTransfer) revert AmountBelowMin();
        if (amount > p.maxTransfer) revert AmountAboveMax();
        if (_domainPosition[destinationDomain] == 0) revert DomainNotAllowed();
        if (minFinalityThreshold != FINALITY_FAST && minFinalityThreshold != FINALITY_STANDARD) {
            revert BadFinalityThreshold();
        }
        DomainCfg memory cfg = _domains[destinationDomain];
        if (createsAccount && !cfg.accountCreation) revert RecipientOwnerUnexpected();
        q = computeSplit(amount, p.feeBps, p.minFee, maxFee);
        q.accountCreated = createsAccount;
        checkForwardFee(q, cfg, minFinalityThreshold, p.maxFastFeeBps);
    }

    /// Circle's hook that also opens the recipient's Solana USDC account, 65 bytes: the plain hook's
    /// first 28 bytes (magic and version 0), payload length 33, the creation flag 1, then the
    /// owner. Byte for byte what the Soroban wrapper builds and mainnet accepted (burn 7dcf762a…).
    function forwardHookWithAccount(bytes32 owner) public pure returns (bytes memory) {
        // Truncating on purpose: the first 28 bytes are the magic and version this hook shares.
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(bytes28(FORWARD_HOOK), uint32(33), uint8(1), owner);
    }

    // ---------------------------------------------------------------------------------------------
    // Fees and pausing
    // ---------------------------------------------------------------------------------------------

    /// Pays accrued fees to the stored fee recipient. Only the counter can be moved, and only to
    /// that address, so this can never reach a transfer in flight (there are none between
    /// transactions anyway).
    function withdrawFees(uint256 amount) external {
        _onlyAdmin();
        if (amount == 0) revert AmountNotPositive();
        if (amount > accruedFees) revert InsufficientAccruedFees();
        uint256 accruedAfter = accruedFees - amount;
        accruedFees = accruedAfter;
        usdc.safeTransfer(feeRecipient, amount);
        emit FeesWithdrawn(feeRecipient, amount, accruedAfter);
    }

    function pause() external {
        _onlyAdminOrPauser();
        paused = true;
        emit Paused(msg.sender);
    }

    /// Admin only: a pauser can stop the world but not restart it.
    function unpause() external {
        _onlyAdmin();
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Governance: loosening waits 48 hours, tightening is instant
    // ---------------------------------------------------------------------------------------------

    function proposeParams(Params calldata params_) external returns (uint64 eta) {
        _onlyAdmin();
        _validateParams(params_);
        eta = uint64(block.timestamp) + TIMELOCK;
        _pendingParams = PendingParams(params_, eta);
        emit ParamsProposed(params_, eta);
    }

    function commitParams() external {
        _onlyAdmin();
        PendingParams memory pending = _pendingParams;
        _requireElapsed(pending.eta);
        _params = pending.params;
        delete _pendingParams;
        emit ParamsCommitted(pending.params);
    }

    /// Instant, and only ever cheaper or narrower: no fee raised, no limit widened. Lower fees count
    /// as tightening because they cost the sender less, which is what the timelock protects.
    function tightenParams(Params calldata params_) external {
        _onlyAdmin();
        _validateParams(params_);
        Params memory cur = _params;
        bool tighter = params_.feeBps <= cur.feeBps && params_.minFee <= cur.minFee
            && params_.maxTransfer <= cur.maxTransfer && params_.maxFastFeeBps <= cur.maxFastFeeBps
            && params_.minTransfer >= cur.minTransfer;
        if (!tighter) revert NotTightening();
        _params = params_;
        emit ParamsTightened(params_);
    }

    /// The pauser's veto over every pending change, in one call. The defence against a stolen admin
    /// key during the 48 hours.
    function cancelPending() external {
        _onlyAdminOrPauser();
        delete _pendingParams;
        delete _pendingAdmin;
        delete _pendingPauser;
        delete _pendingFeeRecipient;
        delete _pendingDomain;
        emit PendingCancelled(msg.sender);
    }

    function proposeAdmin(address newAdmin) external returns (uint64 eta) {
        _onlyAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        eta = uint64(block.timestamp) + TIMELOCK;
        _pendingAdmin = PendingAddress(newAdmin, eta);
        emit AdminProposed(newAdmin, eta);
    }

    /// Accepted by the new admin, so a typo cannot hand the contract to an address nobody holds.
    function acceptAdmin() external {
        PendingAddress memory pending = _pendingAdmin;
        if (pending.eta == 0) revert NothingPending();
        if (msg.sender != pending.addr) revert NotAuthorized();
        _requireElapsed(pending.eta);
        emit AdminChanged(admin, pending.addr);
        admin = pending.addr;
        delete _pendingAdmin;
    }

    /// Timelocked on purpose. The pauser's veto is the only defence against a stolen admin key
    /// during the 48 hours; were this instant, that key would replace the pauser first. The cost: a
    /// lost pauser key takes 48 hours to replace.
    function proposePauser(address newPauser) external returns (uint64 eta) {
        _onlyAdmin();
        if (newPauser == address(0)) revert ZeroAddress();
        eta = uint64(block.timestamp) + TIMELOCK;
        _pendingPauser = PendingAddress(newPauser, eta);
        emit PauserProposed(newPauser, eta);
    }

    function commitPauser() external {
        _onlyAdmin();
        PendingAddress memory pending = _pendingPauser;
        _requireElapsed(pending.eta);
        emit PauserChanged(pauser, pending.addr);
        pauser = pending.addr;
        delete _pendingPauser;
    }

    function proposeFeeRecipient(address newRecipient) external returns (uint64 eta) {
        _onlyAdmin();
        if (newRecipient == address(0)) revert ZeroAddress();
        eta = uint64(block.timestamp) + TIMELOCK;
        _pendingFeeRecipient = PendingAddress(newRecipient, eta);
        emit FeeRecipientProposed(newRecipient, eta);
    }

    function commitFeeRecipient() external {
        _onlyAdmin();
        PendingAddress memory pending = _pendingFeeRecipient;
        _requireElapsed(pending.eta);
        emit FeeRecipientChanged(feeRecipient, pending.addr);
        feeRecipient = pending.addr;
        delete _pendingFeeRecipient;
    }

    /// Adds a destination, or replaces one (raising a cap or allowing account creation has to come
    /// through here), never as a no-op. One pending at a time; a new proposal replaces the last.
    function proposeDomain(DomainCfg calldata cfg) external returns (uint64 eta) {
        _onlyAdmin();
        _validateDomainCfg(cfg);
        if (_domainPosition[cfg.domain] != 0 && _sameDomainCfg(_domains[cfg.domain], cfg)) {
            revert DomainAlreadyAllowed();
        }
        eta = uint64(block.timestamp) + TIMELOCK;
        _pendingDomain = PendingDomain(cfg, eta);
        emit DomainProposed(cfg, eta);
    }

    function commitDomain() external {
        _onlyAdmin();
        PendingDomain memory pending = _pendingDomain;
        _requireElapsed(pending.eta);
        _setDomain(pending.cfg);
        delete _pendingDomain;
        emit DomainAdded(pending.cfg);
    }

    /// Instant, admin or pauser: lower a destination's caps or stop opening accounts there. The kill
    /// switch if Circle's service misbehaves; removing the domain is the stronger one.
    function tightenDomain(
        uint32 domain,
        uint256 maxForwardFee,
        bool accountCreation,
        uint256 maxForwardFeeNewAccount
    ) external {
        _onlyAdminOrPauser();
        if (_domainPosition[domain] == 0) revert DomainNotAllowed();
        DomainCfg memory old = _domains[domain];
        uint256 newAccountCap = accountCreation ? maxForwardFeeNewAccount : 0;
        if (
            maxForwardFee > old.maxForwardFee || (accountCreation && !old.accountCreation)
                || newAccountCap > old.maxForwardFeeNewAccount
        ) revert NotTightening();
        DomainCfg memory cfg = DomainCfg({
            domain: domain,
            evmStyle: old.evmStyle,
            maxForwardFee: maxForwardFee,
            accountCreation: accountCreation,
            maxForwardFeeNewAccount: newAccountCap
        });
        if (_sameDomainCfg(old, cfg)) revert NotTightening();
        _validateDomainCfg(cfg);
        _domains[domain] = cfg;
        emit DomainTightened(cfg, msg.sender);
    }

    function removeDomain(uint32 domain) external {
        _onlyAdminOrPauser();
        uint256 position = _domainPosition[domain];
        if (position == 0) revert DomainNotAllowed();
        uint32 last = _domainIds[_domainIds.length - 1];
        _domainIds[position - 1] = last;
        _domainPosition[last] = position;
        _domainIds.pop();
        delete _domainPosition[domain];
        delete _domains[domain];
        emit DomainRemoved(domain, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getParams() external view returns (Params memory) {
        return _params;
    }

    function getDomains() external view returns (DomainCfg[] memory cfgs) {
        cfgs = new DomainCfg[](_domainIds.length);
        for (uint256 i = 0; i < _domainIds.length; i++) {
            cfgs[i] = _domains[_domainIds[i]];
        }
    }

    function getDomain(uint32 domain) external view returns (bool allowed, DomainCfg memory cfg) {
        return (_domainPosition[domain] != 0, _domains[domain]);
    }

    function pendingParams() external view returns (PendingParams memory) {
        return _pendingParams;
    }

    function pendingAdmin() external view returns (PendingAddress memory) {
        return _pendingAdmin;
    }

    function pendingPauser() external view returns (PendingAddress memory) {
        return _pendingPauser;
    }

    function pendingFeeRecipient() external view returns (PendingAddress memory) {
        return _pendingFeeRecipient;
    }

    function pendingDomain() external view returns (PendingDomain memory) {
        return _pendingDomain;
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _onlyAdmin() private view {
        if (msg.sender != admin) revert NotAuthorized();
    }

    function _onlyAdminOrPauser() private view {
        if (msg.sender != admin && msg.sender != pauser) revert NotAuthorized();
    }

    function _requireElapsed(uint64 eta) private view {
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotElapsed();
    }

    function _setDomain(DomainCfg memory cfg) private {
        if (_domainPosition[cfg.domain] == 0) {
            _domainIds.push(cfg.domain);
            _domainPosition[cfg.domain] = _domainIds.length;
        }
        _domains[cfg.domain] = cfg;
    }

    function _sameDomainCfg(DomainCfg memory a, DomainCfg memory b) private pure returns (bool) {
        return a.domain == b.domain && a.evmStyle == b.evmStyle && a.maxForwardFee == b.maxForwardFee
            && a.accountCreation == b.accountCreation && a.maxForwardFeeNewAccount == b.maxForwardFeeNewAccount;
    }

    /// A destination is never this chain, always has a cap (every forwarded `maxFee` is positive),
    /// and opens accounts only where that means something: a non-EVM chain, with its own cap.
    function _validateDomainCfg(DomainCfg memory cfg) private view {
        if (cfg.domain == localDomain) revert SelfDomain();
        if (cfg.maxForwardFee == 0 || cfg.maxForwardFee > MAX_FORWARD_FEE_CEILING) revert BadForwardConfig();
        if (cfg.maxForwardFeeNewAccount > MAX_FORWARD_FEE_CEILING) revert BadForwardConfig();
        if (cfg.accountCreation) {
            if (cfg.evmStyle || cfg.maxForwardFeeNewAccount == 0) revert BadForwardConfig();
        } else if (cfg.maxForwardFeeNewAccount != 0) {
            revert BadForwardConfig();
        }
    }

    function _validateParams(Params memory p) private pure {
        if (p.feeBps > MAX_FEE_BPS_CEILING) revert FeeBpsTooHigh();
        if (p.minFee > MAX_MIN_FEE_CEILING) revert MinFeeTooHigh();
        if (p.minTransfer < MIN_TRANSFER_FLOOR) revert MinTransferTooLow();
        if (p.maxTransfer > MAX_TRANSFER_CEILING) revert MaxTransferTooHigh();
        if (p.minTransfer >= p.maxTransfer) revert BadTransferRange();
        if (p.maxFastFeeBps > MAX_FAST_FEE_BPS_CEILING) revert FastFeeBpsTooHigh();
    }

    /// Non-zero, and the right shape for the destination: an EVM address is left-padded, a Solana
    /// account is not. The wrong shape mints to an address nobody holds.
    function _checkMintRecipient(bytes32 recipient, bool evmStyle) private pure {
        if (recipient == bytes32(0)) revert MintRecipientZero();
        bool leftPadded = uint256(recipient) >> 160 == 0;
        if (evmStyle != leftPadded) revert MintRecipientShape();
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
