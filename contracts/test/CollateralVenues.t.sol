// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICollateralVenue} from "../src/interfaces/ICollateralVenue.sol";
import {AaveV3Venue} from "../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../src/venues/MorphoBlueVenue.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {IMorphoBlue, MarketParams} from "../src/interfaces/IMorphoBlue.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
import {ICollateralRegistry} from "../src/interfaces/ICollateralRegistry.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IAaveV3.sol";
import {MockAave} from "./mocks/MockAave.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract AaveV3VenueTest is Fixture {
    function setUp() public override {
        super.setUp();
        cbbtc.mint(address(acct), 10e8);
        weth.mint(address(acct), 100e18);
    }

    function _supply(address asset, uint256 amount) internal {
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (asset, amount)));
    }

    function _borrow(uint256 amount) internal {
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), amount)));
    }

    function test_riskParamsReadLiveFromDataProvider() public view {
        assertEq(aaveVenue.liquidationThresholdBps(address(cbbtc)), CBBTC_LT);
        assertEq(aaveVenue.maxLtvBps(address(cbbtc)), CBBTC_LTV);
        assertEq(aaveVenue.liquidationThresholdBps(address(weth)), WETH_LT);
        assertEq(aaveVenue.maxLtvBps(address(weth)), WETH_LTV);
        assertEq(aaveVenue.liquidationThresholdBps(address(cbzec)), 0, "cbZEC is not listed");
        assertEq(aaveVenue.borrowRateRay(address(usdc)), RATE_USDC_RAY);
        assertEq(aaveVenue.assetPrice(address(cbbtc)), PRICE_CBBTC_E8);
        assertTrue(aaveVenue.enabled());
    }

    function test_riskParamsFollowTheVenueWhenTheyChange() public {
        aave.setReserve(address(cbbtc), 7000, 7500, 750, true, true, PRICE_CBBTC_E8, RATE_CBBTC_RAY);
        assertEq(aaveVenue.liquidationThresholdBps(address(cbbtc)), 7500);
        assertEq(aaveVenue.maxLtvBps(address(cbbtc)), 7000);
    }

    function test_supplyLandsUnderTheAccount() public {
        _supply(address(cbbtc), 1e8);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 1e8);
        assertEq(cbbtc.balanceOf(address(acct)), 9e8);
        assertEq(cbbtc.allowance(address(acct), address(aave)), 0, "allowance must be reset");
        assertEq(aaveVenue.healthFactor(address(acct)), type(uint256).max);
    }

    function test_borrowPaysTheAccountAndHfIsLtOverLtv() public {
        _supply(address(cbbtc), 1e8);
        // 50 % LTV: HF = 0.78 / 0.50 = 1.56
        uint256 borrow = (PRICE_CBBTC_E8 * 50) / 100 / 100; // USD → 6 decimals: E8/100
        _borrow(borrow);
        assertEq(usdc.balanceOf(address(acct)), borrow);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), borrow);
        uint256 hf = aaveVenue.healthFactor(address(acct));
        assertApproxEqRel(hf, 1.56e18, 1e14);
    }

    function test_borrowBeyondLtvReverts() public {
        _supply(address(weth), 1e18);
        uint256 tooMuch = (PRICE_WETH_E8 * 81) / 100 / 100;
        vm.prank(alice);
        vm.expectRevert(MockAave.CollateralCannotCoverNewBorrow.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), tooMuch)));
    }

    function test_repayPartialAndAll() public {
        _supply(address(cbbtc), 1e8);
        _borrow(10_000e6);
        bytes memory ret =
            _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 4_000e6)));
        assertEq(abi.decode(ret, (uint256)), 4_000e6);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 6_000e6);
        aave.accrueDebt(address(acct), address(usdc), 100); // +1 % interest
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 6_060e6);
        usdc.mint(address(acct), 60e6);
        ret = _ownerExec(
            address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max))
        );
        assertEq(abi.decode(ret, (uint256)), 6_060e6);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(usdc.allowance(address(acct), address(aave)), 0);
    }

    function test_repayNothingOwedReverts() public {
        vm.prank(alice);
        vm.expectRevert(AaveV3Venue.NothingToRepay.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1)));
    }

    function test_withdrawPartialAndAllToTheAccount() public {
        _supply(address(weth), 10e18);
        bytes memory ret =
            _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(weth), 3e18)));
        assertEq(abi.decode(ret, (uint256)), 3e18);
        assertEq(weth.balanceOf(address(acct)), 93e18);
        ret = _ownerExec(
            address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(weth), type(uint256).max))
        );
        assertEq(abi.decode(ret, (uint256)), 7e18);
        assertEq(aaveVenue.collateral(address(acct), address(weth)), 0);
    }

    function test_withdrawBelowHfOneReverts() public {
        _supply(address(cbbtc), 1e8);
        _borrow(30_000e6);
        vm.prank(alice);
        vm.expectRevert(MockAave.HealthFactorBelowOne.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0.6e8)));
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 0)));
        vm.stopPrank();
    }

    function test_venueCannotBeUsedOutsideAnAccount() public {
        cbbtc.mint(bob, 1e8);
        vm.prank(bob);
        vm.expectRevert();
        aaveVenue.supply(address(cbbtc), 1e8);
        assertEq(cbbtc.balanceOf(bob), 1e8);
    }

    function test_venueHoldsNothing() public {
        _supply(address(cbbtc), 1e8);
        _borrow(10_000e6);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1_000e6)));
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 1e7)));
        assertEq(cbbtc.balanceOf(address(aaveVenue)), 0);
        assertEq(usdc.balanceOf(address(aaveVenue)), 0);
    }

    function test_keeperCanRepayWithinBudgetOnly() public {
        _supply(address(cbbtc), 1e8);
        _borrow(10_000e6);
        vm.prank(alice);
        acct.grant(
            keeper,
            _perm(address(aaveVenue), ICollateralVenue.repay.selector, _limits1(address(usdc), 5_000e6), 0)
        );
        vm.prank(keeper);
        acct.execAsKeeper(
            _one(_call(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 5_000e6))))
        );
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 5_000e6);
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(
            _one(_call(address(aaveVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1))))
        );
    }

    function test_keeperWithdrawAlwaysPaysTheAccount() public {
        _supply(address(cbbtc), 1e8);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(aaveVenue), ICollateralVenue.withdraw.selector, _limits1(address(cbbtc), 1), 0));
        vm.prank(keeper);
        acct.execAsKeeper(
            _one(_call(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 1e8))))
        );
        assertEq(cbbtc.balanceOf(address(acct)), 10e8);
        assertEq(cbbtc.balanceOf(keeper), 0);
    }
}

