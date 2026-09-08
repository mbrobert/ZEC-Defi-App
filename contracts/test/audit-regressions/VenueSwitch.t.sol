// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {Call} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice Audit wave 2, M-HIGH-1 (`docs/AUDIT-2026-09-07.md`): a registry venue switch used to
///         strand every open position on the previous venue. `StrategyRouter.unwind` resolved the
///         venue from the registry's CURRENT pointer, found no debt there, repaid nothing and
///         SUCCEEDED — the keeper reported CONFIRMED while the Aave debt rode to liquidation, and
///         the owner's Close reverted `NothingToWithdraw` inside the new venue.
///
///         Fixed: the exit path follows the POSITION. `CollateralRegistry.previousVenues(asset)`
///         remembers every venue an asset has been accepted at, and `unwind` picks the first venue
///         (current, then previous) where the calling account has debt or collateral. Opens still
///         go to the current venue only.
contract VenueSwitchRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;
    uint256 constant BORROW = 30_000e6;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    // ------------------------------------------------------------- helpers

    function _borrowOnly(uint256 collateral, uint256 borrow_, uint256 nonce)
        internal
        view
        returns (StrategyRouter.BorrowOnlyParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 20 minutes,
            signature: _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.deadline = block.timestamp + 15 minutes;
    }

    function _openLp(uint256 collateral, uint256 borrow_, uint256 nonce) internal returns (uint256 id) {
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 10 minutes,
            signature: _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id,) = abi.decode(ret, (uint256, uint256));
    }

    /// The keeper's exact repay-rung call: no collateral withdrawn, repay everything held.
    function _keeperUnwind(uint256[] memory ids) internal view returns (StrategyRouter.UnwindParams memory u) {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 0, quotedOut: 0, maxSlippageBps: 0, routeData: ""});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 15 minutes;
    }

    function _openOnAaveAndGrant() internal {
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, BORROW, 1))));
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW, "opened on Aave");
        assertEq(usdc.balanceOf(address(acct)), BORROW, "the borrowed USDC sits idle in the account");
        vm.prank(alice);
        acct.grant(
            keeper, _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 2 * BORROW), 0)
        );
    }

    function _switchToAave(address asset) internal {
        address feed = registry.config(asset).priceFeed;
        vm.prank(registryOwner);
        registry.proposeVenue(asset, address(aaveVenue), feed);
        vm.warp(block.timestamp + REGISTRY_TIMELOCK);
        vm.prank(registryOwner);
        registry.acceptVenue(asset);
    }

    // =====================================================================
    // M-HIGH-1: the keeper's unwind after the switch.
    // =====================================================================

    /// The audit's step-by-step scenario. `msg.sender = keeper`; the plan is `policy.ts:341`.
    function test_FIX_M1_keeperUnwindRepaysTheAavePositionAfterTheSwitch() public {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        assertEq(registry.venueOf(address(cbbtc)), address(morphoVenue), "the registry now points at Morpho");

        // cbBTC falls: 50,000 × 0.78 / 30,000 = HF 1.30, below the repay rung.
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);
        assertLt(aaveVenue.healthFactor(address(acct)), 1.35e18);

        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        (, uint256 repaid,,) = abi.decode(res[0], (uint256, uint256, uint256, uint256));

        assertEq(repaid, BORROW, "the keeper's unwind must reach the debt where it actually is");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the Aave debt was repaid, not ignored");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "nothing was ever on Morpho");
    }

    /// The dashboard's Close after the switch: repay everything and take the collateral back.
    function test_FIX_M1b_ownerCloseReturnsTheCollateralAfterTheSwitch() public {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));

        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max; // web/lib/plan.ts:531
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn, uint256 hf) = abi.decode(ret, (uint256, uint256, uint256, uint256));

        assertEq(repaid, BORROW);
        assertEq(withdrawn, ONE_CBBTC, "the collateral came back from Aave, where it was");
        assertEq(hf, type(uint256).max);
        assertEq(cbbtc.balanceOf(address(acct)), ONE_CBBTC);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0);
    }

    /// The LP variant from the audit (step 6): the closes went through — the LP venue is not
    /// registry-resolved — but the repay found no debt on the new venue, so the keeper turned a
    /// yield position into idle USDC and reported success. Now the repay reaches Aave too.
    function test_FIX_M1c_lpUnwindRepaysInsteadOfJustClosing() public {
        uint256 id = _openLp(ONE_CBBTC, BORROW, 1);
        vm.prank(alice);
        acct.grant(
            keeper, _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 2 * BORROW), 0)
        );
        _switchToMorpho(address(cbbtc));
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        StrategyRouter.UnwindParams memory u = _keeperUnwind(ids);
        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        (uint256 usdcFromLp, uint256 repaid,,) = abi.decode(res[0], (uint256, uint256, uint256, uint256));

        assertGt(usdcFromLp, 0, "the LP was closed");
        assertGt(repaid, 0, "and the proceeds repaid the debt instead of sitting in the account");
        assertLt(aaveVenue.debt(address(acct), address(usdc)), BORROW);
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
    }

    // =====================================================================
    // The registry's memory, and the current venue still wins for new positions.
    // =====================================================================

    function test_FIX_M1d_registryRemembersPreviousVenuesWithoutDuplicates() public {
        assertEq(registry.previousVenues(address(cbbtc)).length, 0, "nothing before the first switch");

        _switchToMorpho(address(cbbtc));
        address[] memory prev = registry.previousVenues(address(cbbtc));
        assertEq(prev.length, 1);
        assertEq(prev[0], address(aaveVenue));

        // Back to Aave: Morpho joins the list, Aave leaves it (it is current again).
        _switchToAave(address(cbbtc));
        prev = registry.previousVenues(address(cbbtc));
        assertEq(prev.length, 1);
        assertEq(prev[0], address(morphoVenue));

        // And once more to Morpho: no duplicate of Aave.
        _switchToMorpho(address(cbbtc));
        prev = registry.previousVenues(address(cbbtc));
        assertEq(prev.length, 1);
        assertEq(prev[0], address(aaveVenue));
    }

    /// A position opened AFTER the switch lives on Morpho and its exit resolves Morpho first.
    function test_FIX_M1e_aNewPositionOnTheCurrentVenueStillExitsThere() public {
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, BORROW, 2))));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), BORROW);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);

        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, BORROW);
        assertEq(withdrawn, ONE_CBBTC);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
    }

    /// Two positions, one per venue (opened before and after the switch): each unwind resolves
    /// the venue that holds something. With the current venue holding a position it wins; once it
    /// is empty the previous venue is found.
    function test_FIX_M1f_positionsOnBothVenuesAreEachReachable() public {
        _openOnAaveAndGrant(); // Aave: 1 cbBTC, 30k debt, 30k idle USDC
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 10_000e6);

        // First exit resolves the CURRENT venue (Morpho) and clears it.
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, 10_000e6);
        assertEq(withdrawn, ONE_CBBTC);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), 0);

        // Second exit now finds the Aave position through the registry's memory.
        ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, repaid, withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, BORROW);
        assertEq(withdrawn, ONE_CBBTC);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(cbbtc.balanceOf(address(acct)), 2 * ONE_CBBTC);
    }
}
