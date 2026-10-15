// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {ITokenMessengerV2, XebraCctpWrapper} from "../src/XebraCctpWrapper.sol";

/// Deploys against Circle's real contracts on an Arc testnet fork.
///
/// Run with `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test --match-contract Fork`.
/// Skipped without it, so the default suite needs no network.
///
/// # Why the burn itself is not run here
///
/// Arc's USDC is the native gas token behind an ERC-20 face, and its `transferFrom` calls two Arc
/// precompiles: `0x1800…01` (`isBlocklisted`) and `0x1800…00` (`transfer`, which moves the native
/// balance). A local fork has neither, and standing in for the second would fake exactly the
/// balances a burn test exists to check (tried 2026-10-14). The burn is proven on Arc testnet with
/// real transactions instead (`scripts/test-arc-wrapper-testnet.sh`).
contract XebraCctpWrapperForkTest is Test {
    IERC20 internal constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    ITokenMessengerV2 internal constant MESSENGER = ITokenMessengerV2(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA);

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function test_deploysAgainstCirclesArcContracts() public {
        XebraCctpWrapper.DomainCfg[] memory domains = new XebraCctpWrapper.DomainCfg[](1);
        domains[0] = XebraCctpWrapper.DomainCfg({
            domain: 6,
            evmStyle: true,
            maxForwardFee: 250_000,
            accountCreation: false,
            maxForwardFeeNewAccount: 0
        });
        XebraCctpWrapper wrapper = new XebraCctpWrapper(
            USDC,
            MESSENGER,
            makeAddr("admin"),
            makeAddr("pauser"),
            makeAddr("feeRecipient"),
            XebraCctpWrapper.Params({
                feeBps: 10,
                minFee: 300_000,
                minTransfer: 1_000_000,
                maxTransfer: 100_000_000,
                maxFastFeeBps: 5
            }),
            domains
        );
        // Read through Circle's messenger and transmitter, not configured: Arc is domain 26.
        assertEq(wrapper.localDomain(), 26);
        assertEq(address(wrapper.tokenMessenger()), address(MESSENGER));
    }
}
