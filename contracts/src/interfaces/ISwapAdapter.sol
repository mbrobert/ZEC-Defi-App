// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISwapAdapter — the minimal spot hop the router needs (LP proceeds → the debt token).
///
/// @notice Called BY an OilskinAccount; the adapter instructs the account so the ACCOUNT is the
///         swapper and the recipient. Slippage is expressed as a QUOTE plus a bounded tolerance,
///         never as a bare `minOut`: a bare floor of 1 base unit is indistinguishable from a real
///         one at execution time, and the whole non-USDC leg of an unwind can be taken for it. The
///         adapter derives the floor from the caller's own quote, scaled to the amount actually
///         swapped, so a leg that comes back larger or smaller than quoted is still protected in
///         PROPORTION. CoW (batch auctions) is off-chain and lives in the web app; this is the
///         on-chain fallback.
interface ISwapAdapter {
    /// @param quotedIn  The input amount the caller's quote was taken for. Must be > 0.
    /// @param quotedOut The output that quote promised for `quotedIn`. Must be > 0.
    /// @param maxSlippageBps Tolerance below the quoted RATE, bounded by the adapter's own cap.
    /// @param routeData Adapter-specific routing (Aerodrome Slipstream: abi.encode(int24 tickSpacing)).
    /// @return amountOut Tokens received by the calling account (≥ the derived floor or it reverts).
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quotedIn,
        uint256 quotedOut,
        uint16 maxSlippageBps,
        uint256 deadline,
        bytes calldata routeData
    ) external returns (uint256 amountOut);

    /// @notice The floor `swap` would enforce for these arguments — the number a caller, a keeper
    ///         simulation or a UI should show, computed by the same code that enforces it.
    function minOutFor(uint256 amountIn, uint256 quotedIn, uint256 quotedOut, uint16 maxSlippageBps)
        external
        pure
        returns (uint256);

    /// @notice Hard ceiling on `maxSlippageBps`.
    function MAX_SLIPPAGE_BPS() external view returns (uint16);
}
