// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {SlipstreamLpVenue} from "../../src/venues/SlipstreamLpVenue.sol";
import {SlipstreamPoolSwapAdapter} from "../../src/swap/SlipstreamPoolSwapAdapter.sol";

/// @notice Audit wave 3, W3-LOW-2 (`docs/AUDIT-2026-09-11.md`): the direct venue's to-ratio swap
///         took its tolerance from the band's edge RELATIVE TO THE CURRENT PRICE, so a deposit whose
///         pool price had drifted to the band's edge between quote and execution swapped with a
///         tolerance of zero and any impact at all refused the open (no loss; a dead open). The
///         tolerance is now half the band's own price span — the window the user signed — capped
///         at the adapter's ceiling, wherever inside the band the price sits.
contract DirectVenueBandEdgeTest is Fixture {
    uint256 constant DEPOSIT = 10_000e6;

    function _openAt(PriceBand memory band) internal returns (bool ok, bytes memory ret) {
        usdc.mint(address(acct), DEPOSIT);
        LpOpenParams memory p = _openParams(POOL_ID_DIRECT, DEPOSIT, 0, poolCbzecUsdc);
        p.band = band;
        vm.prank(alice);
        (ok, ret) = address(acct).call(abi.encodeCall(acct.execWithCallback, (address(directVenue), 0, abi.encodeCall(ILpVenue.open, (p)))));
    }

    /// The price sits exactly on the band's lower edge; the pool pays 0.1 % under its own price
    /// (an impact any real swap has). Before the fix: `InsufficientOutput` — the tolerance was 0.
    function test_W3_LOW_2_anOpenAtTheBandsLowerEdgeStillSwapsToRatio() public {
        uint160 sp = poolCbzecUsdc.sqrtPriceX96();
        PriceBand memory edge = PriceBand({minSqrtPriceX96: sp, maxSqrtPriceX96: uint160(uint256(sp) * 11 / 10)});
        poolCbzecUsdc.setShortPayBps(10);
        (bool ok, bytes memory ret) = _openAt(edge);
        assertTrue(ok, string(abi.encodePacked("open refused at the band's edge: ", ret)));
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
    }

    /// The same at the band's UPPER edge selling the other way (a cbZEC deposit sells cbZEC).
    function test_W3_LOW_2_anOpenAtTheBandsUpperEdgeSellingToken1StillSwaps() public {
        uint160 sp = poolCbzecUsdc.sqrtPriceX96();
        PriceBand memory edge = PriceBand({minSqrtPriceX96: uint160(uint256(sp) * 9 / 10), maxSqrtPriceX96: sp});
        poolCbzecUsdc.setShortPayBps(10);
        cbzec.mint(address(acct), 5e8);
        LpOpenParams memory p = _openParams(POOL_ID_DIRECT, 0, 5e8, poolCbzecUsdc);
        p.band = edge;
        _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (p)));
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
    }

    /// The tolerance is the band's half-span in price terms, capped at the adapter's ceiling, and
    /// it does not depend on where inside the band the price sits.
    function test_W3_LOW_2_toleranceIsHalfTheBandSpanCappedAtTheAdapterCeiling() public view {
        uint160 sp = poolCbzecUsdc.sqrtPriceX96();
        // ±1 % in sqrt space: keep = (0.99 / 1.01)² ≈ 0.9608, so the span is ≈ 3.92 % and half of it
        // ≈ 1.96 %; in the venue's floor-rounded integer arithmetic, 197 bps.
        PriceBand memory narrow = PriceBand({minSqrtPriceX96: uint160(uint256(sp) * 99 / 100), maxSqrtPriceX96: uint160(uint256(sp) * 101 / 100)});
        uint256 tol = directVenue.toRatioToleranceBps(narrow);
        assertApproxEqAbs(tol, 196, 2);
        // ±10 %: half the span ≈ 16.5 % → capped at 500.
        PriceBand memory wide = PriceBand({minSqrtPriceX96: uint160(uint256(sp) * 9 / 10), maxSqrtPriceX96: uint160(uint256(sp) * 11 / 10)});
        assertEq(directVenue.toRatioToleranceBps(wide), poolSwapAdapter.MAX_SLIPPAGE_BPS());
        // A zero-width band asks for an exact fill: tolerance 0 — the adapter then refuses any impact by name.
        PriceBand memory point = PriceBand({minSqrtPriceX96: sp, maxSqrtPriceX96: sp});
        assertEq(directVenue.toRatioToleranceBps(point), 0);
    }

    /// The cap still binds: a pool paying 6 % short is refused whatever the band.
    function test_W3_LOW_2_theAdapterCeilingStillRefusesASixPercentShortfall() public {
        uint160 sp = poolCbzecUsdc.sqrtPriceX96();
        PriceBand memory wide = PriceBand({minSqrtPriceX96: uint160(uint256(sp) * 9 / 10), maxSqrtPriceX96: uint160(uint256(sp) * 11 / 10)});
        poolCbzecUsdc.setShortPayBps(600);
        (bool ok, bytes memory ret) = _openAt(wide);
        assertFalse(ok);
        assertEq(bytes4(ret), SlipstreamPoolSwapAdapter.InsufficientOutput.selector);
    }
}
