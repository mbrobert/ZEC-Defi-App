// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {SnuggleLpVenue} from "../src/venues/SnuggleLpVenue.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {MockSnuggleVault} from "./mocks/MockSnuggleVault.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {Call} from "../src/interfaces/IOilskinAccount.sol";

contract SnuggleLpVenueTest is Fixture {
    function setUp() public override {
        super.setUp();
        usdc.mint(address(acct), 1_000_000e6);
        weth.mint(address(acct), 1_000e18);
        cbzec.mint(address(acct), 1_000e8);
        // engine holds fee / reward inventory to pay out
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        aero.mint(address(engine), 1_000_000e18);
    }

    function _open(LpOpenParams memory p) internal returns (uint256 id) {
        bytes memory ret = _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p)));
        id = abi.decode(ret, (uint256));
    }

    function _openUsdc(uint256 amount) internal returns (uint256) {
        return _open(_openParams(POOL_WETH_USDC, 0, amount, poolWethUsdc));
    }

    function _close(uint256 id) internal returns (uint256 out0, uint256 out1, uint256 rewards) {
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolWethUsdc, 1000))));
        (out0, out1, rewards) = abi.decode(ret, (uint256, uint256, uint256));
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    // ------------------------------------------------------------- config

    function test_constructorCapsFeeAndRequiresAddresses() public {
        assertEq(lpVenue.MAX_PERFORMANCE_BPS(), 2000);
        assertEq(lpVenue.performanceBps(), PERF_BPS);
        assertEq(lpVenue.treasury(), treasury);
        new SnuggleLpVenue(ISnuggleVault(address(engine)), address(aero), treasury, 2000);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.FeeAboveCap.selector, 2001, 2000));
        new SnuggleLpVenue(ISnuggleVault(address(engine)), address(aero), treasury, 2001);
        vm.expectRevert(SnuggleLpVenue.ZeroAddress.selector);
        new SnuggleLpVenue(ISnuggleVault(address(engine)), address(aero), address(0), 1000);
        vm.expectRevert(SnuggleLpVenue.ZeroAddress.selector);
        new SnuggleLpVenue(ISnuggleVault(address(0)), address(aero), treasury, 1000);
    }

    function test_dustFloorIsDecimalsAware() public {
        assertEq(lpVenue.dustFloor(address(usdc)), 10); // 1e6 / 1e5
        assertEq(lpVenue.dustFloor(address(weth)), 1e13); // 1e18 / 1e5
        assertEq(lpVenue.dustFloor(address(cbbtc)), 1e3); // 1e8 / 1e5
        assertEq(lpVenue.dustFloor(address(cbzec)), 1e3);
        assertEq(lpVenue.dustFloor(makeAddr("no-decimals")), type(uint256).max, "unreadable: never fold");
    }

    function test_poolViews() public view {
        (address t0, address t1, address pool) = lpVenue.poolTokens(POOL_WETH_USDC);
        assertEq(t0, address(weth));
        assertEq(t1, address(usdc));
        assertEq(pool, address(poolWethUsdc));
        assertEq(lpVenue.poolSqrtPriceX96(POOL_WETH_USDC), poolWethUsdc.sqrtPriceX96());
    }

    // --------------------------------------------------------------- open

    function test_openSingleSidedMintsToAccount() public {
        uint256 id = _openUsdc(10_000e6);
        assertEq(id, 1);
        (, bytes32 poolId, address owner, uint24 width,,,, bool autoCompound, uint64 delay,,,,,,,,) =
            engine.positions(id);
        assertEq(owner, address(acct));
        assertEq(poolId, POOL_WETH_USDC);
        assertEq(width, 1500);
        assertEq(delay, 12 hours);
        assertTrue(autoCompound);
        assertEq(usdc.balanceOf(address(acct)), 990_000e6);
        assertEq(usdc.allowance(address(acct), address(engine)), 0, "allowance reset");
        (uint256 a0, uint256 a1) = engine.positionAmounts(id);
        assertEq(a0, 0);
        assertEq(a1, 10_000e6);
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
        (bytes32 pid, address o) = lpVenue.poolOf(id);
        assertEq(pid, POOL_WETH_USDC);
        assertEq(o, address(acct));
    }

    function test_openEmitsAndVenueHoldsNothing() public {
        vm.expectEmit(true, true, true, true);
        emit SnuggleLpVenue.LpOpened(address(acct), POOL_WETH_USDC, 1, 0, 10_000e6, 1500);
        _openUsdc(10_000e6);
        assertEq(usdc.balanceOf(address(lpVenue)), 0);
        assertEq(weth.balanceOf(address(lpVenue)), 0);
    }

    function test_openSingleSidedResidualIsFolded() public {
        engine.setSingleSidedResidualBps(100); // engine hands 1 % back
        uint256 before = usdc.balanceOf(address(acct));
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.RefundFolded(address(acct), address(usdc), 100e6, 2);
        uint256 id = _openUsdc(10_000e6);
        assertEq(id, 1);
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2, "residual re-deposited as a sibling id");
        // 1 % of the fold (1 USDC) bounces again and stays in the account (fold is one pass).
        assertEq(usdc.balanceOf(address(acct)), before - 10_000e6 + 1e6);
    }

    function test_openResidualBelowDustStaysInAccount() public {
        engine.setSingleSidedResidualBps(1); // 0.01 %
        uint256 before = usdc.balanceOf(address(acct));
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.RefundLeft(address(acct), address(usdc), 5);
        _openUsdc(50_000); // 0.05 USDC → residual 5 units < dust (10)
        assertEq(usdc.balanceOf(address(acct)), before - 50_000 + 5);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1);
    }

    function test_openDualBouncesLongLegAndFoldsIt() public {
        // 1 WETH ≈ 2453 USDC at the pool price; give 1 WETH + 5000 USDC → USDC is the long leg.
        uint256 usdcBefore = usdc.balanceOf(address(acct));
        uint256 wethBefore = weth.balanceOf(address(acct));
        uint256 id = _open(_openParams(POOL_WETH_USDC, 1e18, 5_000e6, poolWethUsdc));
        assertEq(id, 1);
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2, "bounce folded into a sibling id");
        (uint256 a0, uint256 a1) = engine.positionAmounts(1);
        assertEq(a0, 1e18);
        assertApproxEqRel(a1, 2_453_45e4, 0.01e18);
        (uint256 b0, uint256 b1) = engine.positionAmounts(2);
        assertEq(b0, 0);
        assertApproxEqRel(b1, 5_000e6 - a1, 0.01e18);
        assertEq(usdc.balanceOf(address(acct)), usdcBefore - 5_000e6, "everything deployed");
        assertEq(weth.balanceOf(address(acct)), wethBefore - 1e18);
        assertEq(usdc.allowance(address(acct), address(engine)), 0);
        assertEq(weth.allowance(address(acct), address(engine)), 0);
    }

    function test_openRejectsBadWidthDelayDeadlineAmounts() public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        vm.startPrank(alice);
        p.rangeWidthBps = 149;
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.InvalidWidth.selector, 149));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.rangeWidthBps = 5001;
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.InvalidWidth.selector, 5001));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 31 days;
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.InvalidDelay.selector, 31 days));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.rebalanceDelay = 1 hours;
        p.deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.Expired.selector, block.timestamp - 1));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.deadline = block.timestamp + 1;
        p.amount1 = 0;
        vm.expectRevert(SnuggleLpVenue.ZeroAmounts.selector);
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        vm.stopPrank();
        // boundary widths are accepted
        p.amount1 = 1_000e6;
        p.rangeWidthBps = 150;
        _open(p);
        p.rangeWidthBps = 5000;
        _open(p);
    }

    function test_openRejectsInactivePool() public {
        engine.setPoolActive(POOL_WETH_USDC, false);
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.PoolInactive.selector, POOL_WETH_USDC));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
    }

    // --------------------------------------------------------------- band

    function test_bandRequired() public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        vm.startPrank(alice);
        p.band = PriceBand(0, 0);
        vm.expectRevert(SnuggleLpVenue.BandRequired.selector);
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.band = PriceBand(2, 1);
        vm.expectRevert(SnuggleLpVenue.BandRequired.selector);
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        p.band = PriceBand(1, 0);
        vm.expectRevert(SnuggleLpVenue.BandRequired.selector);
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        vm.stopPrank();
    }

    function test_bandOutOfRangeReverts() public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        uint256 price = poolWethUsdc.sqrtPriceX96();
        p.band = PriceBand(uint160(price + 1), uint160(price + 2));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.PriceOutOfBand.selector, price, price + 1, price + 2)
        );
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        // price moves 20 % (sandwich) between quote and execution → band (±10 %) rejects
        p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        poolWethUsdc.setSqrtPrice(uint160((price * 120) / 100));
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
    }

    function test_bandFailsClosedWhenSlot0Unreadable() public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        poolWethUsdc.setMode(MockCLPool.Mode.Revert);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.PriceUnreadable.selector, address(poolWethUsdc))
        );
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        poolWethUsdc.setMode(MockCLPool.Mode.ShortReturn);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.PriceUnreadable.selector, address(poolWethUsdc))
        );
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        poolWethUsdc.setMode(MockCLPool.Mode.Normal);
        _open(p);
    }

    function test_bandFailsClosedWhenPoolIsNotAContract() public {
        bytes32 pid = keccak256("ghost");
        engine.addPool(pid, makeAddr("ghost-pool"), address(weth), address(usdc), 100);
        LpOpenParams memory p = _openParams(pid, 0, 1_000e6, poolWethUsdc);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.PriceUnreadable.selector, makeAddr("ghost-pool"))
        );
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
    }

    function test_bandAppliesToClose() public {
        uint256 id = _openUsdc(1_000e6);
        uint256 price = poolWethUsdc.sqrtPriceX96();
        poolWethUsdc.setSqrtPrice(uint160((price * 80) / 100));
        PriceBand memory band = PriceBand(uint160((price * 90) / 100), uint160((price * 110) / 100));
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, band)));
        poolWethUsdc.setMode(MockCLPool.Mode.Revert);
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.close, (id, band)));
    }

    // ---------------------------------------------------------- enumeration

    function test_positionsOfEmptyThenGrowsThenPrunes() public {
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        assertEq(lpVenue.positionsOf(bob).length, 0);
        uint256 a = _openUsdc(100e6);
        uint256 b = _openUsdc(100e6);
        uint256 c = _openUsdc(100e6);
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 3);
        assertEq(ids[0] + ids[1] + ids[2], a + b + c);
        _close(b);
        ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2);
        assertTrue(ids[0] != b && ids[1] != b);
    }

    function test_positionsOfReplaceOnRekey() public {
        uint256 a = _openUsdc(100e6);
        uint256 b = _openUsdc(100e6);
        uint256 newB = engine.rekey(b);
        assertTrue(newB != b);
        (uint256 tokenId, bytes32 poolId, address owner,,,,,,,,,,,,,,) = engine.positions(b);
        assertEq(tokenId, 0, "old id reads zero (FACT 2)");
        assertEq(poolId, bytes32(0));
        assertEq(owner, address(0));
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2);
        assertTrue((ids[0] == a && ids[1] == newB) || (ids[0] == newB && ids[1] == a));
        // and the old id cannot be closed — it is not ours any more (nor anyone's)
        bytes memory closeOld = abi.encodeCall(ILpVenue.close, (b, _band(poolWethUsdc, 1000)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.NotPositionOwner.selector, b, address(0)));
        acct.execWithCallback(address(lpVenue), 0, closeOld);
        // the new id closes fine
        _close(newB);
    }

    function test_positionsOfFailsClosedOnGlitchNotEmpty() public {
        _openUsdc(100e6);
        _openUsdc(100e6);
        engine.setGlitch(address(acct), 1, true);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, abi.encodeWithSignature("Error(string)", "engine glitch"))
        );
        lpVenue.positionsOf(address(acct));
    }

    /// The live engine's pause stops deposits only (`whenNotPaused` on `deposit` and the rebalance
    /// paths — verified source, slice B); views, exits and claims are untouched by it. What makes the
    /// venue report `EngineUnreachable` is an engine that does not answer at all — a proxy or node
    /// failure — which the mock's `setUnreachable` reproduces.
    function test_positionsOfFailsClosedWhenEngineUnreachable() public {
        uint256 id = _openUsdc(100e6);
        engine.setPaused(true);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1, "the engine's pause does not touch views");
        engine.setPaused(false);
        engine.setUnreachable(true);
        vm.expectRevert(SnuggleLpVenue.EngineUnreachable.selector);
        lpVenue.positionsOf(address(acct));
        id;
    }

    /// …and a paused engine still lets the position CLOSE (the exit carries no pause on the live
    /// engine), while a new open is refused with OZ's string.
    function test_pausedEngineRefusesOpensButNotCloses() public {
        uint256 id = _openUsdc(100e6);
        engine.setPaused(true);
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 100e6, poolWethUsdc);
        vm.prank(alice);
        vm.expectRevert(bytes("Pausable: paused"));
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        (, uint256 out1,) = _close(id);
        assertEq(out1, 100e6, "the exit does not depend on the engine's pause");
    }

    function test_positionsOfEnumeratesManyIds() public {
        for (uint256 i = 0; i < 25; i++) {
            _openUsdc(10e6);
        }
        assertEq(lpVenue.positionsOf(address(acct)).length, 25, "real users hold 13-25 ids");
    }

    /// The mock's default end-of-list is the shape MEASURED on the live engine (empty, 2026-09-10);
    /// the Panic(0x32) variant a Solidity array read produces is kept, and both enumerate the same
    /// list (slice A, `RISKS.md` §12).
    function test_positionsOfUnderBothTerminalShapes() public {
        uint256 a = _openUsdc(100e6);
        uint256 b = _openUsdc(100e6);
        assertTrue(engine.endShape() == MockSnuggleVault.EndShape.Empty, "default = the measured shape");
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2);
        assertEq(ids[0] + ids[1], a + b);
        engine.setEndShape(MockSnuggleVault.EndShape.Panic32);
        ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 2);
        assertEq(ids[0] + ids[1], a + b);
        assertEq(lpVenue.positionsOf(bob).length, 0);
    }

    function test_closeNeverDependsOnEnumeration() public {
        uint256 id = _openUsdc(100e6);
        engine.setGlitch(address(acct), 0, true); // enumeration is broken…
        (, uint256 out1,) = _close(id); // …but an explicit-id exit still works
        assertEq(out1, 100e6);
    }

    // ---------------------------------------------------------------- close

    function test_closePaysPrincipalWithNoFeeWhenNoYield() public {
        uint256 id = _openUsdc(10_000e6);
        uint256 before = usdc.balanceOf(address(acct));
        (uint256 out0, uint256 out1, uint256 rewards) = _close(id);
        assertEq(out0, 0);
        assertEq(out1, 10_000e6);
        assertEq(rewards, 0);
        assertEq(usdc.balanceOf(address(acct)), before + 10_000e6);
        assertEq(usdc.balanceOf(treasury), 0, "fee never touches principal");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
    }

    function test_closeTakesFeeOnYieldOnly() public {
        uint256 id = _openUsdc(10_000e6);
        engine.setPendingFee(id, address(usdc), 100e6);
        engine.setPendingFee(id, address(weth), 0.1e18);
        engine.setPendingFee(id, address(aero), 10e18);
        engine.setStaked(id, true);
        uint256 u0 = usdc.balanceOf(address(acct));
        uint256 w0 = weth.balanceOf(address(acct));
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.PerformanceFee(address(acct), address(weth), 0.1e18, 0.01e18);
        (uint256 out0, uint256 out1, uint256 rewards) = _close(id);
        assertEq(out0, 0.09e18, "net WETH fees");
        assertEq(out1, 10_000e6 + 90e6, "principal + net USDC fees");
        assertEq(rewards, 9e18, "net AERO");
        assertEq(usdc.balanceOf(treasury), 10e6);
        assertEq(weth.balanceOf(treasury), 0.01e18);
        assertEq(aero.balanceOf(treasury), 1e18);
        assertEq(usdc.balanceOf(address(acct)), u0 + 10_000e6 + 90e6);
        assertEq(weth.balanceOf(address(acct)), w0 + 0.09e18);
        assertEq(aero.balanceOf(address(acct)), 9e18);
        assertEq(usdc.balanceOf(address(lpVenue)) + aero.balanceOf(address(lpVenue)), 0);
    }

    function test_closeUsesHarvestForUnstakedAndSkipsRefusedClaims() public {
        uint256 id = _openUsdc(1_000e6);
        engine.setPendingFee(id, address(usdc), 50e6);
        (, uint256 out1,) = _close(id); // unstaked → harvest path
        assertEq(out1, 1_000e6 + 45e6);
        assertEq(usdc.balanceOf(treasury), 5e6);

        uint256 id2 = _openUsdc(1_000e6);
        engine.setPendingFee(id2, address(usdc), 50e6);
        engine.setClaimRefused(id2, true);
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.ClaimSkipped(address(acct), id2);
        (, uint256 out1b,) = _close(id2);
        assertEq(out1b, 1_000e6, "principal still paid; yield stays in the engine, nothing lost");
        assertEq(usdc.balanceOf(treasury), 5e6, "no fee when nothing was realised");
    }

    function test_closeByNonOwnerReverts() public {
        uint256 id = _openUsdc(1_000e6);
        OilskinAccount other = OilskinAccount(payable(factory.createAccount(bob)));
        bytes memory closeData = abi.encodeCall(ILpVenue.close, (id, _band(poolWethUsdc, 1000)));
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.NotPositionOwner.selector, id, address(acct))
        );
        other.exec(address(lpVenue), 0, closeData);
    }

    function test_closeBubblesEngineRefusal() public {
        uint256 id = _openUsdc(1_000e6);
        engine.setWithdrawRefused(id, true);
        bytes memory closeData = abi.encodeCall(ILpVenue.close, (id, _band(poolWethUsdc, 1000)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockSnuggleVault.WithdrawRefused.selector, id));
        acct.execWithCallback(address(lpVenue), 0, closeData);
    }

    function test_closeManyPaysWhatClosedAndReportsFailures() public {
        uint256 a = _openUsdc(1_000e6);
        uint256 b = _openUsdc(2_000e6);
        uint256 c = _openUsdc(3_000e6);
        engine.setWithdrawRefused(b, true);
        engine.setPendingFee(b, address(usdc), 10e6); // yield of the refused id is still collected
        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (a, b, c, 999); // 999 does not exist
        uint256 before = usdc.balanceOf(address(acct));
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _band(poolWethUsdc, 1000))));
        (uint256 out0, uint256 out1, uint256 rewards, uint256[] memory failed) =
            abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(out0, 0);
        assertEq(out1, 4_000e6 + 9e6);
        assertEq(rewards, 0);
        assertEq(failed.length, 2);
        assertEq(failed[0], b);
        assertEq(failed[1], 999);
        assertEq(usdc.balanceOf(address(acct)), before + 4_000e6 + 9e6);
        assertEq(usdc.balanceOf(treasury), 1e6);
        uint256[] memory left = lpVenue.positionsOf(address(acct));
        assertEq(left.length, 1);
        assertEq(left[0], b, "the refused id is untouched, not lost");
    }

    function test_closeManyEmptyReverts() public {
        uint256[] memory none;
        bytes memory data = abi.encodeCall(ILpVenue.closeMany, (none, _band(poolWethUsdc, 1000)));
        vm.prank(alice);
        vm.expectRevert(SnuggleLpVenue.ZeroAmounts.selector);
        acct.execWithCallback(address(lpVenue), 0, data);
    }

    // ---------------------------------------------------------------- claim

    function test_claimIsTheFeeChokepoint() public {
        uint256 a = _openUsdc(1_000e6);
        uint256 b = _openUsdc(1_000e6);
        engine.setPendingFee(a, address(usdc), 100e6);
        engine.setPendingFee(b, address(aero), 20e18);
        engine.setStaked(b, true);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        bytes memory ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.claim, (ids, _band(poolWethUsdc, 1000), block.timestamp + 60))
        );
        (uint256 f0, uint256 f1, uint256 r, uint256[] memory failed) =
            abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 0);
        assertEq(f0, 0);
        assertEq(f1, 90e6);
        assertEq(r, 18e18);
        assertEq(usdc.balanceOf(treasury), 10e6);
        assertEq(aero.balanceOf(treasury), 2e18);
        assertEq(lpVenue.positionsOf(address(acct)).length, 2, "claim leaves principal in place");
    }

    /// FIX B-HIGH-1. A mixed-pool or foreign id is REPORTED, never a revert that takes the whole
    /// claim with it — at index 0 like anywhere else.
    function test_FIX_B10c_claimReportsMixedPoolsAndForeignIdsInsteadOfReverting() public {
        uint256 a = _openUsdc(1_000e6);
        uint256 z = _open(_openParams(POOL_CBZEC_USDC, 100e6, 0, poolCbzecUsdc));
        engine.setPendingFee(a, address(usdc), 100e6);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, z);
        bytes memory ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.claim, (ids, _band(poolWethUsdc, 1000), block.timestamp + 60))
        );
        (, uint256 f1,, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(f1, 90e6, "the id in the batch's pool was still claimed");
        assertEq(failed.length, 1);
        assertEq(failed[0], z, "the other pool's id is reported, not fatal");

        // A foreign id at index 0 with nothing else owned: everything is reported, nothing reverts.
        uint256[] memory none = _ids(4242);
        ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.claim, (none, _band(poolWethUsdc, 1000), block.timestamp + 60))
        );
        (,,, failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 1);
        assertEq(failed[0], 4242);
    }

    /// FIX B-LOW-1. `claim` carries a deadline now, like every other engine-touching entry point.
    function test_FIX_B8_claimCarriesADeadline() public {
        uint256 a = _openUsdc(1_000e6);
        // Build the calldata BEFORE the cheatcodes: `_band` reads the pool, and an external call
        // between `expectRevert` and the call under test is the call the cheatcode would judge.
        bytes memory data =
            abi.encodeCall(ILpVenue.claim, (_ids(a), _band(poolWethUsdc, 1000), block.timestamp - 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.Expired.selector, block.timestamp - 1));
        acct.execWithCallback(address(lpVenue), 0, data);
    }

    function test_feeIsPathIndependentBetweenClaimAndClose() public {
        uint256 a = _openUsdc(1_000e6);
        uint256 b = _openUsdc(1_000e6);
        engine.setPendingFee(a, address(usdc), 100e6);
        engine.setPendingFee(b, address(usdc), 100e6);
        _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.claim, (_ids(a), _band(poolWethUsdc, 1000), block.timestamp + 60))
        );
        _close(b);
        assertEq(usdc.balanceOf(treasury), 20e6, "same 10 % via either door");
    }

    // ------------------------------------------------------------- increase

    function test_increaseMintsSiblingWithSameParams() public {
        uint256 id = _openUsdc(1_000e6);
        bytes memory ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.increase, (id, 0, 500e6, _band(poolWethUsdc, 1000), block.timestamp + 60))
        );
        uint256 newId = abi.decode(ret, (uint256));
        assertEq(newId, 2);
        (, bytes32 p1,, uint24 w1,,,, bool c1, uint64 d1,,,,,,,,) = engine.positions(id);
        (, bytes32 p2,, uint24 w2,,,, bool c2, uint64 d2,,,,,,,,) = engine.positions(newId);
        assertEq(p1, p2);
        assertEq(w1, w2);
        assertEq(c1, c2);
        assertEq(d1, d2);
        assertEq(lpVenue.positionsOf(address(acct)).length, 2);
    }

    function test_increaseRequiresOwnership() public {
        uint256 id = _openUsdc(1_000e6);
        OilskinAccount other = OilskinAccount(payable(factory.createAccount(bob)));
        usdc.mint(address(other), 1e6);
        bytes memory data =
            abi.encodeCall(ILpVenue.increase, (id, 0, 1e6, _band(poolWethUsdc, 1000), block.timestamp + 60));
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.NotPositionOwner.selector, id, address(acct))
        );
        other.exec(address(lpVenue), 0, data);
    }

    // ------------------------------------------------------------- keeper

    function test_keeperCloseWithinBudget() public {
        uint256 id = _openUsdc(1_000e6);
        engine.setPendingFee(id, address(usdc), 100e6);
        // The only token op in a close is the fee transfer (10 USDC): budget it exactly.
        vm.prank(alice);
        acct.grant(keeper, _perm(address(lpVenue), ILpVenue.close.selector, _limits1(address(usdc), 10e6), 0));
        Call[] memory calls =
            _one(_call(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolWethUsdc, 1000)))));
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(treasury), 10e6);
        assertEq(usdc.balanceOf(keeper), 0, "keeper receives nothing");
    }

    function test_keeperCannotOpenWithoutTokenBudget() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(lpVenue), ILpVenue.open.selector, _limits1(address(usdc), 100e6), 0));
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 101e6, poolWethUsdc);
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_call(address(lpVenue), abi.encodeCall(ILpVenue.open, (p)))));
        p.amount1 = 100e6;
        vm.prank(keeper);
        acct.execAsKeeper(_one(_call(address(lpVenue), abi.encodeCall(ILpVenue.open, (p)))));
        assertEq(lpVenue.positionsOf(address(acct)).length, 1);
    }

    // ------------------------------------------------------------- B20 / cbZEC

    function test_cbzecOpenRebaseCloseReflectsLiveBalances() public {
        uint256 id = _open(_openParams(POOL_CBZEC_USDC, 0, 100e8, poolCbzecUsdc));
        assertEq(cbzec.balanceOf(address(acct)), 900e8);
        cbzec.setMultiplier(1.5e18); // issuer rebases +50 % between our transactions
        assertEq(cbzec.balanceOf(address(acct)), 1350e8, "account balance follows the multiplier");
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        assertApproxEqAbs(out1, 100e8, 1, "engine pays its recorded amount (share rounding)");
        assertApproxEqAbs(cbzec.balanceOf(address(acct)), 1450e8, 1, "no cached balance anywhere");
        assertEq(cbzec.balanceOf(treasury), 0, "a rebase is not yield");
    }

    function test_cbzecDownwardRebaseMakesEnginePayFailClosed() public {
        uint256 id = _open(_openParams(POOL_CBZEC_USDC, 0, 100e8, poolCbzecUsdc));
        cbzec.setMultiplier(0.5e18); // engine now holds 50, owes 100
        uint256[] memory ids = _ids(id);
        bytes memory ret = _ownerExec(
            address(lpVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _band(poolCbzecUsdc, 1000)))
        );
        (,,, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 1, "reported, not silently mispaid");
        assertEq(cbzec.balanceOf(address(acct)), 450e8, "nothing else moved");
    }

    function test_cbzecBlockedAccountFailsClosedWithNoPartialState() public {
        cbzec.setBlocked(address(acct), true);
        LpOpenParams memory p = _openParams(POOL_CBZEC_USDC, 0, 100e8, poolCbzecUsdc);
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        assertEq(cbzec.allowance(address(acct), address(engine)), 0, "no dangling allowance");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        // A USDC-side open into the same pool still works: the block is per token.
        _open(_openParams(POOL_CBZEC_USDC, 100e6, 0, poolCbzecUsdc));
    }

    function test_cbzecPausedTokenBlocksCloseButNotOtherPools() public {
        uint256 z = _open(_openParams(POOL_CBZEC_USDC, 0, 100e8, poolCbzecUsdc));
        uint256 w = _openUsdc(100e6);
        cbzec.setPaused(true);
        bytes memory closeZ = abi.encodeCall(ILpVenue.close, (z, _band(poolCbzecUsdc, 1000)));
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(lpVenue), 0, closeZ);
        (, uint256 out1,) = _close(w);
        assertEq(out1, 100e6);
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_feeNeverExceedsCapAndNeverTouchesPrincipal(uint256 principal, uint256 yield)
        public
    {
        principal = bound(principal, 1e6, 500_000e6);
        yield = bound(yield, 0, 100_000e6);
        uint256 id = _openUsdc(principal);
        if (yield != 0) engine.setPendingFee(id, address(usdc), yield);
        uint256 before = usdc.balanceOf(address(acct));
        (, uint256 out1,) = _close(id);
        uint256 fee = usdc.balanceOf(treasury);
        assertEq(fee, (yield * PERF_BPS) / 10_000);
        assertLe(fee, (yield * lpVenue.MAX_PERFORMANCE_BPS()) / 10_000);
        assertEq(out1, principal + yield - fee);
        assertEq(usdc.balanceOf(address(acct)), before + principal + yield - fee);
        assertGe(usdc.balanceOf(address(acct)), before + principal, "principal intact");
    }

    function testFuzz_widthBounds(uint24 width) public {
        LpOpenParams memory p = _openParams(POOL_WETH_USDC, 0, 1_000e6, poolWethUsdc);
        p.rangeWidthBps = width;
        vm.prank(alice);
        if (width < 150 || width > 5000) {
            vm.expectRevert(abi.encodeWithSelector(SnuggleLpVenue.InvalidWidth.selector, width));
            acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        } else {
            acct.execWithCallback(address(lpVenue), 0, abi.encodeCall(ILpVenue.open, (p)));
        }
    }
}
