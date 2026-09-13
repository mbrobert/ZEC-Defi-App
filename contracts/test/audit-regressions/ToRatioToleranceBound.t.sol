// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";

/// @notice The bound the Aderyn `unsafe-casting` suppression in `SlipstreamLpVenue._swap` relies on
///         (`uint16(tol)`, triaged 2026-09-12; slice O, 2026-09-13): for EVERY band the venue accepts —
///         non-zero, ordered, at most `MAX_BAND_BPS` wide — `toRatioToleranceBps(band)` is at most
///         min(BPS / 2, SWAP.MAX_SLIPPAGE_BPS()), and therefore fits a uint16 without truncation. A
///         second fuzz drops the width limit: the bound holds for any ordered pair at all, so the cast
///         is safe even on a band `_checkBand` would refuse.
contract ToRatioToleranceBoundTest is Fixture {
    uint256 constant BPS = 10_000;

    function _tolExpected(uint160 lo, uint160 hi, uint16 cap) internal pure returns (uint256 tol) {
        uint256 keepBps = Math.mulDiv(Math.mulDiv(BPS, lo, hi), lo, hi);
        tol = keepBps >= BPS ? 0 : (BPS - keepBps) / 2;
        if (tol > cap) tol = cap;
    }

    function testFuzz_PROP_toRatioToleranceIsBoundedForEveryAcceptedBand(uint160 lo, uint256 widthBps) public view {
        uint256 maxBand = directVenue.MAX_BAND_BPS();
        // Room for the widest accepted band above `lo` without leaving the sqrt-price domain.
        lo = uint160(bound(uint256(lo), TickMath.MIN_SQRT_RATIO, (uint256(TickMath.MAX_SQRT_RATIO) * BPS) / (BPS + maxBand)));
        widthBps = bound(widthBps, 0, maxBand);
        uint160 hi = uint160((uint256(lo) * (BPS + widthBps)) / BPS);
        PriceBand memory band = PriceBand({minSqrtPriceX96: lo, maxSqrtPriceX96: hi});
        // The shape `_checkBand` accepts (the price-inside-band read aside, which does not enter the tolerance).
        assertTrue(lo != 0 && hi != 0 && lo <= hi, "ordered, non-zero");
        assertLe(uint256(hi) * BPS, uint256(lo) * (BPS + maxBand), "not wider than MAX_BAND_BPS");

        uint256 tol = directVenue.toRatioToleranceBps(band);
        uint16 cap = directVenue.SWAP().MAX_SLIPPAGE_BPS();
        assertLe(tol, BPS / 2, "never more than half the basis");
        assertLe(tol, cap, "never more than the adapter's ceiling");
        assertLe(tol, type(uint16).max, "fits the uint16 the swap is called with");
        assertEq(uint256(uint16(tol)), tol, "the cast in _swap cannot truncate");
        assertEq(tol, _tolExpected(lo, hi, cap), "half the band's price span, capped");
        // A zero-width band is an exact fill; a band exactly as wide as the venue allows still sits under the cap.
        if (widthBps == 0) assertEq(tol, 0);
    }

    function testFuzz_PROP_toRatioToleranceIsBoundedForAnyOrderedPair(uint160 lo, uint160 hi) public view {
        lo = uint160(bound(uint256(lo), 1, type(uint160).max));
        hi = uint160(bound(uint256(hi), lo, type(uint160).max));
        PriceBand memory band = PriceBand({minSqrtPriceX96: lo, maxSqrtPriceX96: hi});
        uint256 tol = directVenue.toRatioToleranceBps(band);
        uint16 cap = directVenue.SWAP().MAX_SLIPPAGE_BPS();
        assertLe(tol, BPS / 2);
        assertLe(tol, cap);
        assertEq(uint256(uint16(tol)), tol);
        // The degenerate shapes read as an exact fill: `_checkBand` refuses them before any swap.
        assertEq(directVenue.toRatioToleranceBps(PriceBand({minSqrtPriceX96: 0, maxSqrtPriceX96: hi})), 0);
        assertEq(directVenue.toRatioToleranceBps(PriceBand({minSqrtPriceX96: hi, maxSqrtPriceX96: lo == hi ? hi : lo})), lo == hi ? 0 : 0);
    }
}