contract MorphoBlueVenueTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(address(acct), 10e8);
        weth.mint(address(acct), 100e18);
        // The registry points cbBTC and WETH at Aave at deploy time; the ONLY way to Morpho is the
        // timelocked replacement, so every supply test starts with it.
        _switchToMorpho(address(cbbtc));
        _switchToMorpho(address(weth));
    }

    function _supply(address asset, uint256 amount) internal {
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.supply, (asset, amount)));
    }

    function _borrow(uint256 amount) internal {
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), amount)));
    }

    function _usd6(uint256 priceE8, uint256 pct) internal pure returns (uint256) {
        return (priceE8 * pct) / 100 / 100; // 8-decimal USD → 6-decimal USDC
    }

    // ------------------------------------------------------------ construction

    function test_constructorBindsTheVerifiedMarketsAndNothingElse() public view {
        assertTrue(morphoVenue.enabled());
        assertEq(morphoVenue.marketIdOf(address(cbbtc)), morphoIdCbbtc);
        assertEq(morphoVenue.marketIdOf(address(weth)), morphoIdWeth);
        assertEq(morphoVenue.marketIdOf(address(cbzec)), bytes32(0));
        assertEq(morphoVenue.LOAN_TOKEN(), address(usdc));
        assertEq(address(morphoVenue.REGISTRY()), address(registry));
        address[] memory c = morphoVenue.collaterals();
        assertEq(c.length, 2);
        MarketParams memory p = morphoVenue.marketParamsOf(address(cbbtc));
        assertEq(p.lltv, MORPHO_LLTV_WAD);
        assertEq(p.oracle, address(morphoOracleCbbtc));
        assertEq(morphoVenue.marketId(p), morphoIdCbbtc, "id recomputes from the live params");
    }

    function test_constructorRefusesAnUnknownWrongOrDuplicateMarket() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("not a market");
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.MarketNotCreated.selector, ids[0]));
        new MorphoBlueVenue(IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), ids);

        // A market that lends WETH against cbBTC is not a USDC market.
        MarketParams memory wrong = MarketParams({
            loanToken: address(weth),
            collateralToken: address(cbbtc),
            oracle: address(morphoOracleCbbtc),
            irm: address(morphoIrm),
            lltv: MORPHO_LLTV_WAD
        });
        ids[0] = morpho.createMarket(wrong);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.WrongLoanToken.selector, ids[0], address(weth)));
        new MorphoBlueVenue(IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), ids);

        ids = new bytes32[](2);
        ids[0] = morphoIdCbbtc;
        ids[1] = morphoIdCbbtc;
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.DuplicateCollateral.selector, address(cbbtc)));
        new MorphoBlueVenue(IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), ids);
    }

    function test_aVenueWithNoMarketsIsDisabledAndTheRegistryRefusesIt() public {
        MorphoBlueVenue off = new MorphoBlueVenue(
            IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), new bytes32[](0)
        );
        assertFalse(off.enabled());
        assertEq(off.liquidationThresholdBps(address(cbbtc)), 0);
        assertEq(off.healthFactor(address(acct)), type(uint256).max);
        vm.prank(registryOwner);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.VenueDisabled.selector, address(off)));
        registry.register(address(aero), address(off), address(0), true, "");
        // An enabled venue with no market for the asset is refused the same way Aave's cbZEC is.
        vm.prank(registryOwner);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.VenueDoesNotKnowAsset.selector, address(aero)));
        registry.register(address(aero), address(morphoVenue), address(0), true, "");
    }

    // ------------------------------------------------------------ risk reads

    function test_riskParamsReadLiveFromMorpho() public view {
        (,,,, uint256 lltv) = morpho.idToMarketParams(morphoIdCbbtc);
        assertEq(morphoVenue.liquidationThresholdBps(address(cbbtc)), lltv / 1e14);
        assertEq(morphoVenue.liquidationThresholdBps(address(cbbtc)), 8600);
        assertEq(morphoVenue.maxLtvBps(address(cbbtc)), 8600, "Morpho has one threshold");
        assertEq(morphoVenue.liquidationThresholdBps(address(weth)), 8600);
        assertEq(morphoVenue.liquidationThresholdBps(address(cbzec)), 0, "no cbZEC market");
        assertEq(morphoVenue.maxLtvBps(address(cbzec)), 0);
        assertApproxEqRel(morphoVenue.borrowRateRay(address(usdc)), RATE_USDC_RAY, 1e12);
        assertApproxEqRel(morphoVenue.borrowRateRay(address(cbbtc)), RATE_USDC_RAY, 1e12);
        assertEq(morphoVenue.borrowRateRay(address(cbzec)), 0);
        assertEq(morphoVenue.oraclePrice(address(cbbtc)), _morphoPrice36(PRICE_CBBTC_E8, 8));
        // 86 % / 1.55 = 55.5 % → capped at the registry's 50 %.
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 5000);
    }

    function test_riskParamsFollowTheMarketNotAConstant() public {
        MarketParams memory p = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(aero),
            oracle: address(morphoOracleWeth),
            irm: address(morphoIrm),
            lltv: 0.77e18
        });
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = morpho.createMarket(p);
        MorphoBlueVenue other = new MorphoBlueVenue(
            IMorphoBlue(address(morpho)), ICollateralRegistry(address(registry)), address(usdc), ids
        );
        assertEq(other.liquidationThresholdBps(address(aero)), 7700);
        assertEq(other.maxLtvBps(address(aero)), 7700);
        morphoIrm.setRate(MORPHO_RATE_PER_SECOND_WAD * 2);
        assertApproxEqRel(other.borrowRateRay(address(usdc)), 2 * RATE_USDC_RAY, 1e12);
    }

    // ------------------------------------------------------------ mutators

    function test_supplyLandsUnderTheAccount() public {
        _supply(address(cbbtc), ONE_CBBTC);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC);
        (,, uint128 held) = morpho.position(morphoIdCbbtc, address(acct));
        assertEq(held, ONE_CBBTC, "Morpho's position is the ACCOUNT's");
        assertEq(cbbtc.balanceOf(address(acct)), 9e8);
        assertEq(cbbtc.allowance(address(acct), address(morpho)), 0, "allowance must be reset");
        assertEq(morphoVenue.healthFactor(address(acct)), type(uint256).max);
    }

    function test_supplyRefusesAnAssetTheRegistryDoesNotOfferHere() public {
        // cbZEC: registered disabled, at Aave, and has no Morpho market anyway.
        cbzec.mint(address(acct), 1e8);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoBlueVenue.AssetNotOffered.selector, address(cbzec), address(morphoVenue))
        );
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(cbzec), 1e8)));
        // An offered asset switched OFF by the operator is refused on this path too.
        vm.prank(registryOwner);
        registry.setEnabled(address(weth), false, "paused");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoBlueVenue.AssetNotOffered.selector, address(weth), address(morphoVenue))
        );
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(weth), 1e18)));
    }

    function test_borrowPaysTheAccountAndHfIsLltvOverLtv() public {
        _supply(address(cbbtc), ONE_CBBTC);
        uint256 borrow = _usd6(PRICE_CBBTC_E8, 50);
        _borrow(borrow);
        assertEq(usdc.balanceOf(address(acct)), borrow);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), borrow);
        assertEq(morphoVenue.debt(address(acct), address(cbbtc)), 0, "debt is in the loan token only");
        // 0.86 / 0.50 = 1.72
        assertApproxEqRel(morphoVenue.healthFactor(address(acct)), 1.72e18, 1e14);
    }

    function test_borrowBelowTheEntryFloorReverts() public {
        _supply(address(cbbtc), ONE_CBBTC);
        // 60 % LTV is inside Morpho's 86 % LLTV but HF 1.43 < the 1.55 floor.
        uint256 amount = _usd6(PRICE_CBBTC_E8, 60);
        vm.prank(alice);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), amount)));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
    }

    function test_borrowBeyondLltvRevertsInsideMorpho() public {
        _supply(address(weth), 1e18);
        uint256 tooMuch = _usd6(PRICE_WETH_E8, 87);
        vm.prank(alice);
        vm.expectRevert(bytes("insufficient collateral"));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), tooMuch)));
    }

    function test_borrowNeedsCollateralAndOnlyLendsTheLoanToken() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.NoCollateralPosition.selector, address(acct)));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 1e6)));
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.NotLoanToken.selector, address(weth)));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(weth), 1e18)));
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.NotLoanToken.selector, address(weth)));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(weth), 1e18)));
        vm.stopPrank();
    }

    function test_repayPartialThenAllAfterInterestApprovesExactlyWhatMorphoPulls() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(10_000e6);
        bytes memory ret =
            _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 4_000e6)));
        assertEq(abi.decode(ret, (uint256)), 4_000e6);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 6_000e6);

        vm.warp(block.timestamp + 365 days);
        uint256 owed = morphoVenue.debt(address(acct), address(usdc));
        assertGt(owed, 6_000e6, "a year of interest, computed before Morpho has accrued it");
        assertLt(owed, 6_400e6);

        usdc.mint(address(acct), owed - 6_000e6);
        uint256 before = usdc.balanceOf(address(acct));
        ret = _ownerExec(
            address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max))
        );
        assertEq(abi.decode(ret, (uint256)), owed, "what the view said is what Morpho took");
        assertEq(before - usdc.balanceOf(address(acct)), owed);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "closed by shares: no dust");
        (, uint128 borrowShares,) = morpho.position(morphoIdCbbtc, address(acct));
        assertEq(borrowShares, 0);
        assertEq(usdc.allowance(address(acct), address(morpho)), 0);
    }

    function test_repayMoreThanOwedClearsTheDebtAndTakesOnlyWhatIsOwed() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(10_000e6);
        usdc.mint(address(acct), 5_000e6);
        bytes memory ret =
            _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 12_000e6)));
        assertEq(abi.decode(ret, (uint256)), 10_000e6);
        assertEq(usdc.balanceOf(address(acct)), 5_000e6);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
    }

    function test_repayNothingOwedReverts() public {
        vm.prank(alice);
        vm.expectRevert(MorphoBlueVenue.NothingToRepay.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1)));
    }

    function test_withdrawPartialAndAllToTheAccount() public {
        _supply(address(weth), 10e18);
        bytes memory ret =
            _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(weth), 3e18)));
        assertEq(abi.decode(ret, (uint256)), 3e18);
        assertEq(weth.balanceOf(address(acct)), 93e18);
        ret = _ownerExec(
            address(morphoVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(weth), type(uint256).max))
        );
        assertEq(abi.decode(ret, (uint256)), 7e18);
        assertEq(morphoVenue.collateral(address(acct), address(weth)), 0);
        assertEq(weth.balanceOf(address(acct)), 100e18);
        vm.prank(alice);
        vm.expectRevert(MorphoBlueVenue.NothingToWithdraw.selector);
        acct.execWithCallback(
            address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(weth), type(uint256).max))
        );
    }

    function test_withdrawBelowHfOneRevertsInsideMorpho() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(30_000e6);
        vm.prank(alice);
        vm.expectRevert(bytes("insufficient collateral"));
        acct.execWithCallback(
            address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0.6e8))
        );
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(MorphoBlueVenue.ZeroAmount.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 0)));
        vm.expectRevert(MorphoBlueVenue.ZeroAmount.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 0)));
        vm.expectRevert(MorphoBlueVenue.ZeroAmount.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0)));
        vm.expectRevert(MorphoBlueVenue.ZeroAmount.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 0)));
        vm.stopPrank();
    }

    function test_venueCannotBeUsedOutsideAnAccountAndHoldsNothing() public {
        cbbtc.mint(bob, 1e8);
        vm.prank(bob);
        vm.expectRevert();
        morphoVenue.supply(address(cbbtc), 1e8);
        assertEq(cbbtc.balanceOf(bob), 1e8);

        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(10_000e6);
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1_000e6)));
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 1e7)));
        assertEq(cbbtc.balanceOf(address(morphoVenue)), 0);
        assertEq(usdc.balanceOf(address(morphoVenue)), 0);
    }

    // ------------------------------------------------------------ two markets

    function test_twoCollateralsAreTwoIsolatedPositions() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _supply(address(weth), 10e18);
        // Headroom: cbBTC ≈ 79.6k × 0.86 = 68.4k; WETH ≈ 24.5k × 0.86 = 21.1k → cbBTC first.
        _borrow(20_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 20_000e6);
        assertEq(_debtIn(morphoIdWeth), 0);
        // Now cbBTC headroom ≈ 48.4k vs WETH 21.1k → still cbBTC.
        _borrow(10_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 30_000e6);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 30_000e6);

        // Push the WETH market into use by borrowing more than cbBTC's remaining room allows at
        // the floor — the venue picks by headroom, the FLOOR still applies to the worst market.
        uint256 hfBefore = morphoVenue.healthFactor(address(acct));
        assertApproxEqRel(hfBefore, (PRICE_CBBTC_E8 * 86) / 100 / 100 * 1e18 / 30_000e6, 1e14);

        // Repay(max) clears BOTH markets by shares even if both carry debt.
        vm.warp(block.timestamp + 30 days);
        usdc.mint(address(acct), 1_000e6);
        uint256 owed = morphoVenue.debt(address(acct), address(usdc));
        bytes memory ret = _ownerExec(
            address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max))
        );
        assertEq(abi.decode(ret, (uint256)), owed);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
        assertEq(morphoVenue.healthFactor(address(acct)), type(uint256).max);
    }

    function test_healthFactorIsTheWorstMarketAndRepayPaysItFirst() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _supply(address(weth), 10e18);
        // Borrow into cbBTC (the headroom pick), then drop cbBTC's price so it becomes the worst.
        _borrow(30_000e6);
        // Force a WETH position too, straight at Morpho (the owner's right), 5k against 24.5k.
        vm.startPrank(alice);
        acct.exec(
            address(morpho),
            0,
            abi.encodeCall(
                IMorphoBlue.borrow, (morphoVenue.marketParamsOf(address(weth)), 5_000e6, 0, address(acct), address(acct))
            )
        );
        vm.stopPrank();
        assertEq(_debtIn(morphoIdWeth), 5_000e6);
        morphoOracleCbbtc.setPrice(_morphoPrice36(PRICE_CBBTC_E8 / 2, 8)); // cbBTC halves
        uint256 hfCbbtc = (PRICE_CBBTC_E8 / 2 * 86) / 100 / 100 * 1e18 / 30_000e6; // ≈ 1.14
        uint256 hfWeth = (PRICE_WETH_E8 * 10 * 86) / 100 / 100 * 1e18 / 5_000e6; // ≈ 4.22
        assertLt(hfCbbtc, hfWeth);
        assertApproxEqRel(morphoVenue.healthFactor(address(acct)), hfCbbtc, 1e14);

        // A partial repay goes to the cbBTC market (the worst) and nothing to WETH.
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 10_000e6)));
        assertEq(_debtIn(morphoIdCbbtc), 20_000e6);
        assertEq(_debtIn(morphoIdWeth), 5_000e6);
        // A repay larger than the worst market's debt spills into the next.
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 22_000e6)));
        assertEq(_debtIn(morphoIdCbbtc), 0);
        assertEq(_debtIn(morphoIdWeth), 3_000e6);
    }

    // ------------------------------------------------------------ keeper

    function test_keeperCanRepayWithinBudgetOnly() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(10_000e6);
        vm.prank(alice);
        acct.grant(
            keeper,
            _perm(address(morphoVenue), ICollateralVenue.repay.selector, _limits1(address(usdc), 5_000e6), 0)
        );
        vm.prank(keeper);
        acct.execAsKeeper(
            _one(_call(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 5_000e6))))
        );
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 5_000e6);
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(
            _one(_call(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1))))
        );
    }

    function test_keeperWithdrawAlwaysPaysTheAccount() public {
        _supply(address(cbbtc), ONE_CBBTC);
        vm.prank(alice);
        acct.grant(
            keeper, _perm(address(morphoVenue), ICollateralVenue.withdraw.selector, _limits1(address(cbbtc), 1), 0)
        );
        vm.prank(keeper);
        acct.execAsKeeper(
            _one(_call(address(morphoVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), ONE_CBBTC))))
        );
        assertEq(cbbtc.balanceOf(address(acct)), 10e8);
        assertEq(cbbtc.balanceOf(keeper), 0);
    }

    // ------------------------------------------------------------ audit wave 2 (M-MED-1, M-MED-2, M-LOW-1)

    function _borrowOnlyParams(uint256 collateral, uint256 borrow_, uint256 nonce)
        internal
        view
        returns (StrategyRouter.BorrowOnlyParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 20 minutes,
            signature: collateral == 0
                ? bytes("")
                : _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.deadline = block.timestamp + 15 minutes;
    }

    /// M-MED-1. The audit's scenario: 40 WETH already in the WETH market (headroom 40 × 2,453.45 ×
    /// 0.86 = 84,398 USDC) beats 1 cbBTC (68,450), so the old headroom rule put a "borrow against
    /// cbBTC" into the WETH market — the review screen's liquidation price named the wrong asset
    /// and `unwind(cbBTC, withdraw max)` took the cbBTC back with the debt untouched. The debt now
    /// lands in the market of the collateral the router just supplied.
    function test_FIX_M2_borrowAgainstTheSuppliedCollateralNotTheBiggestHeadroom() public {
        _supply(address(weth), 40e18);
        cbbtc.mint(alice, 1e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnlyParams(ONE_CBBTC, 20_000e6, 41))));
        assertEq(_debtIn(morphoIdCbbtc), 20_000e6, "the debt is in the market of the collateral the user chose");
        assertEq(_debtIn(morphoIdWeth), 0, "nothing landed on the WETH market");
        // The HF the router reports is the cbBTC market's: 79,593.77 × 0.86 / 20,000 = 3.42.
        assertApproxEqRel(morphoVenue.healthFactor(address(acct)), (uint256(PRICE_CBBTC_E8) * 86 / 100 / 100) * 1e18 / 20_000e6, 1e14);
    }

    /// M-MED-1 (fallback). `collateralAmount == 0` — borrow against what is already there — has no
    /// "just supplied" market, so the headroom rule still decides; the floor applies to the worst.
    function test_FIX_M2b_borrowAgainstExistingCollateralFallsBackToHeadroom() public {
        _supply(address(weth), 40e18);
        _supply(address(cbbtc), ONE_CBBTC);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnlyParams(0, 20_000e6, 42))));
        assertEq(_debtIn(morphoIdWeth), 20_000e6, "headroom picked WETH: 84,398 > 68,450");
        assertEq(_debtIn(morphoIdCbbtc), 0);
        // And an explicit borrowAgainst on an asset with no collateral is refused by name.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.NoCollateralPosition.selector, address(acct)));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrowAgainst, (address(aero), address(usdc), 1e6)));
    }

    /// M-MED-2. One market's oracle reverting used to block `repay`, `debt` and `healthFactor` for
    /// every account holding collateral there — including repaying the OTHER market, which Morpho
    /// itself allows. `debt` needs no oracle; `repay` orders an unreadable market first; only a
    /// market WITH debt reads its oracle, and an unreadable one reads as HF 0 (fail closed).
    function test_FIX_M3_anotherMarketsBrokenOracleDoesNotBlockRepay() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(30_000e6);
        _supply(address(weth), 1e18); // parked WETH, no debt
        morphoOracleWeth.setRevert(true);

        assertEq(morphoVenue.debt(address(acct), address(usdc)), 30_000e6, "debt is shares x market totals, no oracle");
        assertApproxEqRel(morphoVenue.healthFactor(address(acct)), (uint256(PRICE_CBBTC_E8) * 86 / 100 / 100) * 1e18 / 30_000e6, 1e14, "a market with no debt never reads its oracle");

        bytes memory ret = _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), type(uint256).max)));
        assertEq(abi.decode(ret, (uint256)), 30_000e6, "the cbBTC debt was repaid past the WETH oracle");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
        // …and a borrow still finds the cbBTC market (the unreadable one is skipped for headroom).
        _borrow(10_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 10_000e6);
    }

    /// M-MED-2 (the market WITH debt). Its own oracle breaking makes its HF unreadable: the venue
    /// answers 0 — a borrow is refused at the floor, a withdraw at the exit floor — and repay is
    /// still never gated.
    function test_FIX_M3b_theDebtMarketsBrokenOracleFailsClosedButNeverGatesRepay() public {
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(30_000e6);
        _supply(address(weth), 1e18);
        morphoOracleCbbtc.setRevert(true);

        assertEq(morphoVenue.healthFactor(address(acct)), 0, "unreadable with debt = worst, never a revert");
        vm.prank(alice);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 1e6)));

        bytes memory ret = _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.repay, (address(usdc), 10_000e6)));
        assertEq(abi.decode(ret, (uint256)), 10_000e6);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 20_000e6);
    }

    /// M-LOW-1. The fallback borrow used to pick the biggest headroom even when that market had no
    /// idle USDC to lend, and Morpho reverted while the other market could have filled it.
    function test_FIX_M4_headroomFallbackSkipsAMarketWithoutIdleLiquidity() public {
        // Drain the WETH market to 5,000 USDC idle.
        MarketParams memory mpWeth = morphoVenue.marketParamsOf(address(weth));
        vm.prank(morphoLender);
        morpho.withdraw(mpWeth, 50_000_000e6 - 5_000e6, 0, morphoLender, morphoLender);
        _supply(address(weth), 40e18); // headroom 84,398 > cbBTC's 68,450, but only 5,000 idle
        _supply(address(cbbtc), ONE_CBBTC);
        _borrow(20_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 20_000e6, "the market that can fill it");
        assertEq(_debtIn(morphoIdWeth), 0);
        // Drain cbBTC's market to 5,000 idle as well: now nothing can fill 10,000 — named, not
        // Morpho's "insufficient liquidity" string from whichever market happened to be picked.
        MarketParams memory mpCbbtc = morphoVenue.marketParamsOf(address(cbbtc));
        vm.prank(morphoLender);
        morpho.withdraw(mpCbbtc, 50_000_000e6 - 20_000e6 - 5_000e6, 0, morphoLender, morphoLender);
        // 5,000 fits in both; the bigger headroom (WETH, 84,398 vs cbBTC's 48,450) wins as before.
        _borrow(5_000e6);
        assertEq(_debtIn(morphoIdWeth), 5_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 20_000e6);
        // WETH is now dry and cbBTC has 5,000: 10,000 fits nowhere — named, not Morpho's string.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueVenue.NoMarketCanFill.selector, uint256(10_000e6)));
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 10_000e6)));
        // …and 5,000 goes to the only market that can still fill it.
        _borrow(5_000e6);
        assertEq(_debtIn(morphoIdCbbtc), 25_000e6);
    }

    // ------------------------------------------------------------ helpers

    function _debtIn(bytes32 id) internal view returns (uint256) {
        (, uint128 shares,) = morpho.position(id, address(acct));
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(id);
        if (shares == 0) return 0;
        return (uint256(shares) * (uint256(totalBorrowAssets) + 1) + (uint256(totalBorrowShares) + 1e6 - 1))
            / (uint256(totalBorrowShares) + 1e6);
    }
}

