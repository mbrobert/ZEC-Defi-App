// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {CollateralRegistry} from "../../src/registry/CollateralRegistry.sol";
import {MorphoBlueVenue} from "../../src/venues/MorphoBlueVenue.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {ICollateralRegistry} from "../../src/interfaces/ICollateralRegistry.sol";
import {IMorphoBlue, MarketParams} from "../../src/interfaces/IMorphoBlue.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {Call} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice `EntryFloor.t.sol`, replayed against `MorphoBlueVenue` over the two Base markets read
///         from the chain on 2026-09-07 (cbBTC/USDC and WETH/USDC, both 86 % LLTV — VERIFIED-BASE-FACTS).
///
///   A-HIGH-1 (again)  Morpho's LLTV is 86 %, higher than Aave's 73 % LTV, so a hand-built
///                     `execBatch([permit2, supply, borrow])` against this venue would open at
///                     HF 1.16 against an advertised 1.55 — unless the floor is a property of the
///                     VENUE CALL here too. It is. Every borrow through this venue re-reads the
///                     registry's floor and the account's WORST market health factor.
///   The registry     cbBTC and WETH point at Aave at deploy time. The ONLY road to this venue is
///                     `proposeVenue` → `TIMELOCK_DELAY` → `acceptVenue`; the venue refuses to take a
///                     supply before that road has been walked.
///   Live parameters  LLTV comes from `idToMarketParams` at call time. There is no constant to be
///                     wrong: a venue over a 77 % market says 7700.
///   Controls         the owner exit guarantee, straight at Morpho, re-proved in every broken state.
contract MorphoEntryFloorRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;
    uint256 constant MORPHO_LLTV_BPS = 8600;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        weth.mint(alice, 100e18);
        vm.startPrank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        weth.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
        // cbBTC moves to Morpho the only way the registry allows. WETH stays on Aave.
        _switchToMorpho(address(cbbtc));
    }

    /// The three calls `web/lib/plan.ts` used to emit for strategy = "hold", aimed at this venue.
    function _holdBatch(
        address account,
        address owner_,
        uint256 key,
        uint256 collateral,
        uint256 borrow_,
        uint256 nonce
    ) internal view returns (Call[] memory calls) {
        bytes memory sig =
            _signPermitWith(key, address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, account);
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: address(cbbtc), amount: collateral}),
            nonce: nonce,
            deadline: block.timestamp + 20 minutes
        });
        IPermit2.SignatureTransferDetails memory details =
            IPermit2.SignatureTransferDetails({to: account, requestedAmount: collateral});
        calls = new Call[](3);
        calls[0] =
            _call(address(permit2), abi.encodeCall(IPermit2.permitTransferFrom, (permit, details, owner_, sig)));
        calls[1] =
            _callP(address(morphoVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), collateral)));
        calls[2] =
            _callP(address(morphoVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), borrow_)));
    }

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
            signature: collateral == 0
                ? bytes("")
                : _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.deadline = block.timestamp + 15 minutes;
    }

    function _usdc(uint256 priceE8, uint256 bps) internal pure returns (uint256) {
        return (priceE8 * bps) / 10_000 / 100;
    }

    function _paramsCbbtc() internal view returns (MarketParams memory) {
        return morphoVenue.marketParamsOf(address(cbbtc));
    }

    // =====================================================================
    // A-HIGH-1 on Morpho. The exact hold batch hits the floor at the VENUE.
    // =====================================================================

    function test_FIX_M1_theHoldBatchCannotOpenAtMorphosLltv() public {
        uint256 maxBorrow = _usdc(PRICE_CBBTC_E8, MORPHO_LLTV_BPS - 100); // 85 %: inside Morpho, HF 1.01
        Call[] memory calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, maxBorrow, 1);

        vm.prank(alice);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        acct.execBatch(calls);

        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "atomic: nothing borrowed");
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), 0, "atomic: nothing supplied");
        assertEq(cbbtc.balanceOf(alice), 10e8, "atomic: nothing pulled from the wallet");

        // 86 % / 1.55 = 55.5 %, capped at 50 %. What the registry advertises works, same batch.
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 5000);
        uint256 offered = _usdc(PRICE_CBBTC_E8, registry.maxOfferedLtvBps(address(cbbtc)));
        calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, offered, 2);
        vm.prank(alice);
        acct.execBatch(calls);
        uint256 hf = morphoVenue.healthFactor(address(acct));
        console2.log("hold-path HF at the advertised maximum (Morpho):", hf);
        assertGe(hf, registry.entryHfFloorWad(), "what the registry advertises is what the chain enforces");
        assertEq(registry.entryHfForLtv(address(cbbtc), 5000), 1.72e18, "LLTV / LTV, from the live market");
    }

    /// A FIRST-TIME user: account created and maxed out in one transaction. Refused, atomically.
    function test_FIX_M2_firstTimeUserCannotOpenAnUnprotectedPosition() public {
        uint256 newKey = 0xBEEF;
        address newbie = vm.addr(newKey);
        cbbtc.mint(newbie, ONE_CBBTC);
        vm.prank(newbie);
        cbbtc.approve(address(permit2), type(uint256).max);

        address predicted = factory.accountOf(newbie);
        uint256 maxBorrow = _usdc(PRICE_CBBTC_E8, 7000);
        Call[] memory calls = _holdBatch(predicted, newbie, newKey, ONE_CBBTC, maxBorrow, 7);

        vm.prank(newbie);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        factory.createAccountAndExec(calls);
        assertEq(predicted.code.length, 0, "atomic: not even the account was created");
    }

    /// No attacker, no client bug: the wizard quotes 50 %, cbBTC drops 20 % on the MARKET's oracle
    /// inside the permit deadline, the borrow is fixed in USDC. The chain re-checks it now.
    function test_FIX_M3b_priceDriftOnTheMarketOracleIsCaught() public {
        uint256 quotedBorrow = _usdc(PRICE_CBBTC_E8, 5000);
        Call[] memory calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, quotedBorrow, 11);
        morphoOracleCbbtc.setPrice(_morphoPrice36((PRICE_CBBTC_E8 * 8000) / 10_000, 8));

        vm.prank(alice);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        acct.execBatch(calls);
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0, "no position opened below the floor");
    }

    /// Any borrow the venue lets through leaves the account at or above the floor; any it refuses
    /// leaves nothing behind.
    function testFuzz_FIX_M3c_everyAcceptedBorrowIsAtOrAboveTheFloor(uint256 borrow_) public {
        borrow_ = bound(borrow_, 1e6, _usdc(PRICE_CBBTC_E8, 9000));
        Call[] memory calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, borrow_, 21);
        vm.prank(alice);
        (bool ok,) = address(acct).call(abi.encodeCall(acct.execBatch, (calls)));
        if (ok) {
            assertGe(morphoVenue.healthFactor(address(acct)), registry.entryHfFloorWad());
            assertEq(usdc.balanceOf(address(acct)), borrow_);
        } else {
            assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
            assertEq(cbbtc.balanceOf(alice), 10e8);
        }
    }

    // =====================================================================
    // The registry road. Nothing reaches this venue except through the timelock.
    // =====================================================================

    function test_FIX_M4_theVenueTakesNothingUntilTheTimelockedSwitchHasLanded() public {
        // WETH still points at Aave: the Morpho venue refuses it outright.
        weth.mint(address(acct), 1e18);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoBlueVenue.AssetNotOffered.selector, address(weth), address(morphoVenue))
        );
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(weth), 1e18)));

        // Proposed but not accepted: still refused, for the whole delay.
        vm.prank(registryOwner);
        registry.proposeVenue(address(weth), address(morphoVenue), makeAddr("feed-eth"));
        assertEq(registry.venueOf(address(weth)), address(aaveVenue));
        vm.warp(block.timestamp + REGISTRY_TIMELOCK - 1);
        vm.prank(registryOwner);
        vm.expectPartialRevert(CollateralRegistry.TimelockNotElapsed.selector);
        registry.acceptVenue(address(weth));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoBlueVenue.AssetNotOffered.selector, address(weth), address(morphoVenue))
        );
        acct.execWithCallback(address(morphoVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(weth), 1e18)));

        // Accepted: the venue is re-checked at that moment (it lists WETH, LLTV 8600), then takes it.
        vm.warp(block.timestamp + 1);
        vm.prank(registryOwner);
        registry.acceptVenue(address(weth));
        assertEq(registry.venueOf(address(weth)), address(morphoVenue));
        _ownerExec(address(morphoVenue), abi.encodeCall(ICollateralVenue.supply, (address(weth), 1e18)));
        assertEq(morphoVenue.collateral(address(acct), address(weth)), 1e18);
        // And the old venue now refuses the same asset: one venue per asset, decided by the registry.
        weth.mint(address(acct), 1e18);
        vm.prank(alice);
        vm.expectRevert();
        acct.execWithCallback(address(aaveVenue), 0, abi.encodeCall(ICollateralVenue.supply, (address(weth), 1e18)));
    }

    /// The router resolves cbBTC to the Morpho venue after the switch, and its first-class hold
    /// path carries the same floor.
    function test_FIX_M5_openBorrowOnlyRunsThroughTheMorphoVenueWithTheSameFloor() public {
        uint256 offered = _usdc(PRICE_CBBTC_E8, registry.maxOfferedLtvBps(address(cbbtc)));
        bytes memory ret = _ownerExec(
            address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, offered, 3)))
        );
        uint256 hf = abi.decode(ret, (uint256));
        assertGe(hf, registry.entryHfFloorWad());
        assertEq(hf, morphoVenue.healthFactor(address(acct)), "the router reports the venue's number");
        assertEq(usdc.balanceOf(address(acct)), offered, "the borrowed USDC is in the account, undeployed");
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0, "nothing went to Aave");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(cbbtc.balanceOf(address(router)), 0);

        // The oversized borrow through the router is the VENUE's refusal.
        bytes memory data =
            abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, _usdc(PRICE_CBBTC_E8, 8000), 4)));
        vm.prank(alice);
        vm.expectPartialRevert(MorphoBlueVenue.EntryHfTooLow.selector);
        acct.execWithCallback(address(router), 0, data);
    }

    /// The web's exact protection grant (target = router, selector = unwind, USDC budget) works
    /// against the Morpho venue and is still bounded by its budget.
    function test_FIX_M6_theShippedKeeperGrantProtectsAMorphoPosition() public {
        uint256 offered = _usdc(PRICE_CBBTC_E8, 5000);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, offered, 5))));
        vm.prank(alice);
        acct.grant(
            keeper, _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 10_000e6), 0)
        );
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.repayAmount = 10_000e6;
        u.deadline = block.timestamp + 15 minutes;
        vm.prank(keeper);
        acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), offered - 10_000e6);
        assertGt(morphoVenue.healthFactor(address(acct)), 1.72e18);

        u.repayAmount = 1;
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));
    }

    // =====================================================================
    // Live parameters: nothing typed.
    // =====================================================================

    function test_FIX_M7_thresholdsAreTheMarketsNotAConstant() public {
        (,,,, uint256 lltv) = morpho.idToMarketParams(morphoVenue.marketIdOf(address(cbbtc)));
        assertEq(morphoVenue.liquidationThresholdBps(address(cbbtc)), lltv / 1e14);
        assertEq(morphoVenue.maxLtvBps(address(cbbtc)), lltv / 1e14);

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
        // The registry derives the offer from the live number: 77 % / 1.55 = 49.7 %, under the cap.
        vm.prank(registryOwner);
        registry.register(address(aero), address(other), address(0), true, "");
        assertEq(registry.maxOfferedLtvBps(address(aero)), 4967);
    }

    // =====================================================================
    // Documented residual and controls: the owner's rights, straight at Morpho.
    // =====================================================================

    /// Going straight to Morpho remains the account owner's right; nothing the product builds
    /// does this.
    function test_FIX_M8_rawMorphoCallsRemainTheOwnersRight() public {
        cbbtc.mint(address(acct), ONE_CBBTC);
        uint256 maxBorrow = _usdc(PRICE_CBBTC_E8, 8000);
        MarketParams memory p = _paramsCbbtc();
        vm.startPrank(alice);
        acct.exec(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (address(morpho), ONE_CBBTC)));
        acct.exec(address(morpho), 0, abi.encodeCall(IMorphoBlue.supplyCollateral, (p, ONE_CBBTC, address(acct), "")));
        acct.exec(
            address(morpho), 0, abi.encodeCall(IMorphoBlue.borrow, (p, maxBorrow, 0, address(acct), address(acct)))
        );
        vm.stopPrank();
        assertLt(morphoVenue.healthFactor(address(acct)), registry.entryHfFloorWad());
        assertEq(morphoVenue.debt(address(acct), address(usdc)), maxBorrow, "the venue still sees it honestly");
    }

    function test_FIX_M9_ownerStillExitsWhileEverythingElseIsBroken() public {
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 20_000e6, 6))));
        vm.warp(block.timestamp + 90 days);
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "paused by ops");
        engine.setPaused(true);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 1), 0));

        uint256 owed = morphoVenue.debt(address(acct), address(usdc));
        assertGt(owed, 20_000e6);
        usdc.mint(address(acct), owed - 20_000e6);
        (, uint128 shares,) = morpho.position(morphoVenue.marketIdOf(address(cbbtc)), address(acct));
        MarketParams memory p = _paramsCbbtc();
        vm.startPrank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(morpho), owed)));
        acct.exec(address(morpho), 0, abi.encodeCall(IMorphoBlue.repay, (p, 0, shares, address(acct), "")));
        acct.exec(
            address(morpho), 0, abi.encodeCall(IMorphoBlue.withdrawCollateral, (p, ONE_CBBTC, address(acct), alice))
        );
        vm.stopPrank();
        assertEq(cbbtc.balanceOf(alice), 10e8, "collateral fully recovered");
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(acct)), 0, "the venue's debt view was exact to the wei");
    }

    /// The venue's own exit path, on a disabled asset, through the router: never gated.
    function test_FIX_M10_theRouterUnwindsADisabledAssetOnMorpho() public {
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, 20_000e6, 8))));
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "paused by ops");
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](0);
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = type(uint256).max;
        u.deadline = block.timestamp + 15 minutes;
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(morphoVenue.debt(address(acct), address(usdc)), 0);
        assertEq(morphoVenue.collateral(address(acct), address(cbbtc)), 0);
        assertEq(cbbtc.balanceOf(address(acct)), ONE_CBBTC);
    }
}
