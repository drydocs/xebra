// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Stands in for Circle's MessageTransmitterV2: only the domain is read.
contract MockMessageTransmitterV2 {
    uint32 public localDomain;

    constructor(uint32 domain) {
        localDomain = domain;
    }
}

/// @notice Stands in for Circle's TokenMessengerV2. Pulls the burn amount from the caller exactly
/// as the real one does (`transferFrom(msg.sender, minter, amount)`) and records every argument,
/// so a test can assert what Circle would have been asked to do. Not the real Circle contract.
contract MockTokenMessengerV2 {
    struct Call {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
        address sender;
    }

    address public immutable localMessageTransmitter;
    address public constant MINTER = address(0xB0127);

    /// How much of the approved amount to actually pull, in basis points; 10_000 is Circle's
    /// behaviour. Lower simulates a messenger that leaves allowance behind.
    uint256 public pullBps = 10_000;
    Call[] internal _calls;

    constructor(uint32 localDomain_) {
        localMessageTransmitter = address(new MockMessageTransmitterV2(localDomain_));
    }

    function setPullBps(uint256 bps) external {
        pullBps = bps;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external virtual {
        require(maxFee < amount, "max fee must be less than amount");
        require(hookData.length > 0, "hook required");
        IERC20(burnToken).transferFrom(msg.sender, MINTER, amount * pullBps / 10_000);
        _calls.push(
            Call(
                amount,
                destinationDomain,
                mintRecipient,
                burnToken,
                destinationCaller,
                maxFee,
                minFinalityThreshold,
                hookData,
                msg.sender
            )
        );
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function lastCall() external view returns (Call memory) {
        return _calls[_calls.length - 1];
    }
}

/// @notice A messenger that calls back into the wrapper mid-burn, to prove the guard holds.
contract ReentrantTokenMessengerV2 is MockTokenMessengerV2 {
    address public target;
    bytes public payload;

    constructor(uint32 localDomain_) MockTokenMessengerV2(localDomain_) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function depositForBurnWithHook(
        uint256,
        uint32,
        bytes32,
        address,
        bytes32,
        uint256,
        uint32,
        bytes calldata
    ) external override {
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
