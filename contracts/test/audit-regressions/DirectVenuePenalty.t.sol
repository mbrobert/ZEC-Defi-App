// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ILpVenue, LpOpenParams} from "../../src/interfaces/ILpVenue.sol";
import {SlipstreamLpVenue} from "../../src/venues/SlipstreamLpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";

/// @notice Audit wave 3, W3-LOW-5 (`docs/AUDIT-2026-09-11.md`): the gauge factory's early-withdraw
///         penalty — `penaltyRate()` of the AERO to the minter while `block.timestamp <
///         depositTimestamp + minStakeTimes(pool)` — was not read anywhere. On Base the cbZEC/USDC
///         pool answers 10,000 bps for 10 seconds (`VERIFIED-BASE-FACTS.md` Addendum 9, block
///         51,193,797): a close inside those ten seconds forfeits every AERO earned. The venue now
///         reads it live (`earlyWithdrawPenalty`) and the dashboard and the Close plan show it.
contract DirectVenuePenaltyTest is Fixture {
    uint256 constant DEPOSIT = 10_000e6;

    function _open() internal returns (uint256 id) {
        usdc.mint(address(acct), DEPOSIT);
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_ID_DIRECT, DEPOSIT, 0, poolCbzecUsdc))));
        id = abi.decode(ret, (uint256));
    }

    /// The live numbers: 100 % for 10 seconds. Inside the window the whole reward goes to the
    /// minter and the fee is on nothing; after it, the reward is paid net of the fee.
    function test_W3_LOW_5_theViewReadsTheWindowAndACloseInsideItForfeitsTheReward() public {
        gaugeCbzec.setPenalty(10_000, 10);
        uint256 id = _open();
        uint256 stakedAt = block.timestamp;
        (uint256 bps, uint256 until) = directVenue.earlyWithdrawPenalty(id, address(acct));
        assertEq(bps, 10_000, "the whole reward, while the window is open");
        assertEq(until, stakedAt + 10);
        gaugeCbzec.setPending(id, 100e18);
        vm.warp(stakedAt + 9);
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (,, uint256 rewards) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(rewards, 0, "forfeited to the minter");
        assertEq(aero.balanceOf(gaugeCbzec.minter()), 100e18);
        assertEq(aero.balanceOf(treasury), 0, "no fee on a reward that was not paid");
    }

    function test_W3_LOW_5_afterTheWindowNothingIsForfeited() public {
        gaugeCbzec.setPenalty(10_000, 10);
        uint256 id = _open();
        uint256 stakedAt = block.timestamp;
        gaugeCbzec.setPending(id, 100e18);
        vm.warp(stakedAt + 10);
        (uint256 bps, uint256 until) = directVenue.earlyWithdrawPenalty(id, address(acct));
        assertEq(bps, 0, "the window has passed");
        assertEq(until, stakedAt + 10, "and the view still says when it did");
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (,, uint256 rewards) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(rewards, 90e18, "net of the 10 % fee");
        assertEq(aero.balanceOf(treasury), 10e18);
    }

    /// No penalty configured, an unstaked id, and a stranger's view: (0, …) and never a revert.
    function test_W3_LOW_5_noPenaltyUnstakedAndStrangerReadZero() public {
        uint256 id = _open();
        (uint256 bps, uint256 until) = directVenue.earlyWithdrawPenalty(id, address(acct));
        assertEq(bps, 0);
        assertEq(until, block.timestamp, "minStakeTime 0: the window closed at the stake");
        (bps, until) = directVenue.earlyWithdrawPenalty(id, bob);
        assertEq(bps, 0);
        assertEq(until, 0, "bob did not stake it");
        (bps, until) = directVenue.earlyWithdrawPenalty(424_242, address(acct));
        assertEq(bps + until, 0);
    }

    /// A gauge factory that cannot be read fails closed by name — never "no penalty".
    function test_W3_LOW_5_anUnreadableFactoryFailsClosed() public {
        uint256 id = _open();
        vm.mockCallRevert(address(gaugeCbzec), abi.encodeWithSignature("penaltyRate()"), "factory down");
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PenaltyUnreadable.selector, bytes("factory down")));
        directVenue.earlyWithdrawPenalty(id, address(acct));
    }
}
