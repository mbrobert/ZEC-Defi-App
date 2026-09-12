// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IAerodromeSwapRouter} from "../interfaces/IAerodromeSwapRouter.sol";

/// @title AerodromeSwapAdapter — ISwapAdapter over the Aerodrome Slipstream SwapRouter
///        (Base: 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5, code-verified 2026-09-06).
///
/// @notice One direct `exactInputSingle` from the calling account to the calling account, with the
///         caller's quote and deadline. No storage, no admin. The recipient is ALWAYS the calling
///         account, so a keeper granted `swap` can at worst swap within its budget, never redirect.
///
/// @dev The slippage floor is RELATIVE, and that is the whole point: it is derived from the caller's
///      quote scaled to the amount actually being swapped, and the tolerance is capped at
///      MAX_SLIPPAGE_BPS here on chain. There is no way to express "accept one base unit" — the
///      worst a caller can do is pass a dishonest quote, which is an explicit number in calldata
///      that a reviewer, a keeper simulation or an event reader can compare against the market,
///      rather than a silent default of 1.
contract AerodromeSwapAdapter is ISwapAdapter, Peripheral {
    IAerodromeSwapRouter public immutable ROUTER;

    uint256 public constant BPS = 10_000;
    /// @inheritdoc ISwapAdapter
    uint16 public constant override MAX_SLIPPAGE_BPS = 500; // 5 %

    error ZeroAddress();
    error ZeroAmount();
    error ZeroQuote();
    error SlippageTooHigh(uint16 bps, uint16 cap);
    error Expired(uint256 deadline);
    error SameToken();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    event Swapped(
        address indexed account,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minOut
    );

    constructor(IAerodromeSwapRouter router) {
        if (address(router) == address(0)) revert ZeroAddress();
        ROUTER = router;
    }

    /// @inheritdoc ISwapAdapter
    function minOutFor(uint256 amountIn, uint256 quotedIn, uint256 quotedOut, uint16 maxSlippageBps)
        public
        pure
        override
        returns (uint256)
    {
        if (quotedIn == 0 || quotedOut == 0) revert ZeroQuote();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps, MAX_SLIPPAGE_BPS);
        // (amountIn / quotedIn) × quotedOut × (1 − tolerance), floor-rounded.
        return (amountIn * quotedOut * (BPS - maxSlippageBps)) / (quotedIn * BPS);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev Invariant: recipient = calling account; the floor is `minOutFor(...)` and is compared to
    ///      the amount the account ACTUALLY received — its `tokenOut` balance delta across the call
    ///      — so a router that lies about its return value does not help (until wave 3's W3-LOW-6
    ///      the comparison was on the return value, and this sentence was not true); the allowance
    ///      is exact and reset; a deadline is mandatory.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quotedIn,
        uint256 quotedOut,
        uint16 maxSlippageBps,
        uint256 deadline,
        bytes calldata routeData
    ) external override returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert Expired(deadline);
        if (tokenIn == tokenOut) revert SameToken();
        uint256 minOut = minOutFor(amountIn, quotedIn, quotedOut, maxSlippageBps);
        if (minOut == 0) revert ZeroQuote();
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
        uint256 outBefore = IERC20(tokenOut).balanceOf(msg.sender);
        _approveCallReset(
            tokenIn,
            address(ROUTER),
            amountIn,
            Call({
                target: address(ROUTER),
                value: 0,
                data: abi.encodeCall(IAerodromeSwapRouter.exactInputSingle, (p)),
                callback: false
            })
        );
        // What the account holds now minus what it held before is the swap's output; the router's
        // return value is not consulted (W3-LOW-6).
        uint256 outAfter = IERC20(tokenOut).balanceOf(msg.sender);
        amountOut = outAfter > outBefore ? outAfter - outBefore : 0;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, minOut);
    }
}
