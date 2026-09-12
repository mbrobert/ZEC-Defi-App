// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {Call, TokenLimit} from "../src/interfaces/IOilskinAccount.sol";
import {ILpVenue, LpOpenParams, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ISlipstreamGauge, ISlipstreamNpm, ISlipstreamPool} from "../src/interfaces/ISlipstream.sol";
import {SlipstreamLpVenue} from "../src/venues/SlipstreamLpVenue.sol";
import {SlipstreamPoolSwapAdapter} from "../src/swap/SlipstreamPoolSwapAdapter.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {MockCLGauge, MockSlipstreamNpm, MockVoter} from "./mocks/MockSlipstream.sol";

/// @notice The direct Slipstream venue (`CBZEC-PATH-2026-09.md` option 1, 2026-09-11) and the
///         pool-direct swap adapter it swaps through, against mocks that carry the verified
///         semantics of the second deployment's NPM, gauge and pool (`ISlipstream.sol`).
contract SlipstreamLpVenueTest is Fixture {
    uint256 constant Q96 = 2 ** 96;
    uint256 constant PIPS = 1_000_000;
    uint256 constant DEPOSIT = 10_000e6; // USDC
    uint256 constant COLLATERAL = 1e8;
    uint256 constant BORROW = 30_000e6;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    // ------------------------------------------------------------- helpers

    function _bandD() internal view returns (PriceBand memory) {
        return _band(poolCbzecUsdc, 1000);
    }

    function _openD(uint256 a0, uint256 a1) internal view returns (LpOpenParams memory p) {
        p = _openParams(POOL_ID_DIRECT, a0, a1, poolCbzecUsdc);
    }

    function _open(uint256 a0, uint256 a1) internal returns (uint256 id) {
        if (a0 != 0) usdc.mint(address(acct), a0);
        if (a1 != 0) cbzec.mint(address(acct), a1);
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openD(a0, a1))));
        id = abi.decode(ret, (uint256));
    }

    /// The mock pool's own output for an exact input at the current price, net of the fee.
    function _mockOut(uint256 amountIn, bool zeroForOne) internal view returns (uint256) {
        uint256 sqrtP = poolCbzecUsdc.sqrtPriceX96();
        uint256 net = Math.mulDiv(amountIn, PIPS - poolCbzecUsdc.fee(), PIPS);
        return zeroForOne
            ? Math.mulDiv(Math.mulDiv(net, sqrtP, Q96), sqrtP, Q96)
            : Math.mulDiv(Math.mulDiv(net, Q96, sqrtP), Q96, sqrtP);
    }

    /// USDC value of a cbZEC amount at the pool's price (raw units).
    function _usdcValue(uint256 cbzecAmt) internal view returns (uint256) {
        uint256 sqrtP = poolCbzecUsdc.sqrtPriceX96();
        return Math.mulDiv(Math.mulDiv(cbzecAmt, Q96, sqrtP), Q96, sqrtP);
    }

    function _routerOpen(uint256 collateral, uint256 borrow_, uint256 nonce)
        internal
        view
        returns (StrategyRouter.OpenParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 10 minutes,
            signature: _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.poolId = POOL_ID_DIRECT;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _bandD();
        p.deadline = block.timestamp + 10 minutes;
    }

    function _unwindD(uint256[] memory ids, uint256 repay, uint256 withdraw)
        internal
        view
        returns (StrategyRouter.UnwindParams memory u)
    {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _bandD();
        // An honest quote from the pool's own price for the cbZEC leg (token1 → USDC).
        u.swap = StrategyRouter.SwapQuote({
            quotedIn: 1e8,
            quotedOut: _mockOut(1e8, false),
            maxSlippageBps: 100,
            routeData: abi.encode(int24(200))
        });
        u.repayAmount = repay;
        u.withdrawAmount = withdraw;
        u.deadline = block.timestamp + 15 minutes;
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    // ================================================================= open

    /// A single-sided USDC deposit is swapped to the centred range's ratio through the pool, minted
    /// two-sided to the account, and staked in the gauge; nothing is left approved.
    function test_openSingleSidedUsdcSwapsToRatioMintsCentredAndStakes() public {
        uint256 id = _open(DEPOSIT, 0);
        assertEq(npmCbzec.ownerOf(id), address(gaugeCbzec), "the NFT is in the gauge");
        assertTrue(gaugeCbzec.stakedContains(address(acct), id), "staked by the account");
        uint256[] memory ids = directVenue.positionsOf(address(acct));
        assertEq(ids.length, 1);
        assertEq(ids[0], id);

        (int24 lower, int24 upper, uint128 liquidity, bool staked) = directVenue.positionRange(id, address(acct));
        assertTrue(staked);
        assertGt(liquidity, 0);
        int24 tick = poolCbzecUsdc.tick();
        assertLt(lower, tick, "the range starts below the price");
        assertGt(upper, tick, "and ends above it");
        assertEq(lower % 200, 0);
        assertEq(upper % 200, 0);
        assertGe(upper - lower, 1500, "at least the width asked");
        assertLe(upper - lower, 1500 + 400, "rounded out by at most two spacings");

        // Two-sided: the pool took both tokens in roughly equal value (the mock swaps at the price
        // with no impact, so the leftovers are rounding).
        uint256 poolUsdc = usdc.balanceOf(address(poolCbzecUsdc)) - 5_000_000e6;
        uint256 poolCbzec = 5_000e8 - cbzec.balanceOf(address(poolCbzecUsdc));
        // pool: +DEPOSIT in, −x out (swap), +used1 in (mint) … net cbZEC leaves only through the swap.
        assertGt(poolUsdc, 0);
        assertLt(usdc.balanceOf(address(acct)), DEPOSIT / 100, "less than 1 % of the deposit left idle");
        assertLt(_usdcValue(cbzec.balanceOf(address(acct))), DEPOSIT / 100, "and less than 1 % of it in cbZEC");
        assertEq(usdc.allowance(address(acct), address(npmCbzec)), 0, "no allowance survives");
        assertEq(cbzec.allowance(address(acct), address(npmCbzec)), 0);
        assertEq(poolCbzec, poolCbzec, "silence the unused warning");
        assertEq(usdc.balanceOf(address(directVenue)), 0, "the venue holds nothing");
        assertEq(cbzec.balanceOf(address(directVenue)), 0);
        assertEq(usdc.balanceOf(address(poolSwapAdapter)), 0, "the adapter holds nothing");
    }

    /// The mirror: a single-sided cbZEC deposit sells part of it for USDC first.
    function test_openSingleSidedCbzecSwapsTheOtherWay() public {
        uint256 id = _open(0, 5e8);
        assertTrue(gaugeCbzec.stakedContains(address(acct), id));
        assertLt(cbzec.balanceOf(address(acct)), 5e8 / 100, "less than 1 % of the deposit left idle");
        assertLt(usdc.balanceOf(address(acct)), _usdcValue(5e8) / 100);
        (,, uint128 liquidity,) = directVenue.positionRange(id, address(acct));
        assertGt(liquidity, 0);
    }

    /// Both amounts given: no swap, the pool takes what the range wants and the rest stays.
    function test_openDualSidedMintsWithoutASwap() public {
        usdc.mint(address(acct), DEPOSIT);
        cbzec.mint(address(acct), 5e8);
        vm.recordLogs();
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openD(DEPOSIT, 5e8))));
        uint256 id = abi.decode(ret, (uint256));
        assertTrue(gaugeCbzec.stakedContains(address(acct), id));
        // No SwappedToRatio event.
        bytes32 sig = keccak256("SwappedToRatio(address,address,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != sig, "no swap on a dual deposit");
        }
        // cbZEC was the long side (5 cbZEC ≈ 5,100 USDC vs 10,000 USDC): the pool used all the USDC
        // it could pair, so the cbZEC leftover is what remains in the account.
        assertGt(usdc.balanceOf(address(acct)) + cbzec.balanceOf(address(acct)), 0, "the unpaired side stays in the account");
    }

    function test_openRefusals() public {
        usdc.mint(address(acct), DEPOSIT);
        LpOpenParams memory p = _openD(DEPOSIT, 0);
        p.rangeWidthBps = 149;
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.InvalidWidth.selector, uint24(149)));
        p = _openD(DEPOSIT, 0);
        p.rangeWidthBps = 5001;
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.InvalidWidth.selector, uint24(5001)));
        p = _openD(DEPOSIT, 0);
        p.rebalanceDelay = 31 days;
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.InvalidDelay.selector, uint64(31 days)));
        p = _openD(DEPOSIT, 0);
        p.deadline = block.timestamp - 1;
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.Expired.selector, block.timestamp - 1));
        p = _openD(0, 0);
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.ZeroAmounts.selector));
        p = _openD(DEPOSIT, 0);
        p.poolId = POOL_CBZEC_USDC; // the ENGINE's id for the same pool is not this venue's
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.PoolInactive.selector, POOL_CBZEC_USDC));
        p = _openD(DEPOSIT, 0);
        p.band = PriceBand({minSqrtPriceX96: 0, maxSqrtPriceX96: 1});
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.BandRequired.selector));
        p = _openD(DEPOSIT, 0);
        p.band = PriceBand({minSqrtPriceX96: 1, maxSqrtPriceX96: type(uint160).max});
        _expectRevertOpen(
            p, abi.encodeWithSelector(SlipstreamLpVenue.BandTooWide.selector, uint160(1), type(uint160).max, uint256(2500))
        );
        p = _openD(DEPOSIT, 0);
        uint160 sp = poolCbzecUsdc.sqrtPriceX96();
        p.band = PriceBand({minSqrtPriceX96: sp + 1, maxSqrtPriceX96: uint160(uint256(sp) * 11 / 10)});
        _expectRevertOpen(
            p, abi.encodeWithSelector(SlipstreamLpVenue.PriceOutOfBand.selector, uint256(sp), sp + 1, uint160(uint256(sp) * 11 / 10))
        );
        p = _openD(DEPOSIT, 0);
        poolCbzecUsdc.setMode(MockCLPool.Mode.Revert);
        _expectRevertOpen(p, abi.encodeWithSelector(SlipstreamLpVenue.PriceUnreadable.selector, address(poolCbzecUsdc)));
        poolCbzecUsdc.setMode(MockCLPool.Mode.Normal);
        assertEq(usdc.balanceOf(address(acct)), DEPOSIT, "nothing moved");
    }

    function _expectRevertOpen(LpOpenParams memory p, bytes memory err) internal {
        bytes memory data = abi.encodeCall(ILpVenue.open, (p));
        vm.prank(alice);
        vm.expectRevert(err);
        acct.execWithCallback(address(directVenue), 0, data);
    }

    /// A gauge the Voter has killed refuses `deposit` ("GK"): the position is held UNSTAKED in the
    /// account, said so, enumerated, and still closes.
    function test_openWhenTheGaugeIsNotAliveHoldsThePositionUnstaked() public {
        voter.setAlive(address(gaugeCbzec), false);
        uint256 id = _open(DEPOSIT, 0);
        assertEq(npmCbzec.ownerOf(id), address(acct), "the NFT stays in the account");
        assertFalse(gaugeCbzec.stakedContains(address(acct), id));
        uint256[] memory ids = directVenue.positionsOf(address(acct));
        assertEq(ids.length, 1, "enumerated from the NPM's own list");
        assertEq(ids[0], id);
        (bytes32 pid, bool owned) = directVenue.ownedPool(id, address(acct));
        assertTrue(owned);
        assertEq(pid, POOL_ID_DIRECT);

        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _bandD())));
        (uint256 out0, uint256 out1, uint256 rewards) = abi.decode(ret, (uint256, uint256, uint256));
        assertGt(out0, 0);
        assertGt(out1, 0);
        assertEq(rewards, 0);
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
        vm.expectRevert();
        npmCbzec.ownerOf(id); // burnt
    }

    /// A gauge that reverts for any reason on `deposit` is best effort too.
    function test_openWhenTheGaugeRefusesIsBestEffort() public {
        gaugeCbzec.setRefuse(true);
        uint256 id = _open(DEPOSIT, 0);
        assertEq(npmCbzec.ownerOf(id), address(acct));
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
    }

    // ================================================================ close

    /// Close a staked id: the gauge pays the AERO (fee on it, once), the NFT comes back, principal
    /// is decreased, collected and burnt untaxed.
    function test_closeStakedPaysRewardsNetOfFeeAndPrincipalUntaxed() public {
        uint256 id = _open(DEPOSIT, 0);
        uint256 idleUsdc = usdc.balanceOf(address(acct));
        uint256 idleCbzec = cbzec.balanceOf(address(acct));
        gaugeCbzec.setPending(id, 100e18);

        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _bandD())));
        (uint256 out0, uint256 out1, uint256 rewards) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(rewards, 90e18, "AERO net of the 10 % fee");
        assertEq(aero.balanceOf(treasury), 10e18, "the fee, once");
        assertEq(aero.balanceOf(address(acct)), 90e18);
        assertEq(usdc.balanceOf(treasury), 0, "principal is never taxed");
        assertEq(cbzec.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(acct)), idleUsdc + out0);
        assertEq(cbzec.balanceOf(address(acct)), idleCbzec + out1);
        // Everything that went in came back (the mock swaps and mints at one price; rounding aside).
        assertApproxEqRel(usdc.balanceOf(address(acct)) + _usdcValue(cbzec.balanceOf(address(acct))), DEPOSIT, 0.01e18);
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
        assertFalse(gaugeCbzec.stakedContains(address(acct), id));
        vm.expectRevert();
        npmCbzec.ownerOf(id);
    }

    /// Close an unstaked id: trading fees accrued on the NPM are yield (taxed), principal is not.
    function test_closeUnstakedTakesTheFeeOnAccruedTradingFeesOnly() public {
        voter.setAlive(address(gaugeCbzec), false);
        uint256 id = _open(DEPOSIT, 0);
        npmCbzec.accrueFees(id, 50e6, 0);
        uint256 idleUsdc = usdc.balanceOf(address(acct));
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _bandD())));
        (uint256 out0,,) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(usdc.balanceOf(treasury), 5e6, "10 % of the 50 USDC of fees");
        assertEq(usdc.balanceOf(address(acct)), idleUsdc + out0);
        assertGe(out0, 45e6, "the net fees are in out0 with the principal");
    }

    /// `closeMany` reports a foreign id at index 0, and ids the gauge refuses to release, without
    /// reverting; the refused ids stay staked and are the user's.
    function test_closeManyReportsForeignAndRefusedIds() public {
        uint256 a = _open(DEPOSIT, 0);
        uint256 b = _open(DEPOSIT, 0);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 999_999; // never minted
        ids[1] = a;
        ids[2] = b;
        gaugeCbzec.setRefuse(true);
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _bandD())));
        (uint256 out0, uint256 out1,, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 3, "foreign + two refused");
        assertEq(failed[0], 999_999);
        assertEq(out0 + out1, 0);
        assertTrue(gaugeCbzec.stakedContains(address(acct), a), "still staked, still the user's");
        gaugeCbzec.setRefuse(false);
        ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.closeMany, (ids, _bandD())));
        (out0, out1,, failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(failed.length, 1, "only the foreign id");
        assertGt(out0, 0);
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
    }

    /// Another account's position is not this account's: refused by name on `close`, reported on
    /// `closeMany` and `claim`.
    function test_closeRefusesAnotherAccountsPosition() public {
        uint256 id = _open(DEPOSIT, 0);
        OilskinAccount other = OilskinAccount(payable(factory.createAccount(bob)));
        bytes memory data = abi.encodeCall(ILpVenue.close, (id, _bandD()));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.NotPositionOwner.selector, id, address(gaugeCbzec)));
        other.execWithCallback(address(directVenue), 0, data);
        (, bool owned) = directVenue.ownedPool(id, address(other));
        assertFalse(owned);
    }

    // ================================================================ claim

    function test_claimPaysStakedRewardsAndUnstakedFeesNetOfTheFee() public {
        uint256 a = _open(DEPOSIT, 0);
        gaugeCbzec.setPending(a, 40e18);
        voter.setAlive(address(gaugeCbzec), false);
        uint256 b = _open(DEPOSIT, 0); // unstaked
        npmCbzec.accrueFees(b, 20e6, 0);
        uint256[] memory ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = 424_242;
        bytes memory ret =
            _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.claim, (ids, _bandD(), block.timestamp + 1)));
        (uint256 f0,, uint256 rewards, uint256[] memory failed) = abi.decode(ret, (uint256, uint256, uint256, uint256[]));
        assertEq(rewards, 36e18);
        assertEq(aero.balanceOf(treasury), 4e18);
        assertEq(f0, 18e6);
        assertEq(usdc.balanceOf(treasury), 2e6);
        assertEq(failed.length, 1);
        assertEq(failed[0], 424_242);
        assertTrue(gaugeCbzec.stakedContains(address(acct), a), "a claim does not unstake");
        assertEq(directVenue.positionsOf(address(acct)).length, 2);
    }

    // ============================================================= increase

    function test_increaseMintsANewIdWithTheSameRange() public {
        uint256 id = _open(DEPOSIT, 0);
        (int24 lower, int24 upper,,) = directVenue.positionRange(id, address(acct));
        usdc.mint(address(acct), 1_000e6);
        bytes memory ret = _ownerExec(
            address(directVenue), abi.encodeCall(ILpVenue.increase, (id, 1_000e6, 0, _bandD(), block.timestamp + 1))
        );
        uint256 newId = abi.decode(ret, (uint256));
        assertTrue(newId != id);
        (int24 l2, int24 u2,, bool staked) = directVenue.positionRange(newId, address(acct));
        assertEq(l2, lower);
        assertEq(u2, upper);
        assertTrue(staked);
        assertEq(directVenue.positionsOf(address(acct)).length, 2);
    }

    // ================================================================ views

    function test_positionsOfFailsClosedWhenTheGaugeOrTheNpmCannotBeRead() public {
        _open(DEPOSIT, 0);
        vm.mockCallRevert(address(gaugeCbzec), abi.encodeWithSelector(ISlipstreamGauge.stakedValues.selector), "boom");
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PositionsUnreadable.selector, bytes("boom")));
        directVenue.positionsOf(address(acct));
        vm.clearMockedCalls();
        vm.mockCallRevert(address(npmCbzec), abi.encodeWithSelector(ISlipstreamNpm.balanceOf.selector), "npm down");
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PositionsUnreadable.selector, bytes("npm down")));
        directVenue.positionsOf(address(acct));
        vm.clearMockedCalls();
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
    }

    function test_poolViews() public {
        (address t0, address t1, address pool) = directVenue.poolTokens(POOL_ID_DIRECT);
        assertEq(t0, address(usdc));
        assertEq(t1, address(cbzec));
        assertEq(pool, address(poolCbzecUsdc));
        (t0, t1, pool) = directVenue.poolTokens(POOL_CBZEC_USDC);
        assertEq(pool, address(0), "the engine's id is not this venue's");
        assertEq(directVenue.poolSqrtPriceX96(POOL_ID_DIRECT), poolCbzecUsdc.sqrtPriceX96());
        uint256 id = _open(DEPOSIT, 0);
        (bytes32 pid, address owner) = directVenue.poolOf(id);
        assertEq(pid, POOL_ID_DIRECT);
        assertEq(owner, address(gaugeCbzec), "poolOf reports the NPM owner: the gauge for a staked id");
        (pid, owner) = directVenue.poolOf(777_777);
        assertEq(pid, bytes32(0));
        assertEq(owner, address(0));
    }

    /// The range always contains the price, on the spacing grid, and within two spacings of the width.
    function testFuzz_centredRangeContainsThePrice(int24 tick, uint24 width) public {
        // Prices within a factor of ~7 of the fixture's (tick −23,228): the mock pool's custody
        // fills the to-ratio swap there; the geometry under test does not depend on the price.
        tick = int24(bound(int256(tick), -43_000, -4_000));
        width = uint24(bound(uint256(width), 150, 5000));
        poolCbzecUsdc.setTick(tick);
        poolCbzecUsdc.setSqrtPrice(TickMath.getSqrtRatioAtTick(tick));
        usdc.mint(address(acct), DEPOSIT);
        LpOpenParams memory p = _openD(DEPOSIT, 0);
        p.rangeWidthBps = width;
        bytes memory ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (p)));
        uint256 id = abi.decode(ret, (uint256));
        (int24 lower, int24 upper,,) = directVenue.positionRange(id, address(acct));
        assertLt(lower, tick);
        assertGt(upper, tick);
        assertEq(lower % 200, 0);
        assertEq(upper % 200, 0);
        assertGe(upper - lower, int24(width));
        assertLe(upper - lower, int24(width) + 400);
    }

    // ========================================================== constructor

    function test_constructorCrossChecksTheFourContracts() public {
        MockCLPool otherPool = new MockCLPool(address(usdc), address(cbzec), 200, 2000, poolCbzecUsdc.sqrtPriceX96());
        MockSlipstreamNpm otherNpm = new MockSlipstreamNpm(otherPool, address(0xF));
        MockCLGauge otherGauge = new MockCLGauge(otherPool, otherNpm, address(aero), voter);
        otherPool.setGaugeAndNft(address(otherGauge), address(otherNpm), address(0xF));
        ISwapAdapter ad = ISwapAdapter(address(poolSwapAdapter));
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PoolMismatch.selector, "pool.nft"));
        new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(otherNpm)), ISlipstreamGauge(address(gaugeCbzec)), ad, address(aero), treasury, 1000);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PoolMismatch.selector, "pool.gauge"));
        new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(npmCbzec)), ISlipstreamGauge(address(otherGauge)), ad, address(aero), treasury, 1000);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PoolMismatch.selector, "gauge.rewardToken"));
        new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(npmCbzec)), ISlipstreamGauge(address(gaugeCbzec)), ad, address(weth), treasury, 1000);
        // An adapter bound to another pool is refused: the to-ratio swap would go elsewhere.
        SlipstreamPoolSwapAdapter otherAdapter = new SlipstreamPoolSwapAdapter(ISlipstreamPool(address(otherPool)));
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.PoolMismatch.selector, "swap.POOL"));
        new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(npmCbzec)), ISlipstreamGauge(address(gaugeCbzec)), ISwapAdapter(address(otherAdapter)), address(aero), treasury, 1000);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamLpVenue.FeeAboveCap.selector, 2001, 2000));
        new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(npmCbzec)), ISlipstreamGauge(address(gaugeCbzec)), ad, address(aero), treasury, 2001);
        // The real wiring passes.
        SlipstreamLpVenue ok = new SlipstreamLpVenue(ISlipstreamPool(address(poolCbzecUsdc)), ISlipstreamNpm(address(npmCbzec)), ISlipstreamGauge(address(gaugeCbzec)), ad, address(aero), treasury, 1000);
        assertEq(ok.POOL_ID(), POOL_ID_DIRECT);
        assertEq(address(ok.VOTER()), address(voter));
    }

    // ====================================================== the pool adapter

    function _adapterSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 quotedOut, uint16 bps, bytes memory route)
        internal
        returns (bytes memory)
    {
        return _ownerExec(
            address(poolSwapAdapter),
            abi.encodeCall(ISwapAdapter.swap, (tokenIn, tokenOut, amountIn, amountIn, quotedOut, bps, block.timestamp + 1, route))
        );
    }

    function test_adapterSwapsThroughThePoolWithTheCallbackPayingExactlyWhatIsOwed() public {
        usdc.mint(address(acct), 1_000e6);
        uint256 poolUsdcBefore = usdc.balanceOf(address(poolCbzecUsdc));
        bytes memory ret = _adapterSwap(address(usdc), address(cbzec), 1_000e6, _mockOut(1_000e6, true), 100, abi.encode(int24(200)));
        uint256 out = abi.decode(ret, (uint256));
        assertEq(out, _mockOut(1_000e6, true));
        assertEq(cbzec.balanceOf(address(acct)), out, "the output landed in the account");
        assertEq(usdc.balanceOf(address(acct)), 0, "exactly the input left it");
        assertEq(usdc.balanceOf(address(poolCbzecUsdc)), poolUsdcBefore + 1_000e6, "and reached the pool");
        assertEq(usdc.balanceOf(address(poolSwapAdapter)), 0);
        assertEq(usdc.allowance(address(acct), address(poolCbzecUsdc)), 0, "no allowance was ever granted");
    }

    /// The floor is checked against what the account RECEIVED, so a pool paying less than it reports
    /// is caught; a partial fill is refused by name, never half-done.
    function test_adapterMeasuresTheOutputAndRefusesPartialFills() public {
        usdc.mint(address(acct), 1_000e6);
        uint256 quoted = _mockOut(1_000e6, true);
        poolCbzecUsdc.setShortPayBps(200); // pays 2 % less than it says
        bytes memory data = abi.encodeCall(
            ISwapAdapter.swap, (address(usdc), address(cbzec), 1_000e6, 1_000e6, quoted, 100, block.timestamp + 1, abi.encode(int24(200)))
        );
        uint256 paid = quoted - quoted * 200 / 10_000;
        uint256 floor = poolSwapAdapter.minOutFor(1_000e6, 1_000e6, quoted, 100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.InsufficientOutput.selector, paid, floor));
        acct.execWithCallback(address(poolSwapAdapter), 0, data);
        poolCbzecUsdc.setShortPayBps(0);
        poolCbzecUsdc.setFillBps(5_000); // liquidity runs out half way
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.PartialFill.selector, 1_000e6, 500e6));
        acct.execWithCallback(address(poolSwapAdapter), 0, data);
        assertEq(usdc.balanceOf(address(acct)), 1_000e6, "atomic: nothing moved");
    }

    function test_adapterRefusesTheWrongPairRouteAndTolerance() public {
        usdc.mint(address(acct), 1_000e6);
        weth.mint(address(acct), 1e18);
        bytes memory data = abi.encodeCall(
            ISwapAdapter.swap, (address(weth), address(usdc), 1e18, 1e18, 2000e6, 100, block.timestamp + 1, abi.encode(int24(200)))
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.NotPoolPair.selector, address(weth), address(usdc)));
        acct.execWithCallback(address(poolSwapAdapter), 0, data);
        data = abi.encodeCall(
            ISwapAdapter.swap, (address(usdc), address(cbzec), 1_000e6, 1_000e6, _mockOut(1_000e6, true), 100, block.timestamp + 1, abi.encode(int24(100)))
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.WrongRoute.selector, int24(100), int24(200)));
        acct.execWithCallback(address(poolSwapAdapter), 0, data);
        data = abi.encodeCall(
            ISwapAdapter.swap, (address(usdc), address(cbzec), 1_000e6, 1_000e6, _mockOut(1_000e6, true), 501, block.timestamp + 1, abi.encode(int24(200)))
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.SlippageTooHigh.selector, uint16(501), uint16(500)));
        acct.execWithCallback(address(poolSwapAdapter), 0, data);
    }

    /// The callback is the only door: nobody but the bound pool, and only while a swap is in flight.
    function test_adapterCallbackRefusesStrangersAndCallsOutOfFlight() public {
        vm.expectRevert(abi.encodeWithSelector(SlipstreamPoolSwapAdapter.NotPool.selector, address(this)));
        poolSwapAdapter.uniswapV3SwapCallback(1, 0, "");
        vm.prank(address(poolCbzecUsdc));
        vm.expectRevert(SlipstreamPoolSwapAdapter.NoSwapInFlight.selector);
        poolSwapAdapter.uniswapV3SwapCallback(1, 0, "");
    }

    /// The venue's to-ratio swap keeps the caller's band as its floor, capped at the adapter's 5 %:
    /// a pool paying 6 % short is refused, one paying 3 % short passes a ±10 % band.
    function test_venueToRatioSwapFloorIsTheBandCappedAtTheAdapterCeiling() public {
        usdc.mint(address(acct), DEPOSIT);
        poolCbzecUsdc.setShortPayBps(600);
        bytes memory data = abi.encodeCall(ILpVenue.open, (_openD(DEPOSIT, 0)));
        vm.prank(alice);
        vm.expectRevert(); // InsufficientOutput from the adapter, bubbled unchanged
        acct.execWithCallback(address(directVenue), 0, data);
        assertEq(usdc.balanceOf(address(acct)), DEPOSIT);
        poolCbzecUsdc.setShortPayBps(300);
        _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openD(DEPOSIT, 0))));
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
    }

    // ================================================================ router

    function test_routerOpensALeveragedLpOnTheDirectPoolAndUnwindsIt() public {
        StrategyRouter.OpenParams memory p = _routerOpen(COLLATERAL, BORROW, 1);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (uint256 id, uint256 hf) = abi.decode(ret, (uint256, uint256));
        assertGt(hf, 1.55e18);
        assertTrue(gaugeCbzec.stakedContains(address(acct), id), "opened on the direct venue, staked");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0, "nothing on the engine venue");
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW);
        assertLt(usdc.balanceOf(address(acct)), BORROW / 100, "the borrowed USDC went into the position");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(cbzec.balanceOf(address(router)), 0);

        gaugeCbzec.setPending(id, 10e18);
        // Two pool fees (0.2 % on the way in, 0.2 % on the way out) are what the round trip costs;
        // a Close that withdraws everything must cover them, as the dashboard asks the user to.
        usdc.mint(address(acct), 200e6);
        StrategyRouter.UnwindParams memory u = _unwindD(_ids(id), type(uint256).max, type(uint256).max);
        ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertGt(usdcFromLp, 0);
        assertApproxEqRel(usdcFromLp, BORROW, 0.02e18, "the position came back as USDC (the cbZEC leg swapped through the pool)");
        assertLt(cbzec.balanceOf(address(acct)), 100, "the cbZEC leg was swapped to USDC; only the open's rounding dust (RefundLeft) stays");
        assertEq(withdrawn, COLLATERAL);
        assertEq(repaid, BORROW, "the whole debt was repaid");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(aero.balanceOf(address(acct)), 9e18, "rewards net of fee");
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(cbzec.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(poolSwapAdapter)), 0);
    }

    function test_routerRefusesAPoolNeitherVenueServes() public {
        StrategyRouter.OpenParams memory p = _routerOpen(COLLATERAL, BORROW, 1);
        p.poolId = keccak256("nope");
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.UnknownPool.selector, keccak256("nope")));
        acct.execWithCallback(address(router), 0, data);
    }

    /// The keeper's protective unwind on a direct position stays inside the grant: the callback's
    /// cbZEC transfer to the pool and the AERO fee are charged to their budgets, and a grant that
    /// does not budget cbZEC is refused by name — the swap cannot pay the pool for free.
    function test_keeperUnwindOnTheDirectPoolIsBudgeted() public {
        StrategyRouter.OpenParams memory p = _routerOpen(COLLATERAL, BORROW, 1);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (uint256 id,) = abi.decode(ret, (uint256, uint256));
        gaugeCbzec.setPending(id, 10e18);

        TokenLimit[] memory limits = new TokenLimit[](2);
        limits[0] = TokenLimit(address(usdc), 100_000e6);
        limits[1] = TokenLimit(address(aero), 100e18);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, limits, 0));
        StrategyRouter.UnwindParams memory u = _unwindD(_ids(id), type(uint256).max, 0);
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u))));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(OilskinAccount.TokenNotBudgeted.selector, address(cbzec)));
        acct.execAsKeeper(calls);

        limits = new TokenLimit[](3);
        limits[0] = TokenLimit(address(usdc), 100_000e6);
        limits[1] = TokenLimit(address(aero), 100e18);
        limits[2] = TokenLimit(address(cbzec), 100e8);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, limits, 0));
        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(calls);
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(res[0], (uint256, uint256, uint256, uint256));
        assertGt(repaid, 0);
        assertEq(withdrawn, 0, "a keeper unwind withdraws nothing");
        (, uint256 spentCbzec) = acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(cbzec));
        assertGt(spentCbzec, 0, "the callback's payment to the pool was charged");
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
    }
}
