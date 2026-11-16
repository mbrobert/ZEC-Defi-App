// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HyperCoreLib} from "../../src/libraries/HyperCoreLib.sol";
import {PerpHealthLib} from "../../src/libraries/PerpHealthLib.sol";
import {HyperliquidPerpVenue} from "../../src/venues/HyperliquidPerpVenue.sol";
import {PerpVenueRig} from "./PerpEntryLifetime.t.sol";

contract PerpLadderHarness {
    function ladder(uint256 e) external pure returns (PerpHealthLib.Ladder memory) {
        return PerpHealthLib.ladderFor(e);
    }
}

/// @notice AUDIT PV-2 (Medium). `reduce` (a partial one) and `addMargin` sized the reserve through
///         `PerpHealthLib.ladderFor(post-action HF)`, which reverts `EntryTooThinForLadder` under
///         MIN_LADDER_ENTRY_HF (1.10). An owner whose short was stressed could not cut it by a quarter or add a small
///         margin, exactly when they needed to: only a full close or a large de-risk went through. An owner action
///         that improves health is now never refused for landing under the ladder minimum: the action is sent, and
///         the record keeps the previous entry's distance and HF (the ladder the keeper protects on) with the new
///         size and the reserve that ladder needs at the new notional.
contract PerpStressedOwnerActionRegressionTest is PerpVenueRig {
    PerpLadderHarness lh;

    // the audit's worked example: 10x max leverage (mmr 500 bps), $1,000 of account value against $10,000 of notional
    uint64 constant MARK = 10_000_000; // 1000.0000
    uint64 constant SZ = 1_000; // 10.00 ZEC: $10,000
    int64 constant A_OPEN = 5_000_000_000; // the floor exactly: d 4285
    int64 constant A_STRESSED = 1_000_000_000;

    function setUp() public override {
        super.setUp();
        lh = new PerpLadderHarness();
    }

    function _openThenStress() internal returns (HyperliquidPerpVenue.Entry memory opened) {
        _scene(MARK, 0, A_OPEN);
        _open(SZ);
        opened = _entry();
        _scene(MARK, -int64(SZ), A_STRESSED);
    }

    function test_workedExample_theLibrarysOwnMath() public {
        uint256 d = PerpHealthLib.distanceBps(A_STRESSED, 10_000e6, MMR);
        assertEq(d, 476);
        assertEq(PerpHealthLib.equivalentHfBps(d), 10_499, "HF about 1.05");
        uint256 dQuarter = PerpHealthLib.distanceBps(A_STRESSED, 7_500e6, MMR);
        assertEq(dQuarter, 793);
        assertEq(PerpHealthLib.equivalentHfBps(dQuarter), 10_861, "a quarter off leaves HF about 1.086");
        vm.expectRevert(abi.encodeWithSelector(PerpHealthLib.EntryTooThinForLadder.selector, 10_861));
        lh.ladder(10_861);
        uint256 dAdd = PerpHealthLib.distanceBps(A_STRESSED + 30e6, 10_000e6, MMR);
        assertEq(PerpHealthLib.equivalentHfBps(dAdd), 10_530, "30 USDC of margin leaves HF about 1.053");
        vm.expectRevert(abi.encodeWithSelector(PerpHealthLib.EntryTooThinForLadder.selector, 10_530));
        lh.ladder(10_530);
    }

    function test_reduce_aStressedShortCanBeCutByAQuarter_andTheKeeperKeepsItsLadder() public {
        HyperliquidPerpVenue.Entry memory opened = _openThenStress();
        assertEq(opened.distanceBps, 4285);
        assertEq(opened.hfBps, 17_497);
        _reduce(250);
        assertEq(coreWriter.count(), 2, "the reduce-only buy was sent");
        assertEq(coreWriter.actions(1), HyperCoreLib.encodeLimitOrder(ZEC, true, 100_500_000_000, 250_000_000, true, HyperCoreLib.TIF_IOC));
        HyperliquidPerpVenue.Entry memory e = _entry();
        assertEq(e.distanceBps, opened.distanceBps, "under the ladder minimum the previous entry's ladder stays");
        assertEq(e.hfBps, opened.hfBps);
        assertEq(e.sz, 750, "the intended size is recorded");
        assertLt(e.reserveE6, opened.reserveE6, "the reserve the kept ladder needs at the smaller notional");
        assertGt(e.reserveE6, 0);
        // the quarter filled: HF 1.0861, past the kept ladder's derisk rung (1.27), above its emergency rung (1.07)
        _scene(MARK, -750, A_STRESSED);
        _grantKeeper(0x0E, 1_000e6, 200);
        PerpHealthLib.Ladder memory l = venue.ladderOf(address(acct));
        assertEq(l.hf[PerpHealthLib.RUNG_DERISK], 12_700);
        assertEq(l.hf[PerpHealthLib.RUNG_EMERGENCY], 10_700);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.RungNotCrossed.selector, PerpHealthLib.RUNG_EMERGENCY, 10_861, 10_700));
        acct.execAsKeeper(_protectCall(PerpHealthLib.RUNG_EMERGENCY, 0, 100));
        _protect(PerpHealthLib.RUNG_DERISK, 0, 100);
        assertEq(coreWriter.count(), 3);
    }

    function test_addMargin_aStressedShortTakesASmallTopUp() public {
        HyperliquidPerpVenue.Entry memory opened = _openThenStress();
        _owner(abi.encodeCall(HyperliquidPerpVenue.addMargin, (30e6)));
        assertEq(coreWriter.count(), 2);
        assertEq(coreWriter.actions(1), HyperCoreLib.encodeUsdClassTransfer(30e6, true));
        HyperliquidPerpVenue.Entry memory e = _entry();
        assertEq(e.distanceBps, opened.distanceBps, "under the ladder minimum the previous entry's ladder stays");
        assertEq(e.hfBps, opened.hfBps);
        assertEq(e.sz, SZ);
        assertEq(e.reserveE6, opened.reserveE6, "same ladder, same notional: the same reserve");
        // the reserve still binds: moving all but less than the reserve out of spot is refused by name
        _spot(opened.reserveE6 + 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, opened.reserveE6 - 20e6, opened.reserveE6));
        acct.execWithCallback(address(venue), 0, abi.encodeCall(HyperliquidPerpVenue.addMargin, (30e6)));
    }

    function test_atOrAboveTheMinimum_theOwnersActionStillRerecordsTheLiveNumber_D9() public {
        _openThenStress();
        _reduce(500); // half off: $5,000 against $1,000 is HF 1.1665
        HyperliquidPerpVenue.Entry memory e = _entry();
        uint256 d = PerpHealthLib.distanceBps(A_STRESSED, 5_000e6, MMR);
        assertEq(d, 1428);
        assertEq(e.distanceBps, d, "D9: the owner's action re-records, in both directions");
        assertEq(e.hfBps, 11_665);
        assertEq(e.sz, 500);
    }

    function test_noPreviousEntry_theActionStillGoes_andNothingIsInvented() public {
        // a short the account opened outside `open` (the owner's own hatch): no record to keep
        _scene(MARK, -int64(SZ), A_STRESSED);
        _reduce(250);
        _owner(abi.encodeCall(HyperliquidPerpVenue.addMargin, (30e6)));
        assertEq(coreWriter.count(), 2, "both actions were sent");
        assertEq(_entry().at, 0, "no ladder the owner never chose is written");
    }
}
