// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICollateralVenue} from "../src/interfaces/ICollateralVenue.sol";
import {AaveV3Venue} from "../src/venues/AaveV3Venue.sol";
import {MorphoBlueVenue} from "../src/venues/MorphoBlueVenue.sol";
import {MarketParams} from "../src/interfaces/IMorphoBlue.sol";
import {CollateralRegistry} from "../src/registry/CollateralRegistry.sol";
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
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), tooMuch)));
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
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1)));
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
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0.6e8)));
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 0)));
        vm.expectRevert(AaveV3Venue.ZeroAmount.selector);
        acct.exec(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.repay, (address(usdc), 0)));
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
        acct.grant(keeper, _perm(address(aaveVenue), ICollateralVenue.withdraw.selector, _limits1(address(cbbtc), 0), 0));
        vm.prank(keeper);
        acct.execAsKeeper(
            _one(_call(address(aaveVenue), abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 1e8))))
        );
        assertEq(cbbtc.balanceOf(address(acct)), 10e8);
        assertEq(cbbtc.balanceOf(keeper), 0);
    }
}

contract MorphoBlueVenueTest is Fixture {
    function test_shipsDisabledAndFailsClosed() public {
        assertFalse(morphoVenue.enabled());
        vm.startPrank(alice);
        bytes memory d = abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 1));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        acct.exec(address(morphoVenue), 0, d);
        d = abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 1));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        acct.exec(address(morphoVenue), 0, d);
        d = abi.encodeCall(ICollateralVenue.repay, (address(usdc), 1));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        acct.exec(address(morphoVenue), 0, d);
        d = abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), 1));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        acct.exec(address(morphoVenue), 0, d);
        vm.stopPrank();
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.healthFactor(address(acct));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.liquidationThresholdBps(address(cbbtc));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.maxLtvBps(address(cbbtc));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.debt(address(acct), address(usdc));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.collateral(address(acct), address(cbbtc));
        vm.expectRevert(MorphoBlueVenue.VenueDisabled.selector);
        morphoVenue.borrowRateRay(address(usdc));
    }

    function test_marketIdIsKeccakOfParams() public {
        MarketParams memory p = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(cbbtc),
            oracle: makeAddr("oracle"),
            irm: makeAddr("irm"),
            lltv: 0.86e18
        });
        assertEq(morphoVenue.marketId(p), keccak256(abi.encode(p)));
    }

    function test_registryRefusesToEnableAnAssetOnADisabledVenue() public {
        vm.prank(registryOwner);
        vm.expectRevert(
            abi.encodeWithSelector(CollateralRegistry.VenueDisabled.selector, address(morphoVenue))
        );
        registry.register(address(cbbtc), address(morphoVenue), address(0), true, "");
        // Registering it disabled is fine (ships as a placeholder).
        vm.prank(registryOwner);
        registry.register(address(cbbtc), address(morphoVenue), address(0), false, "morpho market not discovered");
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 0);
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
        new CollateralRegistry(registryOwner, 0);
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
            abi.encodeWithSelector(CollateralRegistry.VenueDoesNotKnowAsset.selector, address(cbzec))
        );
        registry.register(address(cbzec), address(aaveVenue), address(0), true, "");
        vm.expectRevert(abi.encodeWithSelector(CollateralRegistry.UnknownAsset.selector, address(aero)));
        registry.setEnabled(address(aero), false, "");
        vm.stopPrank();
        // Once the venue lists it, enabling works.
        aave.setReserve(address(cbzec), 5000, 6000, 1000, true, false, 1020e8, 0);
        vm.prank(registryOwner);
        registry.setEnabled(address(cbzec), true, "");
        assertEq(registry.maxOfferedLtvBps(address(cbzec)), 3870); // floor(6000 / 1.55)
    }

    function test_disableWithNoteAndReRegisterKeepsList() public {
        vm.prank(registryOwner);
        registry.setEnabled(address(weth), false, "paused for review");
        assertEq(registry.config(address(weth)).note, "paused for review");
        assertEq(registry.maxOfferedLtvBps(address(weth)), 0);
        vm.prank(registryOwner);
        registry.register(address(weth), address(aaveVenue), makeAddr("feed2"), true, "");
        assertEq(registry.assets().length, 3, "re-register must not duplicate");
        assertEq(registry.maxOfferedLtvBps(address(weth)), 5000);
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
