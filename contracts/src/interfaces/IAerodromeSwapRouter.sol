// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Aerodrome Slipstream SwapRouter — `exactInputSingle` with `tickSpacing` in place of
///         Uniswap's `fee`. ⚠ The router ADDRESS is NOT in VERIFIED-BASE-FACTS: it must be probed
///         (code present, `exactInputSingle` selector answers on a tiny swap in a fork) and recorded
///         there before Deploy.s.sol is run on Base. The deploy script refuses to proceed without it.
interface IAerodromeSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
