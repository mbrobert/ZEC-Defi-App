// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call} from "../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../src/interfaces/ICollateralVenue.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {SnuggleLpVenue} from "../src/venues/SnuggleLpVenue.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {MockB20} from "./mocks/MockB20.sol";

interface ISnuggleVaultWithdraw {
    function withdraw(uint256 tokenId, bool returnNFT) external;
}

/// @notice Spec item 7: every account / venue / router path survives a cbZEC-style rebase
///         mid-flow (between the transactions of a flow) and fails closed — atomically, with no
///         dangling allowance or partial state — on a blocked or paused transfer.
contract B20Test is Fixture {
    uint256 constant COLLATERAL = 1e8; // cbBTC
    uint256 constant BORROW = 20_000e6;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        cbzec.mint(address(engine), 10_000e8);
        usdc.mint(address(engine), 1_000_000e6);
        cbzec.mint(address(acct), 100e8);
    }

    function _openZecPool(uint256 borrow) internal returns (uint256 id) {
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = COLLATERAL;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: 1,
            deadline: block.timestamp + 10 minutes,
            signature: _signPermit(address(cbbtc), COLLATERAL, 1, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow;
        p.poolId = POOL_CBZEC_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolCbzecUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id,) = abi.decode(ret, (uint256, uint256));
    }

    function _unwindAll(uint256 id) internal view returns (StrategyRouter.UnwindParams memory u) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolCbzecUsdc, 1000);
        // A real quote at the mock router's live rate (1 cbZEC = 1,020 USDC), 1 % tolerance.
        u.swap = StrategyRouter.SwapQuote({
            quotedIn: 1e8,
            quotedOut: 1020_000000,
            maxSlippageBps: 100,
            routeData: abi.encode(int24(200))
        });
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = type(uint256).max;
        u.deadline = block.timestamp + 10 minutes;
    }

    // ------------------------------------------------------------ router path

    function test_router_openRebaseUnwindSurvives() public {
        uint256 id = _openZecPool(BORROW);
        engine.setPendingFee(id, address(cbzec), 2e8); // the LP earned 2 cbZEC of fees
        cbzec.setMultiplier(1.25e18); // +25 % rebase between our transactions
        uint256 acctZecBefore = cbzec.balanceOf(address(acct)); // 125 cbZEC
        assertEq(acctZecBefore, 125e8);

        StrategyRouter.UnwindParams memory u = _unwindAll(id);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn,) =
            abi.decode(ret, (uint256, uint256, uint256, uint256));

        // 2 cbZEC fees → 10 % fee → 1.8 cbZEC swapped to USDC at 1,020 (mock rate, amount-based)
        uint256 zecNet = 1.8e8;
        uint256 swapped = aeroRouter.quote(address(cbzec), address(usdc), zecNet);
        assertApproxEqAbs(usdcFromLp, BORROW + swapped, 2000, "USDC principal + swapped net fees");
        assertEq(repaid, BORROW);
        assertEq(withdrawn, COLLATERAL);
        assertApproxEqAbs(cbzec.balanceOf(treasury), 0.2e8, 1, "fee on realised cbZEC only");
        assertApproxEqAbs(cbzec.balanceOf(address(acct)), acctZecBefore, 2, "idle cbZEC untouched by the unwind");
        assertEq(cbzec.balanceOf(address(router)), 0);
        assertEq(cbzec.balanceOf(address(lpVenue)), 0);
        assertEq(cbzec.allowance(address(acct), address(aeroRouter)), 0);
    }

    function test_router_unwindWithBlockedAccountSkipsTheBlockedLegAndReports() public {
        // Two ids: the router's USDC leg and a cbZEC-principal id opened straight at the venue.
        uint256 usdcId = _openZecPool(BORROW);
        LpOpenParams memory p = _openParams(POOL_CBZEC_USDC, 0, 50e8, poolCbzecUsdc);
        uint256 zecId = abi.decode(_ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p))), (uint256));
        engine.setPendingFee(usdcId, address(cbzec), 2e8);
        cbzec.setBlocked(address(acct), true); // issuer blocks the account between our txs

        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (usdcId, zecId);
        StrategyRouter.UnwindParams memory u = _unwindAll(usdcId);
        u.positionIds = ids;
        uint256 zecBefore = cbzec.balanceOf(address(acct));
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn,) =
            abi.decode(ret, (uint256, uint256, uint256, uint256));

        // The USDC leg exits in full; the cbZEC id is reported failed and left exactly as it was;
        // the un-transferable cbZEC yield stays in the engine; nothing partial, nothing dangling.
        assertEq(usdcFromLp, BORROW);
        assertEq(repaid, BORROW);
        assertEq(withdrawn, COLLATERAL);
        assertEq(cbzec.balanceOf(address(acct)), zecBefore, "blocked token did not move");
        assertEq(cbzec.balanceOf(treasury), 0, "no fee on yield that could not be realised");
        uint256[] memory left = lpVenue.positionsOf(address(acct));
        assertEq(left.length, 1);
        assertEq(left[0], zecId, "the blocked id is still the account's");
        assertEq(usdc.allowance(address(acct), address(aave)), 0);
        assertEq(cbzec.allowance(address(acct), address(aeroRouter)), 0);
        // It is the ISSUER holding that id, not us: even a raw exec to the engine cannot move it.
        bytes memory raw = abi.encodeCall(ISnuggleVaultWithdraw.withdraw, (zecId, false));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockB20.Blocked.selector, address(acct)));
        acct.exec(address(engine), 0, raw);
        // (a plain call: the engine is not a peripheral of ours)
        // Once unblocked, the same id closes normally.
        cbzec.setBlocked(address(acct), false);
        ret = _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (zecId, _band(poolCbzecUsdc, 1000))));
        (, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(out1, 50e8);
    }

    function test_router_pausedRewardTokenNeverBlocksTheExit() public {
        uint256 id = _openZecPool(BORROW);
        engine.setPendingFee(id, address(cbzec), 1e8);
        cbzec.setPaused(true); // the issuer pauses cbZEC between our txs
        StrategyRouter.UnwindParams memory u = _unwindAll(id);
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.ClaimSkipped(address(acct), id);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn,) =
            abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(usdcFromLp, BORROW, "USDC principal comes home");
        assertEq(repaid, BORROW);
        assertEq(withdrawn, COLLATERAL);
        assertEq(cbzec.balanceOf(treasury), 0, "no fee on unrealised yield");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
    }

    function test_router_cbzecAsCollateralIsRefused() public {
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbzec);
        p.collateralAmount = 10e8;
        p.borrowAmount = 1_000e6;
        p.poolId = POOL_CBZEC_USDC;
        p.rangeWidthBps = 1500;
        p.band = _band(poolCbzecUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyRouter.AssetDisabled.selector, address(cbzec), "no collateral market on Base yet")
        );
        acct.execWithCallback(address(router), 0, data);
    }

    // ------------------------------------------------------------- venue path

    function test_venue_blockedTreasuryNeverBricksTheUserExit() public {
        LpOpenParams memory p = _openParams(POOL_CBZEC_USDC, 0, 50e8, poolCbzecUsdc);
        uint256 id = abi.decode(_ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p))), (uint256));
        engine.setPendingFee(id, address(cbzec), 1e8);
        cbzec.setBlocked(treasury, true);
        vm.expectEmit(true, true, false, true);
        emit SnuggleLpVenue.FeeSkipped(address(acct), address(cbzec), 0.1e8);
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(out1, 51e8, "principal + the whole yield: the fee was skipped, not the exit");
        assertEq(cbzec.balanceOf(treasury), 0);
    }

    function test_venue_seizedBalanceIsNotOurLoss() public {
        // The issuer seizes (burnBlocked) the ACCOUNT's idle cbZEC: LP ids and other tokens are
        // unaffected and still exit normally.
        LpOpenParams memory p = _openParams(POOL_CBZEC_USDC, 0, 50e8, poolCbzecUsdc);
        uint256 id = abi.decode(_ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p))), (uint256));
        cbzec.setBlocked(address(acct), true);
        cbzec.burnBlocked(address(acct));
        cbzec.setBlocked(address(acct), false);
        assertEq(cbzec.balanceOf(address(acct)), 0);
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(out1, 50e8);
    }

    // ------------------------------------------------------------- swap path

    function test_swap_rebaseBetweenQuoteAndExecutionIsAmountBased() public {
        cbzec.setMultiplier(2e18); // account now shows 200 cbZEC
        bytes memory data = abi.encodeCall(
            ISwapAdapter.swap,
            (address(cbzec), address(usdc), 200e8, 1e8, 1020_000000, uint16(100), block.timestamp + 60, abi.encode(int24(200)))
        );
        bytes memory ret = _ownerExec(address(swapAdapter), data);
        assertEq(abi.decode(ret, (uint256)), aeroRouter.quote(address(cbzec), address(usdc), 200e8));
        assertEq(cbzec.balanceOf(address(acct)), 0);
        assertEq(cbzec.allowance(address(acct), address(aeroRouter)), 0);
    }

    function test_swap_blockedFailsClosedNoAllowanceLeft() public {
        cbzec.setBlocked(address(aeroRouter), true);
        bytes memory data = abi.encodeCall(
            ISwapAdapter.swap,
            (address(cbzec), address(usdc), 10e8, 1e8, 1020_000000, uint16(100), block.timestamp + 60, abi.encode(int24(200)))
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockB20.Blocked.selector, address(aeroRouter)));
        acct.execWithCallback(address(swapAdapter), 0, data);
        assertEq(cbzec.allowance(address(acct), address(aeroRouter)), 0);
        assertEq(cbzec.balanceOf(address(acct)), 100e8);
    }

    // ------------------------------------------------------------ account path

    function test_account_keeperBudgetSurvivesRebase() public {
        vm.prank(alice);
        acct.grant(keeper, _permPlain(address(cbzec), IERC20.transfer.selector, _limits1(address(cbzec), 10e8), 0));
        cbzec.setMultiplier(3e18); // 300 cbZEC now; budget is 10 in amount terms regardless
        Call[] memory calls = _one(_call(address(cbzec), abi.encodeCall(IERC20.transfer, (keeper, 10e8))));
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        calls = _one(_call(address(cbzec), abi.encodeCall(IERC20.transfer, (keeper, 1))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertApproxEqAbs(cbzec.balanceOf(keeper), 10e8, 1);
    }

    function testFuzz_rebaseNeverChangesWhatTheVenuePays(uint256 mult) public {
        mult = bound(mult, 0.9e18, 5e18);
        LpOpenParams memory p = _openParams(POOL_CBZEC_USDC, 0, 50e8, poolCbzecUsdc);
        uint256 id = abi.decode(_ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (p))), (uint256));
        cbzec.setMultiplier(mult);
        uint256 before = cbzec.balanceOf(address(acct));
        bytes memory ret =
            _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        (, uint256 out1,) = abi.decode(ret, (uint256, uint256, uint256));
        // A rebase token rounds amount→shares→amount on every hop; a few 1e-8 units of drift on
        // 50 cbZEC is the token's arithmetic, not ours (1e-6 relative).
        assertApproxEqRel(out1, 50e8, 1e12);
        assertApproxEqRel(cbzec.balanceOf(address(acct)), before + 50e8, 1e12);
        assertEq(cbzec.balanceOf(treasury), 0, "a rebase is never charged as yield");
    }
}
