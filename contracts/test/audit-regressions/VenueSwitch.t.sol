// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {Call} from "../../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";

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

    /// Two positions, one per venue (opened before and after the switch). The REPAY leg reaches
    /// both books in one call, worst health factor first (2026-09-09; until then the first exit
    /// repaid Morpho's 10k only and the Aave 30k waited for the second click). The WITHDRAW leg
    /// visits every venue holding the account's collateral, current pointer first (2026-09-11;
    /// until then it stopped at the current venue and the Aave collateral waited for a second
    /// Close — slice D's KNOWN FAILURE). One Close returns both collaterals.
    function test_FIX_M1f_positionsOnBothVenuesAreEachReachable() public {
        _openOnAaveAndGrant(); // Aave: 1 cbBTC, 30k debt, 30k idle USDC
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 10_000e6);
        assertLt(aaveVenue.healthFactor(address(acct)), morphoVenue.healthFactor(address(acct)), "Aave is the worse book");

        // The one exit: the repay clears Aave (worse) then Morpho; the withdraw visits Morpho (the
        // current pointer) and then Aave, and both collaterals come back.
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, BORROW + 10_000e6, "one unwind repaid both books");
        assertEq(withdrawn, 2 * ONE_CBBTC, "one unwind returned both collaterals");
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), 0);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0, "the previous venue's collateral came back in the same call");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the previous venue's debt went in the same call");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
        assertEq(cbbtc.balanceOf(address(acct)), 2 * ONE_CBBTC);

        // A second Close has nothing to do and says so through the current venue's own refusal.
        vm.expectRevert(MorphoBlueVenue.NothingToWithdraw.selector);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
    }

    // =====================================================================
    // RISKS §8 residual (a), closed 2026-09-09: the repay leg must reach EVERY venue the account
    // still owes, worst health factor first — not the first venue that happens to hold anything.
    // Before this, a Morpho pointer with dust collateral (or a small, healthy Morpho debt) was
    // "the first venue holding the asset", the keeper's repay landed there, and the Aave debt that
    // fired the rung rode on — CONFIRMED when Morpho owed a little, silent when it owed nothing.
    // =====================================================================

    uint256 constant DUST = 1e4; // 0.0001 cbBTC of collateral on the current (Morpho) venue
    uint256 constant SMALL = 1_000e6; // a healthy 1,000 USDC Morpho debt next to the 30,000 on Aave

    /// The account holds dust collateral on the CURRENT venue and its whole debt on the previous one.
    function _openOnAaveThenDustOnMorpho() internal {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        cbbtc.mint(address(acct), DUST);
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), DUST)));
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), DUST, "dust sits on Morpho");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "nothing is owed on Morpho");
        // cbBTC falls on Aave: 50,000 × 0.78 / 30,000 = HF 1.30, below the repay rung.
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);
        assertLt(aaveVenue.healthFactor(address(acct)), 1.35e18);
    }

    /// The account owes a lot on the previous venue (Aave, HF 1.30) and a little on the current one
    /// (Morpho, 1 cbBTC against 1,000 USDC: HF ≈ 68). It holds 31,000 idle USDC — enough for both.
    function _openOnAaveThenSmallDebtOnMorpho() internal {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, SMALL, 2))));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), SMALL);
        assertEq(usdc.balanceOf(address(acct)), BORROW + SMALL);
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);
        assertLt(aaveVenue.healthFactor(address(acct)), 1.35e18, "Aave is the book in trouble");
        assertGt(morphoVenue.healthFactor(address(acct)), 10e18, "Morpho is the healthy book");
    }

    function _keeperRepay(uint256 repayAmount) internal returns (uint256 repaid) {
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.repayAmount = repayAmount;
        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        (, repaid,,) = abi.decode(res[0], (uint256, uint256, uint256, uint256));
    }

    /// Dust collateral on the current venue must not hide the debt on the previous one. Before the
    /// fix this call SUCCEEDED with `repaid == 0` and the Aave debt untouched.
    function test_FIX_M1g_keeperRepayReachesAaveDebtBehindMorphoDustCollateral() public {
        _openOnAaveThenDustOnMorpho();
        uint256 repaid = _keeperRepay(type(uint256).max);
        assertEq(repaid, BORROW, "the keeper's repay must reach the debt, not the dust");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the Aave debt was repaid, never a silent success");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), DUST, "the dust is untouched");
    }

    /// A small, healthy debt on the current venue must not absorb the repay meant for the book in
    /// trouble. Before the fix this call repaid the 1,000 USDC on Morpho, returned `repaid > 0` — so
    /// the keeper called it CONFIRMED — and left the 30,000 on Aave riding at HF 1.30.
    function test_FIX_M1h_keeperRepayPaysTheWorstBookFirstNotTheHealthierOne() public {
        _openOnAaveThenSmallDebtOnMorpho();
        uint256 repaid = _keeperRepay(type(uint256).max);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the Aave debt (the worst book) was repaid first");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "and the remainder cleared Morpho");
        assertEq(repaid, BORROW + SMALL, "one unwind reached both books");
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    /// A bounded repay (a partial rung) goes to the worst venue first and only spills over once
    /// that venue is clear. Before the fix the 5,000 went to Morpho (1,000 repaid, the rest idle).
    function test_FIX_M1i_aBoundedRepayGoesToTheWorstVenueFirst() public {
        _openOnAaveThenSmallDebtOnMorpho();
        uint256 repaid = _keeperRepay(5_000e6);
        assertEq(repaid, 5_000e6);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW - 5_000e6, "every unit went to the worst book");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), SMALL, "the healthy book was not touched");
        assertEq(usdc.balanceOf(address(acct)), BORROW + SMALL - 5_000e6);
    }

    /// Today's production shape — one asset, one venue, no switch ever — is exactly what it was,
    /// plus one `VenueRepaid` naming the Aave venue for the keeper's receipt check.
    function test_FIX_M1j_theAaveOnlyProductionShapeIsUnchanged() public {
        _openOnAaveAndGrant();
        assertEq(registry.previousVenues(address(cbbtc)).length, 0, "no switch has happened");
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueRepaid(address(acct), address(aaveVenue), BORROW);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.LeveragedLpUnwound(address(acct), address(cbbtc), 0, 0, 0, BORROW, 0, type(uint256).max);
        uint256 repaid = _keeperRepay(type(uint256).max);
        assertEq(repaid, BORROW);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    /// The receipt says WHICH book was paid: one `VenueRepaid` per venue, worst first, and the
    /// `LeveragedLpUnwound` total is their sum. This is what the keeper's `confirm()` reads.
    function test_FIX_M1k_oneVenueRepaidPerVenueWorstFirstAndTheTotalIsTheirSum() public {
        _openOnAaveThenSmallDebtOnMorpho();
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueRepaid(address(acct), address(aaveVenue), BORROW);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueRepaid(address(acct), address(morphoVenue), SMALL);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.LeveragedLpUnwound(address(acct), address(cbbtc), 0, 0, 0, BORROW + SMALL, 0, type(uint256).max);
        uint256 repaid = _keeperRepay(type(uint256).max);
        assertEq(repaid, BORROW + SMALL);
    }

    /// The reported health factor is the account's WORST across the venues named for the asset:
    /// after a bounded repay Aave (25k left at the crashed price) is still the worse book, and that
    /// is the number the event carries — not the healthy Morpho book's.
    function test_FIX_M1l_theEventCarriesTheWorstHealthFactorAcrossVenues() public {
        _openOnAaveThenSmallDebtOnMorpho();
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.repayAmount = 5_000e6;
        vm.prank(keeper);
        bytes[] memory res = acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        (,,, uint256 hf) = abi.decode(res[0], (uint256, uint256, uint256, uint256));
        assertEq(hf, aaveVenue.healthFactor(address(acct)), "the worse book's factor");
        assertLt(hf, morphoVenue.healthFactor(address(acct)));
        // 50,000 x 0.78 / 25,000 = 1.56: the number the keeper's ladder sees, not Morpho's ~68.
        assertApproxEqRel(hf, 1.56e18, 1e14);
    }

    // =====================================================================
    // RISKS §8 "two-book Close", option (1), decided 2026-09-10, implemented 2026-09-11 (slice F):
    // the WITHDRAW leg visits every venue holding the account's collateral, current pointer first,
    // each gated by that venue's own exit floor, one `VenueWithdrawn` per venue reached. Slice D
    // had proved the strand with `invariant_KNOWN_singleCloseStrandsCollateral`; that invariant is
    // now `invariant_singleCloseClearsEveryBook`.
    // =====================================================================

    /// The web's exact Close on a two-book account, debt-free on both: one call, two
    /// `VenueWithdrawn` events — the current pointer first — and the sum in `LeveragedLpUnwound`.
    function test_FIX_M1m_oneCloseWithdrawsFromEveryVenueHoldingCollateral() public {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max;
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueWithdrawn(address(acct), address(morphoVenue), ONE_CBBTC);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueWithdrawn(address(acct), address(aaveVenue), ONE_CBBTC);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.LeveragedLpUnwound(
            address(acct), address(cbbtc), 0, 0, 0, BORROW + 10_000e6, 2 * ONE_CBBTC, type(uint256).max
        );
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(cbbtc.balanceOf(address(acct)), 2 * ONE_CBBTC);
    }

    /// The per-venue gate is the same rule applied to each venue withdrawn from: a Close that would
    /// leave the Aave book below the floor reverts `ExitHfTooLow` even though the Morpho book
    /// (visited first) was fine, and nothing moves — the transaction is atomic.
    function test_FIX_M1n_eachVenueIsGatedByItsOwnExitFloor() public {
        _openOnAaveAndGrant(); // 30k on Aave, HF ≈ 2.07 at the fixture price
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        // Repay nothing, withdraw half the collateral in total: Morpho gives its whole 1 cbBTC?
        // No — a fixed amount is a TOTAL: 0.5 from Morpho (the current pointer), Morpho left with
        // 0.5 against 10k (HF 34 at the fixture price) passes; nothing asked of Aave. Then ask for
        // 1.6 in total: Morpho's whole 1 cbBTC (debt-free? no: 10k still owed → HF 0 → refused).
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.repayAmount = 0;
        u.withdrawAmount = 1.6e8;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(); // ExitHfTooLow at the venue that would be left below the floor
        acct.execWithCallback(address(router), 0, data);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC, "atomic: nothing moved");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC);
    }

    /// A fixed `withdrawAmount` is a TOTAL across the venues, taken in venue order (current pointer
    /// first) and never more than a venue holds; the remainder spills to the next venue. `max`
    /// means everything on every venue.
    function test_FIX_M1o_aFixedWithdrawIsATotalTakenInVenueOrder() public {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        // Clear both debts first so the floor does not interfere.
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(aaveVenue.debt(address(acct), address(usdc)) + morphoVenue.debt(address(acct), address(usdc)), 0);

        u.withdrawAmount = 1.5e8; // more than Morpho holds: 1 from Morpho, 0.5 from Aave
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueWithdrawn(address(acct), address(morphoVenue), ONE_CBBTC);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueWithdrawn(address(acct), address(aaveVenue), 0.5e8);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (,, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(withdrawn, 1.5e8);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), 0);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0.5e8);

        // Asking for more than every venue holds together is refused by name, never silently less.
        u.withdrawAmount = 1e8;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.CollateralShort.selector, 1e8, 0.5e8));
        acct.execWithCallback(address(router), 0, data);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0.5e8, "atomic");
    }

    /// Today's production shape — one asset, one venue, no switch ever — is exactly what it was,
    /// plus one `VenueWithdrawn` naming the Aave venue.
    function test_FIX_M1p_theAaveOnlyCloseIsUnchangedPlusOneEvent() public {
        _openOnAaveAndGrant();
        assertEq(registry.previousVenues(address(cbbtc)).length, 0, "no switch has happened");
        StrategyRouter.UnwindParams memory u = _keeperUnwind(new uint256[](0));
        u.withdrawAmount = type(uint256).max;
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueRepaid(address(acct), address(aaveVenue), BORROW);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.VenueWithdrawn(address(acct), address(aaveVenue), ONE_CBBTC);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.LeveragedLpUnwound(address(acct), address(cbbtc), 0, 0, 0, BORROW, ONE_CBBTC, type(uint256).max);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, BORROW);
        assertEq(withdrawn, ONE_CBBTC);
        assertEq(cbbtc.balanceOf(address(acct)), ONE_CBBTC);
    }

    /// The keeper's grant is untouched by the change: its plan keeps `withdrawAmount = 0`, and a
    /// keeper that set it would be stopped by the exit floor on the venue it drains, not by the
    /// grant — exactly as before (the selector did not move, so the signed permission still fits).
    function test_FIX_M1q_theKeeperGrantAndSelectorAreUnchanged() public {
        _openOnAaveAndGrant();
        _switchToMorpho(address(cbbtc));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 10_000e6, 3))));
        aave.setReserve(address(cbbtc), CBBTC_LTV, CBBTC_LT, 750, true, true, 50_000e8, RATE_CBBTC_RAY);
        uint256 repaid = _keeperRepay(type(uint256).max);
        assertEq(repaid, BORROW + 10_000e6, "the keeper's repay-only call still reaches both books through the same selector");
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC, "a keeper unwind withdraws nothing");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC);
        assertEq(StrategyRouter.unwind.selector, bytes4(0x08435e75), "the selector the signed grant names");
    }
}
