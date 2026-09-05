// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IAerodromeSwapRouter} from "../interfaces/IAerodromeSwapRouter.sol";

/// @title AerodromeSwapAdapter — ISwapAdapter over the Aerodrome Slipstream SwapRouter.
///
/// @notice One direct `exactInputSingle` from the calling account to the calling account, with the
///         caller's minOut and deadline. No storage, no admin. The recipient is ALWAYS the calling
///         account, so a keeper granted `swap` can at worst swap within its budget, never redirect.
contract AerodromeSwapAdapter is ISwapAdapter, Peripheral {
    IAerodromeSwapRouter public immutable ROUTER;

    error ZeroAddress();
    error ZeroAmount();
    error ZeroMinOut();
    error Expired(uint256 deadline);
    error SameToken();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    event Swapped(
        address indexed account,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(IAerodromeSwapRouter router) {
        if (address(router) == address(0)) revert ZeroAddress();
        ROUTER = router;
    }

    /// @inheritdoc ISwapAdapter
    /// @dev Invariant: recipient = calling account; minOut > 0 and deadline ≥ now are required;
    ///      the allowance is exact and reset; amountOut < minOut reverts even if the router lied.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata routeData
    ) external override returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert ZeroMinOut();
        if (deadline < block.timestamp) revert Expired(deadline);
        if (tokenIn == tokenOut) revert SameToken();
        int24 tickSpacing = abi.decode(routeData, (int24));

        IAerodromeSwapRouter.ExactInputSingleParams memory p = IAerodromeSwapRouter
            .ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            tickSpacing: tickSpacing,
            recipient: msg.sender,
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
        bytes memory ret = _approveCallReset(
            tokenIn,
            address(ROUTER),
            amountIn,
            Call({
                target: address(ROUTER),
                value: 0,
                data: abi.encodeCall(IAerodromeSwapRouter.exactInputSingle, (p))
            })
        );
        amountOut = abi.decode(ret, (uint256));
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }
}