contract CollateralRegistryTest is Fixture {
    function test_configAndAssets() public view {
        CollateralRegistry.AssetConfig memory c = registry.config(address(cbzec));
        assertEq(c.venue, address(aaveVenue));
        assertEq(c.decimals, 8, "decimals are read from the token");
        assertFalse(c.enabled);
        assertEq(c.note, "no collateral market on Base yet");
        assertEq(registry.assets().length, 3);
        assertEq(registry.config(address(weth)).decimals, 18);
        assertEq(registry.config(address(cbbtc)).decimals, 8);
        assertTrue(registry.isEnabled(address(cbbtc)));
        assertEq(registry.venueOf(address(weth)), address(aaveVenue));
        assertEq(registry.entryHfFloorWad(), ENTRY_HF_FLOOR_WAD);
    }

    function test_maxOfferedLtvIsDerivedAndCapped() public {
        // cbBTC: floor(7800 / 1.55) = 5032 → capped 5000; WETH: floor(8300 / 1.55) = 5354 → 5000.
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 5000);
        assertEq(registry.maxOfferedLtvBps(address(weth)), 5000);
        assertEq(registry.maxOfferedLtvBps(address(cbzec)), 0, "disabled offers nothing");
        assertEq(registry.maxOfferedLtvBps(makeAddr("unknown")), 0);
    }

    function test_maxOfferedLtvFollowsTheVenueThreshold() public {
        // The audit's D2 case: LT 0.70 → floor(7000 / 1.55) = 4516 bps.
        aave.setReserve(address(cbbtc), 6500, 7000, 750, true, true, PRICE_CBBTC_E8, RATE_CBBTC_RAY);
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 4516);
        assertEq(registry.entryHfForLtv(address(cbbtc), 4516), uint256(7000 * 1e18) / 4516);
        assertGe(registry.entryHfForLtv(address(cbbtc), 4516), ENTRY_HF_FLOOR_WAD);
        assertLt(registry.entryHfForLtv(address(cbbtc), 4517), ENTRY_HF_FLOOR_WAD);
    }

    function test_maxOfferedLtvFollowsTheFloor() public {
        vm.prank(registryOwner);
        registry.setEntryHfFloor(2e18);
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 3900); // 7800 / 2
        assertEq(registry.maxOfferedLtvBps(address(weth)), 4150);
    }

    function test_entryHfForLtv() public view {
        assertEq(registry.entryHfForLtv(address(cbbtc), 5000), 1.56e18);
        assertEq(registry.entryHfForLtv(address(weth), 5000), 1.66e18);
        assertEq(registry.entryHfForLtv(address(cbbtc), 3000), 2.6e18);
        assertEq(registry.entryHfForLtv(address(cbbtc), 0), type(uint256).max);
    }

    function test_floorBounds() public {
        vm.startPrank(registryOwner);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.InvalidHfFloor.selector, 1e18));
        registry.setEntryHfFloor(1e18);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.InvalidHfFloor.selector, 11e18));
        registry.setEntryHfFloor(11e18);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.InvalidHfFloor.selector, 0));
        new CollateralRegistry(registryOwner, 0, REGISTRY_TIMELOCK);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.InvalidTimelock.selector, 1));
        new CollateralRegistry(registryOwner, ENTRY_HF_FLOOR_WAD, 1);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.InvalidTimelock.selector, 31 days));
        new CollateralRegistry(registryOwner, ENTRY_HF_FLOOR_WAD, 31 days);
    }

    function test_ownerOnly() public {
        vm.startPrank(bob);
        vm.expectRevert();
        registry.register(address(cbbtc), address(aaveVenue), address(0), true, "");
        vm.expectRevert();
        registry.setEnabled(address(cbbtc), false, "");
        vm.expectRevert();
        registry.setEntryHfFloor(2e18);
        vm.stopPrank();
    }

    function test_enableRequiresVenueListing() public {
        vm.startPrank(registryOwner);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.VenueDoesNotKnowAsset.selector, address(cbzec))
        );
        registry.setEnabled(address(cbzec), true, "");
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.AssetAlreadyRegistered.selector, address(cbzec))
        );
        registry.register(address(cbzec), address(aaveVenue), address(0), true, "");
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.VenueDoesNotKnowAsset.selector, address(aero))
        );
        registry.register(address(aero), address(aaveVenue), address(0), true, "");
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.UnknownAsset.selector, address(aero)));
        registry.setEnabled(address(aero), false, "");
        vm.stopPrank();
        // Once the venue lists it, enabling works.
        aave.setReserve(address(cbzec), 5000, 6000, 1000, true, false, 1020e8, 0);
        vm.prank(registryOwner);
        registry.setEnabled(address(cbzec), true, "");
        assertEq(registry.maxOfferedLtvBps(address(cbzec)), 3870); // floor(6000 / 1.55)
    }

    function test_disableAndReEnableIsImmediateInBothDirections() public {
        // Disabling is the ops safety valve: it must never wait on a timelock.
        vm.prank(registryOwner);
        registry.setEnabled(address(weth), false, "paused for review");
        assertEq(registry.config(address(weth)).note, "paused for review");
        assertEq(registry.maxOfferedLtvBps(address(weth)), 0);
        vm.prank(registryOwner);
        registry.setEnabled(address(weth), true, "");
        assertEq(registry.assets().length, 3, "the list is unchanged");
        assertEq(registry.maxOfferedLtvBps(address(weth)), 5000);
    }

    /// FIX B-MED-1. Aave retires a collateral by zeroing the LTV and KEEPING the liquidation
    /// threshold, so a registry that reads only the threshold keeps advertising 50 % while every
    /// open reverts inside Aave. Both parameters are read now.
    function test_FIX_B3_ltvZeroDeprecationTakesTheOfferToZero() public {
        aave.setReserve(address(cbbtc), 0, CBBTC_LT, 750, true, true, PRICE_CBBTC_E8, RATE_CBBTC_RAY);
        assertEq(aaveVenue.maxLtvBps(address(cbbtc)), 0, "the venue knows");
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 0, "and the registry now asks");
        // …and it cannot be (re-)enabled while the venue will not lend against it.
        vm.prank(registryOwner);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.VenueDoesNotKnowAsset.selector, address(cbbtc))
        );
        registry.setEnabled(address(cbbtc), true, "");
    }

    /// FIX A-HIGH-2 / D4. Pointing an asset at a different venue is the one owner power that could
    /// redirect user funds. It is now propose → wait → accept, with an event at each step.
    function test_FIX_A2_venueReplacementIsTimelockedAndAnnounced() public {
        AaveV3Venue replacement =
            new AaveV3Venue(IPoolAddressesProvider(address(aave)), ICollateralRegistry(address(registry)));

        // There is no immediate path: `register` refuses a known asset outright.
        vm.prank(registryOwner);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.AssetAlreadyRegistered.selector, address(cbbtc))
        );
        registry.register(address(cbbtc), address(replacement), address(0), true, "");

        uint40 eta = uint40(block.timestamp + REGISTRY_TIMELOCK);
        vm.expectEmit(true, true, true, true);
        emit CollateralRegistry.VenueChangeProposed(
            address(cbbtc), address(aaveVenue), address(replacement), address(0), eta
        );
        vm.prank(registryOwner);
        registry.proposeVenue(address(cbbtc), address(replacement), address(0));
        assertEq(registry.pendingVenue(address(cbbtc)).venue, address(replacement), "watchable on chain");
        assertEq(registry.venueOf(address(cbbtc)), address(aaveVenue), "not yet in force");

        vm.prank(registryOwner);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.TimelockNotElapsed.selector, eta));
        registry.acceptVenue(address(cbbtc));

        vm.warp(uint256(eta));
        vm.expectEmit(true, true, true, false);
        emit CollateralRegistry.VenueChangeAccepted(address(cbbtc), address(aaveVenue), address(replacement));
        vm.prank(registryOwner);
        registry.acceptVenue(address(cbbtc));
        assertEq(registry.venueOf(address(cbbtc)), address(replacement));
        assertEq(registry.pendingVenue(address(cbbtc)).venue, address(0), "pending cleared");
    }

    function test_FIX_A2b_pendingVenueChangeCanBeCancelled() public {
        vm.startPrank(registryOwner);
        registry.proposeVenue(address(cbbtc), address(aaveVenue), makeAddr("feed2"));
        vm.expectEmit(true, true, false, false);
        emit CollateralRegistry.VenueChangeCancelled(address(cbbtc), address(aaveVenue));
        registry.cancelVenueChange(address(cbbtc));
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.NoPendingChange.selector, address(cbbtc)));
        registry.acceptVenue(address(cbbtc));
        vm.stopPrank();
    }

    /// FIX B-LOW-5. A client reading both offer views gets one coherent story: a disabled asset is
    /// a named refusal, never a health factor of zero.
    function test_FIX_B11b_offerViewsAgreeOnADisabledAsset() public {
        assertEq(registry.maxOfferedLtvBps(address(cbzec)), 0);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.AssetNotEnabled.selector, address(cbzec)));
        registry.entryHfForLtv(address(cbzec), 5000);
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.UnknownAsset.selector, address(aero)));
        registry.entryHfForLtv(address(aero), 5000);
    }

    function testFuzz_maxOfferedLtvNeverExceedsCapOrThreshold(uint256 lt, uint256 floorWad) public {
        lt = bound(lt, 1, 10_000);
        floorWad = bound(floorWad, 1e18 + 1, 10e18);
        aave.setReserve(address(cbbtc), lt > 500 ? lt - 500 : 0, lt, 750, true, true, PRICE_CBBTC_E8, RATE_CBBTC_RAY);
        vm.prank(registryOwner);
        registry.setEntryHfFloor(floorWad);
        uint256 offered = registry.maxOfferedLtvBps(address(cbbtc));
        assertLe(offered, 5000);
        assertLe(offered, lt);
        if (offered != 0) assertGe(registry.entryHfForLtv(address(cbbtc), offered), floorWad);
    }
}
