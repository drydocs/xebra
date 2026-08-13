// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {XebraEscrow} from "../src/XebraEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract XebraEscrowTest is Test {
    // Mirrors OpenZeppelin EIP712's internal domain-separator construction so tests can sign
    // intents exactly the way a real wallet would, without touching contract internals.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,address sourceToken,uint256 sourceAmount,bytes32 destAsset,uint256 minDestAmount,bytes32 destAddress,uint64 expiry,uint256 nonce)"
    );

    uint256 internal constant CHALLENGE_WINDOW = 30 minutes;

    XebraEscrow internal escrow;
    MockUSDC internal usdc;

    uint256 internal userPk = 0xA11CE;
    uint256 internal solverPk = 0xB0B;
    uint256 internal challengerPk = 0xC0FFEE;
    address internal user;
    address internal solver;
    address internal challenger;
    address internal arbiter = makeAddr("arbiter");

    bytes32 internal domainSeparator;

    function setUp() public {
        user = vm.addr(userPk);
        solver = vm.addr(solverPk);
        challenger = vm.addr(challengerPk);

        usdc = new MockUSDC();
        escrow = new XebraEscrow(address(usdc), arbiter, CHALLENGE_WINDOW);

        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Xebra")), keccak256(bytes("1")), block.chainid, address(escrow)
            )
        );

        usdc.mint(user, 1_000e6);
        vm.prank(user);
        usdc.approve(address(escrow), type(uint256).max);

        vm.deal(solver, 100 ether);
        vm.deal(challenger, 100 ether);
    }

    // --- helpers -----------------------------------------------------------

    function _defaultIntent(uint256 nonce) internal returns (XebraEscrow.Intent memory) {
        return XebraEscrow.Intent({
            user: user,
            sourceToken: address(usdc),
            sourceAmount: 100e6,
            destAsset: bytes32(0), // native XLM
            minDestAmount: 900e7, // 900 XLM, 7 decimals
            destAddress: bytes32(uint256(uint160(makeAddr("stellarDest")))),
            expiry: uint64(block.timestamp + 1 hours),
            nonce: nonce
        });
    }

    function _sign(XebraEscrow.Intent memory intent, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                intent.sourceToken,
                intent.sourceAmount,
                intent.destAsset,
                intent.minDestAmount,
                intent.destAddress,
                intent.expiry,
                intent.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openDefault() internal returns (bytes32 intentHash, XebraEscrow.Intent memory intent) {
        intent = _defaultIntent(1);
        bytes memory sig = _sign(intent, userPk);
        intentHash = escrow.hashIntent(intent);
        escrow.open(intent, sig);
    }

    function _claimDefault(bytes32 intentHash) internal {
        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(solver);
        escrow.claim{value: bond}(intentHash, keccak256("stellar-tx"), 900e7);
    }

    // --- open ----------------------------------------------------------

    function test_open_pullsEscrowAndEmits() public {
        XebraEscrow.Intent memory intent = _defaultIntent(1);
        bytes memory sig = _sign(intent, userPk);
        bytes32 intentHash = escrow.hashIntent(intent);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit XebraEscrow.IntentOpened(
            intentHash,
            user,
            address(usdc),
            intent.sourceAmount,
            intent.destAsset,
            intent.minDestAmount,
            intent.destAddress,
            intent.expiry,
            intent.nonce
        );
        escrow.open(intent, sig);

        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Open));
        assertEq(usdc.balanceOf(address(escrow)), 100e6);
        assertEq(usdc.balanceOf(user), 900e6);
    }

    function test_open_revertsOnBadSignature() public {
        XebraEscrow.Intent memory intent = _defaultIntent(1);
        bytes memory sig = _sign(intent, solverPk); // wrong signer

        vm.expectRevert(XebraEscrow.BadSignature.selector);
        escrow.open(intent, sig);
    }

    function test_open_revertsOnNonceReuse() public {
        (, XebraEscrow.Intent memory intent) = _openDefault();

        XebraEscrow.Intent memory replay = intent;
        replay.destAddress = bytes32(uint256(uint160(makeAddr("otherDest"))));
        bytes memory sig = _sign(replay, userPk);

        vm.expectRevert(XebraEscrow.NonceTooLow.selector);
        escrow.open(replay, sig);
    }

    function test_open_revertsOnExpiredIntent() public {
        XebraEscrow.Intent memory intent = _defaultIntent(1);
        intent.expiry = uint64(block.timestamp);
        bytes memory sig = _sign(intent, userPk);

        vm.expectRevert(XebraEscrow.IntentExpired.selector);
        escrow.open(intent, sig);
    }

    function test_open_revertsOnWrongSourceToken() public {
        XebraEscrow.Intent memory intent = _defaultIntent(1);
        intent.sourceToken = address(0xdead);
        bytes memory sig = _sign(intent, userPk);

        vm.expectRevert(XebraEscrow.InvalidSourceToken.selector);
        escrow.open(intent, sig);
    }

    // --- claim -----------------------------------------------------------

    function test_claim_requiresExactBond() public {
        (bytes32 intentHash,) = _openDefault();
        uint256 required = escrow.requiredBond(100e6);
        assertEq(required, 25e6); // 10% of 100 USDC would be 10 USDC, floored up to the 25 min

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(XebraEscrow.IncorrectBond.selector, required, required - 1));
        escrow.claim{value: required - 1}(intentHash, keccak256("tx"), 900e7);
    }

    function test_claim_movesStateToClaimed() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Claimed));
        (,,,,, address claimedSolver,,,,,,) = escrow.escrows(intentHash);
        assertEq(claimedSolver, solver);
    }

    function test_claim_revertsIfAlreadyClaimed() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(challenger);
        vm.expectRevert(XebraEscrow.NotOpen.selector);
        escrow.claim{value: bond}(intentHash, keccak256("tx2"), 900e7);
    }

    // --- finalize (unchallenged happy path) -------------------------------

    function test_finalize_paysSolverAfterWindow() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 solverUsdcBefore = usdc.balanceOf(solver);
        uint256 solverEthBefore = solver.balance;

        escrow.finalize(intentHash);

        assertEq(usdc.balanceOf(solver), solverUsdcBefore + 100e6);
        assertEq(solver.balance, solverEthBefore + escrow.requiredBond(100e6));

        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Finalized));
    }

    function test_finalize_revertsWhileWindowOpen() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        vm.expectRevert(XebraEscrow.ChallengeWindowOpen.selector);
        escrow.finalize(intentHash);
    }

    // --- refund (no fill) --------------------------------------------------

    function test_refund_returnsFundsAfterExpiry() public {
        (bytes32 intentHash, XebraEscrow.Intent memory intent) = _openDefault();

        vm.warp(intent.expiry + 1);
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        escrow.refund(intentHash);

        assertEq(usdc.balanceOf(user), 1_000e6); // fully back
        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Refunded));
    }

    function test_refund_revertsBeforeExpiry() public {
        (bytes32 intentHash,) = _openDefault();
        vm.expectRevert(XebraEscrow.IntentNotExpired.selector);
        escrow.refund(intentHash);
    }

    // --- dispute: challenge + resolve(claimValid = true) --------------------

    function test_dispute_resolveValid_paysSolverBothBonds() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(challenger);
        escrow.challenge{value: bond}(intentHash);

        vm.prank(arbiter);
        escrow.resolve(intentHash, true);

        assertEq(usdc.balanceOf(solver), 100e6);
        assertEq(solver.balance, 100 ether - bond + bond + bond); // solver bond back + challenger's bond

        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Finalized));
    }

    // --- dispute: challenge + resolve(claimValid = false) -------------------

    function test_dispute_resolveInvalid_refundsUserSlashesLiar() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(challenger);
        escrow.challenge{value: bond}(intentHash);

        vm.prank(arbiter);
        escrow.resolve(intentHash, false);

        assertEq(usdc.balanceOf(user), 1_000e6); // principal back
        assertEq(challenger.balance, 100 ether - bond + bond + bond); // own bond back + solver's slashed bond

        assertEq(uint8(escrow.statusOf(intentHash)), uint8(XebraEscrow.Status.Refunded));
    }

    function test_resolve_revertsForNonArbiter() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);
        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(challenger);
        escrow.challenge{value: bond}(intentHash);

        vm.expectRevert(XebraEscrow.NotArbiter.selector);
        escrow.resolve(intentHash, true);
    }

    function test_challenge_revertsAfterWindowCloses() public {
        (bytes32 intentHash,) = _openDefault();
        _claimDefault(intentHash);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 bond = escrow.requiredBond(100e6);
        vm.prank(challenger);
        vm.expectRevert(XebraEscrow.ChallengeWindowClosed.selector);
        escrow.challenge{value: bond}(intentHash);
    }

    // --- fuzz ----------------------------------------------------------------

    function testFuzz_requiredBond_neverBelowMinimum(uint96 sourceAmount) public view {
        uint256 bond = escrow.requiredBond(sourceAmount);
        assertGe(bond, escrow.MIN_BOND());
    }
}
