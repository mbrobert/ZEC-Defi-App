// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {Call, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice Audit wave 2, G-HIGH-1 (`docs/AUDIT-2026-09-07.md`). The web sized every pool-token
///         budget line with the COLLATERAL's number — 2 × debt ÷ collateral price, in the
///         collateral's decimals — and reused it for the pool's other token. A cbBTC user in the
///         WETH/USDC pool therefore signed a WETH budget of ≈ 7.5 × 10⁻¹¹ WETH; the router's swap
///         approve for the WETH leg then failed `TokenBudgetExceeded` on every rung while the panel
///         said "active". A re-grant from the dashboard carried no pool-token line at all.
///
///         The contracts were never wrong — the budget is enforced exactly as signed — so this
///         suite pins the SHAPE the web now produces (each token in its own units at 2 × debt) and
///         shows, with the same numbers, that the old shape was refused. The test that fails on the
///         old web code is `web/test/execute.test.ts` ("G-HIGH-1: a pool token is sized in ITS OWN
///         decimals and price").
contract GrantShapeRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;
    uint256 constant BORROW = 30_000e6;
    /// The WETH leg the LP pays out on close (half of a $30k position at $2,453.45 is 6.11 WETH;
    /// the mock engine pays what it is told, so this is a pending fee of 0.5 WETH for clarity).
    uint256 constant WETH_LEG = 0.5e18;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        weth.mint(address(engine), 100e18); // the engine must hold the WETH it pays out as fees
    }

    function _openLp() internal returns (uint256 id) {
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = ONE_CBBTC;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: 1,
            deadline: block.timestamp + 10 minutes,
            signature: _signPermit(address(cbbtc), ONE_CBBTC, 1, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = BORROW;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id,) = abi.decode(ret, (uint256, uint256));
        engine.setPendingFee(id, address(weth), WETH_LEG);
    }

    /// `web/lib/execute.ts` `grantTokenLimits`: 2 × debt ÷ price, in the token's OWN decimals.
    function _line(uint256 debtUsdc6, uint256 priceE8, uint8 decimals) internal pure returns (uint256) {
        // ceil(2 × debt / price × 10^dec) with debt in 6 dp and price in 8 dp.
        uint256 num = 2 * debtUsdc6 * 1e8 * (10 ** decimals);
        uint256 den = priceE8 * 1e6;
        return (num + den - 1) / den;
    }

    function _webShapedGrant(uint256 wethLine) internal view returns (TokenLimit[] memory l) {
        l = new TokenLimit[](4);
        l[0] = TokenLimit(address(usdc), 2 * BORROW);
        l[1] = TokenLimit(address(cbbtc), _line(BORROW, PRICE_CBBTC_E8, 8));
        l[2] = TokenLimit(address(aero), 1e23);
        l[3] = TokenLimit(address(weth), wethLine);
    }

    function _keeperUnwind(uint256 id) internal view returns (StrategyRouter.UnwindParams memory u) {
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](1);
        u.positionIds[0] = id;
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 1e18, quotedOut: 2453_450000, maxSlippageBps: 100, routeData: abi.encode(int24(100))});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 15 minutes;
    }

    /// The fixed shape: the WETH line is 2 × 30,000 / 2,453.45 WETH in wei (≈ 24.46 WETH) and the
    /// keeper's unwind — close, swap the WETH leg, repay — goes through inside it.
    function test_FIX_G1_webShapedGrantCoversTheWethLegOfACbbtcUser() public {
        uint256 id = _openLp();
        uint256 wethLine = _line(BORROW, PRICE_WETH_E8, 18);
        assertGt(wethLine, 24e18);
        assertLt(wethLine, 25e18);
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (_keeperUnwind(id)))));
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, _webShapedGrant(wethLine), 0));

        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(calls);
        (uint256 usdcFromLp, uint256 repaid,,) = abi.decode(res[0], (uint256, uint256, uint256, uint256));
        assertGt(usdcFromLp, BORROW, "the WETH leg was swapped to USDC on top of the LP's USDC");
        assertEq(repaid, BORROW, "and the whole debt was repaid");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        (, uint256 spentWeth) = acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(weth));
        assertEq(spentWeth, WETH_LEG, "fee transfer (0.05) + swap approve (0.45) = the whole leg, charged to the WETH line");
    }

    /// The OLD shape with the same numbers: the WETH line is the cbBTC line (0.754 cbBTC → 75,382,800
    /// base units, i.e. 7.5e-11 WETH). The swap approve is refused and nothing is protected.
    function test_FIX_G1b_theOldShapeWasRefusedOnTheSwapApprove() public {
        uint256 id = _openLp();
        uint256 cbbtcLine = _line(BORROW, PRICE_CBBTC_E8, 8);
        assertEq(cbbtcLine, 75_382_785, "0.75382785 cbBTC in 8 dp: ceil(2 x 30,000 / 79,593.77 x 1e8)");
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, _webShapedGrant(cbbtcLine), 0));

        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (_keeperUnwind(id)));
        Call[] memory calls = _one(_callP(address(router), data));
        vm.prank(keeper);
        vm.expectPartialRevert(OilskinAccount.TokenBudgetExceeded.selector);
        acct.execAsKeeper(calls);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW, "nothing was protected");
    }

    /// The dashboard re-grant used to pass NO pool tokens at all: no WETH line → TokenNotBudgeted.
    function test_FIX_G1c_aGrantWithoutThePoolTokenIsRefusedByName() public {
        uint256 id = _openLp();
        TokenLimit[] memory l = new TokenLimit[](3);
        l[0] = TokenLimit(address(usdc), 2 * BORROW);
        l[1] = TokenLimit(address(cbbtc), _line(BORROW, PRICE_CBBTC_E8, 8));
        l[2] = TokenLimit(address(aero), 1e23);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, l, 0));

        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (_keeperUnwind(id)));
        Call[] memory calls = _one(_callP(address(router), data));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(OilskinAccount.TokenNotBudgeted.selector, address(weth)));
        acct.execAsKeeper(calls);
    }
}
