// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call} from "../../src/interfaces/IOilskinAccount.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {SnuggleLpVenue} from "../../src/venues/SnuggleLpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {MockCLPool} from "../mocks/MockCLPool.sol";

/// @notice An engine whose end-of-list behaviour is configurable (from `test/poc/LensB_Lp.t.sol`):
///         which index reverts, whether the revert carries data, and whether a far "canary" index
///         answers. Only the surface `SnuggleLpVenue.positionsOf` touches is implemented.
contract AdversarialEngine {
    enum EndShape {
        EmptyRevert, // `revert()` — no return data at all (proxy miss, OOG, bare revert)
        Panic32, // the compiler-generated array-bounds shape the live engine uses
        Answers // a mapping-style getter: every index answers, nothing ever reverts
    }

    address public holder;
    uint256[] public list;
    EndShape public shape;
    /// @dev An index BEFORE the end that fails transiently with the same shape as the end.
    uint256 public transientBadIndex = type(uint256).max - 1;

    function configure(address holder_, uint256[] calldata ids, EndShape s) external {
        holder = holder_;
        delete list;
        for (uint256 i = 0; i < ids.length; i++) list.push(ids[i]);
        shape = s;
    }

    function setTransientBadIndex(uint256 i) external {
        transientBadIndex = i;
    }

    function poolIdsCount() external pure returns (uint256) {
        return 1;
    }

    function userPositions(address, uint256 index) external view returns (uint256) {
        if (shape == EndShape.Answers) return index < list.length ? list[index] : 0;
        if (index == transientBadIndex || index >= list.length) {
            if (shape == EndShape.EmptyRevert) revert();
            uint256[] memory empty = new uint256[](0);
            return empty[index]; // Panic(0x32)
        }
        return list[index];
    }

    function positions(uint256 id)
        external
        view
        returns (
            uint256, bytes32, address, uint24, int24, int24, bool, bool, uint64, uint64, uint32, uint32,
            uint64, uint128, uint128, uint128, uint128
        )
    {
        return (id, bytes32(uint256(1)), holder, 1500, 0, 0, false, true, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}

/// @notice Harvested from wave-1 lens B (`test/poc/LensB_Lp.t.sol`), expectations flipped to the
///         FIXED behaviour with the attack setups kept intact.
///
///   B-HIGH-1  `closeMany` and `claim` derived the batch's pool from `positionIds[0]` with a
///             REVERTING lookup, so a keeper rebalance between read and dispatch (the engine's
///             normal operation with autoSnuggle on) killed the whole protective unwind.
///   B-MED-4   `_takeFee` ran twice on a pool whose two tokens were the same — 19 % at a 10 %
///             setting, above a cap the contract advertises as absolute.
///   B-MED-5   the enumeration canary measured the SHAPE of a revert, not its cause, so an engine
///             whose out-of-range read is a bare `revert()` truncated the list silently.
///   B-LOW-2   the price band's WIDTH was unbounded: `[1, uint160.max]` was accepted as "a band".
contract LpVenueCliffsRegressionTest is Fixture {
    function setUp() public override {
        super.setUp();
        usdc.mint(address(acct), 1_000_000e6);
        weth.mint(address(acct), 1_000e18);
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        aero.mint(address(engine), 1_000_000e18);
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    function _openUsdc(uint256 amount) internal returns (uint256 id) {
        bytes memory ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.open, (_openParams(POOL_WETH_USDC, 0, amount, poolWethUsdc)))
        );
        id = abi.decode(ret, (uint256));
    }

    function _idsOf(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        (arr[0], arr[1]) = (a, b);
    }

    function _closeMany(uint256[] memory ids)
        internal
        returns (uint256 out0, uint256 out1, uint256 rew, uint256[] memory failed)
    {
        bytes memory ret = _ownerExec(
            address(lpVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _band(poolWethUsdc, 1000)))
        );
        (out0, out1, rew, failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
    }

    // =====================================================================
    // FIX B-10 (D5). "An un-closable id is skipped, never blocking" is true at index 0 now.
    // =====================================================================

    function test_FIX_B10_staleFirstIdIsReportedNotFatal() public {
        uint256 a = _openUsdc(10_000e6);
        uint256 b = _openUsdc(10_000e6);
        // AUDIT-FINDINGS FACT 2: a keeper rebalance REPLACES the id; `positions(old)` reads all-zero.
        uint256 aNew = engine.rekey(a);
        assertGt(aNew, b);
        (, address ownerOfStale) = lpVenue.poolOf(a);
        assertEq(ownerOfStale, address(0), "re-keyed id reads back all-zero");

        // Stale id FIRST — used to revert the whole batch.
        (, uint256 out1,, uint256[] memory failed) = _closeMany(_pair(a, b));
        assertEq(out1, 10_000e6, "the healthy position was still closed and paid");
        assertEq(failed.length, 1);
        assertEq(failed[0], a, "and the stale id is reported");

        // The same set in the other order behaves identically — order no longer decides anything.
        uint256 c = _openUsdc(10_000e6);
        uint256 d = _openUsdc(10_000e6);
        engine.rekey(c);
        (, out1,, failed) = _closeMany(_pair(d, c));
        assertEq(out1, 10_000e6);
        assertEq(failed.length, 1);
        assertEq(failed[0], c);
    }

    function test_FIX_B10b_routerUnwindSurvivesAReKey() public {
        cbbtc.mint(address(acct), 1e8);
        _ownerExec(address(aaveVenue), abi.encodeWithSignature("supply(address,uint256)", address(cbbtc), 1e8));
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = 0;
        p.borrowAmount = 30_000e6;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (uint256 id,) = abi.decode(ret, (uint256, uint256));

        engine.rekey(id); // keeper rebalance between the read and the dispatch

        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = _idsOf(id);
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({
            quotedIn: 1e18,
            quotedOut: 2453_450000,
            maxSlippageBps: 100,
            routeData: abi.encode(int24(100))
        });
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 10 minutes;

        // The stale LP id is reported; the USDC repay — the whole point of the protective rung —
        // still happens out of what the account holds.
        usdc.mint(address(acct), 30_000e6);
        ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (,, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        withdrawn;
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the debt WAS repaid");
    }

    // =====================================================================
    // FIX B-11 (B-MED-5). The terminating revert must be exactly Panic(0x32).
    // =====================================================================

    function test_FIX_B11_anEmptyRevertShapeFailsClosedInsteadOfTruncating() public {
        AdversarialEngine adv = new AdversarialEngine();
        SnuggleLpVenue v = new SnuggleLpVenue(ISnuggleVault(address(adv)), address(aero), treasury, 1000);
        uint256[] memory five = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) five[i] = 100 + i;
        adv.configure(address(acct), five, AdversarialEngine.EndShape.EmptyRevert);

        // An engine whose out-of-range read carries no data can no longer be enumerated at all:
        // "cannot enumerate" is never reported as "owns fewer" or "owns nothing".
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, bytes("")));
        v.positionsOf(address(acct));

        adv.setTransientBadIndex(2);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, bytes("")));
        v.positionsOf(address(acct));

        adv.setTransientBadIndex(0);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, bytes("")));
        v.positionsOf(address(acct));
    }

    function test_FIX_B11b_theLiveShapeStillEnumeratesButAMidListFailureFailsClosed() public {
        AdversarialEngine adv = new AdversarialEngine();
        SnuggleLpVenue v = new SnuggleLpVenue(ISnuggleVault(address(adv)), address(aero), treasury, 1000);
        uint256[] memory three = new uint256[](3);
        (three[0], three[1], three[2]) = (7, 8, 9);
        adv.configure(address(acct), three, AdversarialEngine.EndShape.Panic32);
        assertEq(v.positionsOf(address(acct)).length, 3, "the live shape still enumerates");

        // A Panic(0x32) at index 1 is still indistinguishable from the end of a 1-element list —
        // that is a property of the engine's getter, not of this contract. Recorded, not claimed
        // fixed: the fix removes every OTHER shape that used to be mistaken for the end.
        adv.setTransientBadIndex(1);
        assertEq(v.positionsOf(address(acct)).length, 1);
    }

    function test_FIX_B11c_canaryThatAnswersStillFailsClosed() public {
        AdversarialEngine adv = new AdversarialEngine();
        SnuggleLpVenue v = new SnuggleLpVenue(ISnuggleVault(address(adv)), address(aero), treasury, 1000);
        uint256[] memory two = new uint256[](2);
        (two[0], two[1]) = (1, 2);
        adv.configure(address(acct), two, AdversarialEngine.EndShape.Answers);
        vm.expectRevert();
        v.positionsOf(address(acct));
    }

    function test_FIX_B11d_duplicateIdsAreStillNeverPaidTwice() public {
        uint256 id = _openUsdc(1_000e6);
        (, uint256 out1,, uint256[] memory failed) = _closeMany(_pair(id, id));
        assertEq(out1, 1_000e6, "principal paid exactly once");
        assertEq(failed.length, 1);
        assertEq(failed[0], id);
    }

    // =====================================================================
    // FIX B-12b (B-MED-4). The fee chokepoint cannot charge twice.
    // =====================================================================

    function test_FIX_B12b_degeneratePoolIsRefusedOnTheWayIn() public {
        bytes32 degenerate = keccak256("degenerate-usdc-usdc");
        MockCLPool p = new MockCLPool(address(usdc), address(usdc), 100, 100, poolWethUsdc.sqrtPriceX96());
        engine.addPool(degenerate, address(p), address(usdc), address(usdc), 100);
        LpOpenParams memory op = _openParams(degenerate, 0, 1_000e6, p);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.DegeneratePool.selector, degenerate, address(usdc))
        );
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (op)));
        assertEq(usdc.balanceOf(treasury), 0, "no fee, because no deposit");
    }

    /// …and the router refuses to build one either.
    function test_FIX_B12c_theRouterRefusesADegeneratePool() public {
        bytes32 degenerate = keccak256("degenerate-usdc-usdc-2");
        MockCLPool p = new MockCLPool(address(usdc), address(usdc), 100, 100, poolWethUsdc.sqrtPriceX96());
        engine.addPool(degenerate, address(p), address(usdc), address(usdc), 100);
        cbbtc.mint(address(acct), 1e8);
        _ownerExec(address(aaveVenue), abi.encodeWithSignature("supply(address,uint256)", address(cbbtc), 1e8));
        StrategyRouter.OpenParams memory op;
        op.collateralAsset = address(cbbtc);
        op.borrowAmount = 1_000e6;
        op.poolId = degenerate;
        op.rangeWidthBps = 1500;
        op.rebalanceDelay = 12 hours;
        op.band = _band(p, 1000);
        op.deadline = block.timestamp + 10 minutes;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.DegeneratePool.selector, degenerate, address(usdc))
        );
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLeveragedLp, (op)));
    }

    /// The fee on every non-degenerate path is unchanged: exactly performanceBps, exactly once.
    function testFuzz_FIX_B15_feeBoundOnEveryPath(uint96 principal, uint96 yield, bool viaClaim) public {
        uint256 pr = bound(uint256(principal), 1e6, 100_000e6);
        uint256 yd = bound(uint256(yield), 0, 100_000e6);
        uint256 id = _openUsdc(pr);
        if (yd != 0) engine.setPendingFee(id, address(usdc), yd);
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 a0 = usdc.balanceOf(address(acct));
        if (viaClaim) {
            _ownerExec(
                address(lpVenue),
                abi.encodeCall(ILpVenue.claim, (_idsOf(id), _band(poolWethUsdc, 1000), block.timestamp + 60))
            );
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolWethUsdc, 1000))));
        } else {
            _closeMany(_idsOf(id));
        }
        uint256 fee = usdc.balanceOf(treasury) - t0;
        assertLe(fee, (yd * PERF_BPS) / 10_000, "fee above the cap");
        assertEq(usdc.balanceOf(address(acct)) - a0, pr + yd - fee, "principal + net yield returned");
        assertEq(usdc.balanceOf(address(lpVenue)), 0, "venue holds nothing");
    }

    // =====================================================================
    // FIX B-14 (B-LOW-2). The band's WIDTH is bounded, so "there is no 'no band'" is true.
    // =====================================================================

    function test_FIX_B14_anUnboundedWindowIsRefused() public {
        uint256 maxBandBps = lpVenue.MAX_BAND_BPS();
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        p.band = PriceBand({minSqrtPriceX96: 1, maxSqrtPriceX96: type(uint160).max});
        bytes memory data = abi.encodeCall(ILpVenue.open, (p));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnuggleLpVenue.BandTooWide.selector, uint160(1), type(uint160).max, maxBandBps
            )
        );
        acct.execWithCallback(address(lpVenue), 0, data);

        // The band still fails closed on an unreadable price, exactly as before.
        poolWethUsdc.setSqrtPrice(0);
        p.band = PriceBand({minSqrtPriceX96: 1_000_000, maxSqrtPriceX96: 1_100_000});
        data = abi.encodeCall(ILpVenue.open, (p));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.PriceUnreadable.selector, address(poolWethUsdc))
        );
        acct.execWithCallback(address(lpVenue), 0, data);
    }

    /// A real window — the shape the product actually sends — still passes.
    function test_FIX_B14b_aRealWindowStillPasses() public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p)));
        assertEq(lpVenue.positionsOf(address(acct)).length, 1);
    }
}
