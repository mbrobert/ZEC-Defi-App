// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {LoanDust} from "../../src/libraries/LoanDust.sol";
import {MockAave} from "../mocks/MockAave.sol";

/// @notice Slice C, 2026-09-10 (`RISKS.md` §8 "Rounding dust"). Measured on the fork at block
///         51,127,409: Aave reads a same-block borrow one unit over what it lent, so an account that
///         holds exactly what it borrowed could not `repay(max)` through the venue (Aave's
///         `transferFrom` died), and every exact-equality reading of "no debt" would have misread the
///         unit that is left. `LoanDust.UNITS` (= shared `LOAN_DUST_UNITS`) is the one threshold.
contract LoanDustRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;
    uint256 constant BORROW = 10_000e6;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(address(acct), 10 * ONE_CBBTC);
    }

    function _supplyAave(uint256 amount) internal {
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), amount)));
    }

    function _borrowAave(uint256 amount) internal {
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), amount)));
    }

    function _repayMax(address venue) internal returns (uint256) {
        bytes memory ret = _ownerExec(venue, abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max)));
        return abi.decode(ret, (uint256));
    }

    function _switch(address asset, address to) internal {
        address feed = registry.config(asset).priceFeed;
        vm.prank(registryOwner);
        registry.proposeVenue(asset, to, feed);
        vm.warp(block.timestamp + REGISTRY_TIMELOCK);
        vm.prank(registryOwner);
        registry.acceptVenue(asset);
    }

    // ------------------------------------------------------------ the constant

    function test_D0_theThresholdIsInLoanTokenUnitsAndTwoOrdersAboveTheMeasuredError() public pure {
        assertEq(LoanDust.UNITS, 100, "shared LOAN_DUST_UNITS; the agent's ABI seam pins the two together");
        assertTrue(LoanDust.isDust(0));
        assertTrue(LoanDust.isDust(1), "the measured residual");
        assertTrue(LoanDust.isDust(100));
        assertFalse(LoanDust.isDust(101));
        assertFalse(LoanDust.isDust(BORROW));
    }

    // ------------------------------------------------------------ the venue's repay(max)

    /// The fork scenario, on the mock: the account holds exactly the borrow; Aave says it owes one
    /// unit more. `repay(max)` used to revert inside Aave; it now repays everything held and leaves
    /// the rounding unit, which the venue reports and the threshold classifies.
    function test_D1_repayMaxHoldingExactlyTheBorrowRepaysEverythingHeldAndLeavesTheRoundingUnit() public {
        _supplyAave(ONE_CBBTC);
        _borrowAave(BORROW);
        aave.bumpDebt(address(acct), address(usdc), 1); // the measured +1 (Addendum 3)
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW + 1);
        assertEq(usdc.balanceOf(address(acct)), BORROW);

        uint256 repaid = _repayMax(address(aaveVenue));
        assertEq(repaid, BORROW, "everything the account held");
        assertEq(usdc.balanceOf(address(acct)), 0);
        uint256 residual = aaveVenue.debt(address(acct), address(usdc));
        assertEq(residual, 1);
        assertTrue(LoanDust.isDust(residual), "one unit is rounding, not a book");
        assertEq(usdc.allowance(address(acct), address(aave)), 0, "no standing allowance");

        // The venue does not forgive it: Aave refuses to release the last of the collateral while a
        // unit is owed (measured on the fork too, Addendum 6). The app must ask for the full debt().
        vm.prank(alice);
        vm.expectRevert(MockAave.HealthFactorBelowOne.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), type(uint256).max)));

        usdc.mint(address(acct), 1);
        assertEq(_repayMax(address(aaveVenue)), 1);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(aaveVenue.healthFactor(address(acct)), type(uint256).max);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), type(uint256).max)));
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0);
    }

    function test_D1b_repayMaxWithEnoughToCoverStillClearsToZero() public {
        _supplyAave(ONE_CBBTC);
        _borrowAave(BORROW);
        aave.bumpDebt(address(acct), address(usdc), 1);
        usdc.mint(address(acct), 1);
        assertEq(_repayMax(address(aaveVenue)), BORROW + 1);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
    }

    function test_D1c_anAccountHoldingNoUsdcIsRefusedByName() public {
        _supplyAave(ONE_CBBTC);
        _borrowAave(BORROW);
        // spend it all elsewhere
        _ownerExec(address(usdc), abi.encodeCall(IERC20.transfer, (bob, BORROW)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AaveV3Venue.InsufficientLoanToken.selector, address(usdc), 0, BORROW));
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max)));
        // a fixed amount above what is held is clamped the same way
        usdc.mint(address(acct), 400e6);
        bytes memory ret = _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1_000e6)));
        assertEq(abi.decode(ret, (uint256)), 400e6, "repaid what was held, not what was asked");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW - 400e6);
    }

    // ------------------------------------------------------------ the router's exit routing

    /// A two-book account whose CURRENT venue holds only a rounding unit of debt and whose position
    /// sits on the previous venue: the withdraw leg used to go to the current venue (a unit of debt
    /// counted as "holding a position") and die there with nothing to withdraw. Reaching this state
    /// needs the mock's rounding hook — the live venues never let collateral reach zero with debt
    /// outstanding — so the test documents a defensive rule, and says so.
    function test_D2_aDustOnlyCurrentVenueDoesNotAttractTheWithdrawLeg() public {
        // Open the real position on Morpho while it is the current venue…
        _switch(address(cbbtc), address(morphoVenue));
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), ONE_CBBTC)));
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), BORROW)));
        // …then move the pointer back to Aave (Morpho becomes a previous venue) and leave one unit
        // of rounding on the Aave book with nothing supplied there.
        _switch(address(cbbtc), address(aaveVenue));
        aave.bumpDebt(address(acct), address(usdc), 1);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 1);
        assertEq(registry.venueOf(address(cbbtc)), address(aaveVenue));

        // The owner's Close: repay everything, take the collateral back — funded with the full
        // `debt()` of every book (interest accrued over the two timelocks plus the rounding unit),
        // which is what the dashboard asks the user to hold.
        uint256 owedEverywhere = aaveVenue.debt(address(acct), address(usdc)) + morphoVenue.debt(address(acct), address(usdc));
        uint256 heldNow = usdc.balanceOf(address(acct));
        if (owedEverywhere > heldNow) usdc.mint(address(acct), owedEverywhere - heldNow);
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 0, quotedOut: 0, maxSlippageBps: 0, routeData: ""});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = type(uint256).max;
        u.deadline = block.timestamp + 15 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, owedEverywhere, "both books repaid: the rounding unit on Aave and the loan (with interest) on Morpho");
        assertEq(withdrawn, ONE_CBBTC, "the withdraw leg went to Morpho, where the collateral is");
        assertEq(cbbtc.balanceOf(address(acct)), 10 * ONE_CBBTC);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
    }
}
