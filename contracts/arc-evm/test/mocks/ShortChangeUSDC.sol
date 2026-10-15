// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token that delivers 1 unit less than asked on every transfer, standing in for any
/// token that does not arrive whole. USDC does not do this; the wrapper checks anyway.
contract ShortChangeUSDC is ERC20 {
    constructor() ERC20("Short USD", "sUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0xdead), 1);
            super._update(from, to, value - 1);
        } else {
            super._update(from, to, value);
        }
    }
}
