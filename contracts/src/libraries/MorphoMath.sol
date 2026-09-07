// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Market, MarketParams, IIrm} from "../interfaces/IMorphoBlue.sol";

/// @title MorphoMath — the arithmetic Morpho Blue uses, reproduced so a venue can predict what the
///        protocol will do in the same block (debt in assets from borrow shares, interest since
///        `lastUpdate`) without a mutating `accrueInterest` call.
///
/// @dev Mirrors morpho-blue `MathLib` and `SharesMathLib` (virtual shares 1e6 / virtual assets 1,
///      third-order Taylor compounding). Any change to these constants upstream is a market
///      migration on Morpho's side, not a parameter — they are protocol arithmetic, not risk numbers.
library MorphoMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }

    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }

    function wMulDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return mulDivDown(x, y, WAD);
    }

    /// @dev Sum of the first three terms of the Taylor expansion of e^(x·n) − 1: Morpho's way of
    ///      compounding a per-second rate over `n` seconds.
    function wTaylorCompounded(uint256 x, uint256 n) internal pure returns (uint256) {
        uint256 firstTerm = x * n;
        uint256 secondTerm = mulDivDown(firstTerm, firstTerm, 2 * WAD);
        uint256 thirdTerm = mulDivDown(secondTerm, firstTerm, 3 * WAD);
        return firstTerm + secondTerm + thirdTerm;
    }

    function toSharesDown(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function toSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    /// @notice The borrow-side totals Morpho will hold AFTER it accrues interest in this block —
    ///         exactly `_accrueInterest`'s arithmetic (fee shares dilute suppliers, not borrowers,
    ///         so `totalBorrowShares` is unchanged).
    function expectedBorrowTotals(MarketParams memory params, Market memory m)
        internal
        view
        returns (uint256 totalBorrowAssets, uint256 totalBorrowShares)
    {
        totalBorrowAssets = m.totalBorrowAssets;
        totalBorrowShares = m.totalBorrowShares;
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0 || totalBorrowAssets == 0 || params.irm == address(0)) return (totalBorrowAssets, totalBorrowShares);
        uint256 rate = IIrm(params.irm).borrowRateView(params, m);
        totalBorrowAssets += wMulDown(totalBorrowAssets, wTaylorCompounded(rate, elapsed));
    }
}
