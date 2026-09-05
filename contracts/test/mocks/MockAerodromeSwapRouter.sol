// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAerodromeSwapRouter} from "../../src/interfaces/IAerodromeSwapRouter.sol";

/// @notice Slipstream SwapRouter double: fixed-rate `exactInputSingle`, pulls tokenIn from
///         msg.sender, pays `recipient`, honours deadline and amountOutMinimum. Must be funded with
///         tokenOut by the test.
contract MockAerodromeSwapRouter is IAerodromeSwapRouter {
    using SafeERC20 for IERC20;

    error Expired();
    error TooLittleReceived();
    error NoRate();

    struct Rate {
        uint256 num;
        uint256 den;
    }

    mapping(address => mapping(address => Rate)) public rates;

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rates[tokenIn][tokenOut] = Rate(num, den);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        Rate memory r = rates[tokenIn][tokenOut];
        if (r.den == 0) revert NoRate();
        return (amountIn * r.num) / r.den;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        if (block.timestamp > p.deadline) revert Expired();
        amountOut = quote(p.tokenIn, p.tokenOut, p.amountIn);
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }
}
