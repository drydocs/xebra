// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {XebraEscrow} from "../src/XebraEscrow.sol";

/// @notice Deploys XebraEscrow. Reads config from env so the same script targets testnet or
///         mainnet (see foundry.toml [rpc_endpoints]):
///           USDC_ADDRESS         - USDC contract on Arc for this environment
///           ARBITER_ADDRESS      - v1 admin arbiter (should be a KMS-backed signer, see
///                                  docs/architecture.md #8; a plain EOA is fine for testnet)
///           CHALLENGE_WINDOW_SECS - 1800 (30 min) for testnet, 86400 (24h) for mainnet default
contract DeployXebraEscrow is Script {
    function run() external returns (XebraEscrow escrow) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        uint256 challengeWindow = vm.envUint("CHALLENGE_WINDOW_SECS");

        vm.startBroadcast();
        escrow = new XebraEscrow(usdc, arbiter, challengeWindow);
        vm.stopBroadcast();

        console.log("XebraEscrow deployed:", address(escrow));
        console.log("  usdc:            ", usdc);
        console.log("  arbiter:         ", arbiter);
        console.log("  challengeWindow: ", challengeWindow);
    }
}
