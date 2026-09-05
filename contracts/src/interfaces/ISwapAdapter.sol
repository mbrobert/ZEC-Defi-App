// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISwapAdapter — the minimal spot hop the router needs (borrowed USDC → LP entry token).
///
/// @notice Called BY an OilskinAccount; the adapter instructs the account so the ACCOUNT is the
///         swapper and the recipient. `minOut` and `deadline` are mandatory on every call. CoW
///         (batch auctions) is off-chain and lives in the web app; this is the on-chain fallback.
interface ISwapAdapter {
    /// @param routeData Adapter-specific routing (Aerodrome Slipstream: abi.encode(int24 tickSpacing)).
    /// @return amountOut Tokens received by the calling account (≥ minOut or the call reverts).
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata routeData
    ) external returns (uint256 amountOut);
}
