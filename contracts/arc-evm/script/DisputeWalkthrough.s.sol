// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {XebraEscrow} from "../src/XebraEscrow.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Live dispute walkthrough against a running anvil: deploy -> user opens -> a solver
///         posts a FALSE delivery claim (no such Stellar tx exists) -> a challenger disputes it
///         -> the KMS-backed arbiter resolves claimValid=false -> the user is refunded and the
///         lying solver's bond is slashed to the challenger. Every state transition is asserted
///         on-chain via `require`, not just printed — a broken deploy fails loudly instead of
///         printing a false "PASSED".
///
/// Run:
///   anvil &
///   forge script script/DisputeWalkthrough.s.sol --rpc-url http://127.0.0.1:8545 --broadcast -vvv
contract DisputeWalkthrough is Script {
    // Foundry/anvil's universal well-known test mnemonic — not a secret, same one `anvil` prints
    // its default accounts from when started with no args.
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    function run() external {
        uint256 deployerKey = vm.deriveKey(MNEMONIC, 0);
        uint256 userKey = vm.deriveKey(MNEMONIC, 1);
        uint256 solverKey = vm.deriveKey(MNEMONIC, 2);
        uint256 challengerKey = vm.deriveKey(MNEMONIC, 3);
        uint256 arbiterKey = vm.deriveKey(MNEMONIC, 4);

        address user = vm.addr(userKey);
        address solver = vm.addr(solverKey);
        address challenger = vm.addr(challengerKey);
        address arbiter = vm.addr(arbiterKey);

        vm.startBroadcast(deployerKey);
        MockUSDC usdc = new MockUSDC();
        XebraEscrow escrow = new XebraEscrow(address(usdc), arbiter, 30 minutes);
        usdc.mint(user, 1_000e6);
        vm.stopBroadcast();

        console2.log("== Xebra Arc dispute walkthrough ==");
        console2.log("escrow:", address(escrow));
        console2.log("usdc:  ", address(usdc));
        console2.log("user:", user);
        console2.log("solver (will lie):", solver);
        console2.log("challenger:", challenger);
        console2.log("arbiter:", arbiter);

        // --- user signs and opens an intent for 500 USDC -> Stellar XLM ---
        XebraEscrow.Intent memory intent = XebraEscrow.Intent({
            user: user,
            sourceToken: address(usdc),
            sourceAmount: 500e6,
            destAsset: bytes32(0), // native XLM
            minDestAmount: 490_0000000, // 490 XLM, 7-decimal Stellar precision
            destAddress: bytes32(uint256(uint160(user))), // stand-in raw-32 slot for this demo
            expiry: uint64(block.timestamp + 1 days),
            nonce: 1
        });
        bytes32 digest = escrow.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.startBroadcast(userKey);
        usdc.approve(address(escrow), intent.sourceAmount);
        vm.stopBroadcast();

        vm.startBroadcast(deployerKey); // open() is permissionless — anyone may submit it
        escrow.open(intent, sig);
        vm.stopBroadcast();

        require(escrow.statusOf(digest) == XebraEscrow.Status.Open, "expected Open");
        console2.log("[1/5] intent opened, 500 USDC escrowed. status=Open");

        // --- solver posts a FALSE delivery claim: bonds correctly, but no such Stellar tx exists ---
        uint256 bond = escrow.requiredBond(intent.sourceAmount);
        vm.deal(solver, bond);
        vm.startBroadcast(solverKey);
        escrow.claim{value: bond}(digest, bytes32(uint256(0xdead)), intent.minDestAmount);
        vm.stopBroadcast();

        require(escrow.statusOf(digest) == XebraEscrow.Status.Claimed, "expected Claimed");
        console2.log("[2/5] solver posted a FALSE delivery claim (fabricated tx hash), bond =", bond);

        // --- challenger checks Horizon, finds nothing, disputes within the window ---
        vm.deal(challenger, bond);
        vm.startBroadcast(challengerKey);
        escrow.challenge{value: bond}(digest);
        vm.stopBroadcast();

        require(escrow.statusOf(digest) == XebraEscrow.Status.Challenged, "expected Challenged");
        console2.log("[3/5] challenger disputed the claim, matching bond =", bond);

        // --- arbiter resolves: the claim was false ---
        uint256 userUsdcBefore = usdc.balanceOf(user);
        uint256 challengerNativeBefore = challenger.balance;

        vm.startBroadcast(arbiterKey);
        escrow.resolve(digest, false);
        vm.stopBroadcast();

        require(escrow.statusOf(digest) == XebraEscrow.Status.Refunded, "expected Refunded");
        require(usdc.balanceOf(user) == userUsdcBefore + intent.sourceAmount, "user was not refunded");
        require(challenger.balance == challengerNativeBefore + 2 * bond, "challenger did not receive both bonds");

        console2.log("[4/5] arbiter resolved claimValid=false");
        console2.log("[5/5] user refunded 500 USDC principal; challenger paid both bonds; liar's bond slashed");
        console2.log("== dispute walkthrough PASSED: all on-chain assertions held ==");
    }
}
