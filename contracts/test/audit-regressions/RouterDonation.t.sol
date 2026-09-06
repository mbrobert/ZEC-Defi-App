// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {ILpVenue} from "../../src/interfaces/ILpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";

/// @notice Harvested from wave-1 lens B (`test/poc/LensB_Router.t.sol`), expectations flipped to the
///         FIXED behaviour, attack setups intact.
///
///   B-CRIT-1  one base unit of USDC, from anybody, permanently bricked every open and every unwind
///             for every user, on an immutable contract with no rescue. The router's non-holder
///             claim is now a DELTA on each token it touches, so a donation is inert.
///   B-MED-2   the exit health-factor gate read ONE reserve while Aave nets all of them.
///   B-LOW-3   a fixed `repayAmount` against zero debt reverted the whole exit, collateral withdraw
///             included.
///   B-LOW-4   the venues never consulted the registry, so `enabled = false` was enforced only by
///             Aave's absence of a market.
contract RouterDonationRegressionTest is Fixture {
    uint256 constant COLLATERAL = 1e8; // 1 cbBTC ≈ $79,593.77
    uint256 constant BORROW = 30_000e6;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        weth.mint(address(aave), 1_000e18);
        aero.mint(address(engine), 1_000_000e18);
    }

    // --------------------------------------------------------------- helpers

    function _open(uint256 collateral, uint256 borrow, uint256 nonce)
        internal
        view
        returns (StrategyRouter.OpenParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 10 minutes,
            signature: collateral == 0
                ? bytes("")
                : _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
    }

    function _openViaAccount(StrategyRouter.OpenParams memory p) internal returns (uint256 id) {
        bytes memory ret =
            _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id,) = abi.decode(ret, (uint256, uint256));
    }

    function _unwind(uint256[] memory ids, uint256 repay, uint256 withdraw)
        internal
        view
        returns (StrategyRouter.UnwindParams memory u)
    {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({
            quotedIn: 1e18,
            quotedOut: 2453_450000,
            maxSlippageBps: 100,
            routeData: abi.encode(int24(100))
        });
        u.repayAmount = repay;
        u.withdrawAmount = withdraw;
        u.deadline = block.timestamp + 10 minutes;
    }

    function _idsOf(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    // =====================================================================
    // FIX B-1: the 1-wei donation is INERT
    // =====================================================================

    function test_FIX_B1_oneWeiDonationNoLongerBricksOpenOrUnwind() public {
        uint256 id = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        assertEq(usdc.balanceOf(address(router)), 0, "router starts empty");

        // THE ATTACK, unchanged: anybody transfers one base unit of USDC to the stateless router.
        usdc.mint(bob, 1);
        vm.prank(bob);
        usdc.transfer(address(router), 1);
        assertEq(usdc.balanceOf(address(router)), 1);

        // 1. a new position still opens.
        cbbtc.mint(address(acct), COLLATERAL);
        StrategyRouter.OpenParams memory p2 = _open(0, 10_000e6, 2);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p2)));

        // 2. the exit still works, in full.
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id, 2);
        StrategyRouter.UnwindParams memory u = _unwind(ids, type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "debt cleared");
        assertEq(cbbtc.balanceOf(address(acct)), 2 * COLLATERAL, "collateral home");

        // 3. the donation is still sitting there, untouched and harmless.
        assertEq(usdc.balanceOf(address(router)), 1, "the donation is inert, not fatal");
    }

    function test_FIX_B1b_collateralAssetDonationIsInertToo() public {
        cbbtc.mint(bob, 1);
        vm.prank(bob);
        cbbtc.transfer(address(router), 1);
        _openViaAccount(_open(COLLATERAL, BORROW, 1));
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW);
        assertEq(cbbtc.balanceOf(address(router)), 1);
    }

    function test_FIX_B1c_keeperProtectionGrantSurvivesTheSameOneWei() public {
        uint256 id = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        // The web's protection grant: keeper may only call StrategyRouter.unwind.
        TokenLimit[] memory lims = _limits2(address(usdc), 1_000_000e6, address(weth), 10e18);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, lims, 0));

        usdc.mint(bob, 1);
        vm.prank(bob);
        usdc.transfer(address(router), 1);

        Call[] memory calls = new Call[](1);
        StrategyRouter.UnwindParams memory u = _unwind(_idsOf(id), type(uint256).max, 0);
        calls[0] = _callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the protective unwind ran");
    }

    /// Fuzzed exactly as the PoC fuzzed it — over the whole borrow range and every dust size.
    function testFuzz_FIX_B9_anyDonationSizeIsInert(uint256 borrow, uint256 dust) public {
        borrow = bound(borrow, 1e6, 39_000e6);
        dust = bound(dust, 1, 1e12);
        uint256 id = _openViaAccount(_open(COLLATERAL, borrow, 1));
        usdc.mint(bob, dust);
        vm.prank(bob);
        usdc.transfer(address(router), dust);
        StrategyRouter.UnwindParams memory u = _unwind(_idsOf(id), type(uint256).max, 0);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(usdc.balanceOf(address(router)), dust, "still exactly the donation");
    }

    /// …and the delta assertion is NOT vacuous. A donation before the call is inert; a token that
    /// actually sticks to the router DURING the call still reverts, and with the real numbers.
    /// `LeakyAccount` is the only way to reach that state — the router is never a token recipient in
    /// any real flow, which is exactly the property being asserted.
    function test_FIX_B1d_aRouterThatGainsATokenMidCallStillReverts() public {
        LeakyAccount leaky = new LeakyAccount(address(router), address(usdc), alice);
        usdc.mint(address(leaky), 10e6);
        // Donate first, so the test also proves the delta is measured from the ENTRY balance and
        // not from zero: the revert names 7 → 8, not 0 → 1.
        usdc.mint(bob, 7);
        vm.prank(bob);
        usdc.transfer(address(router), 7);

        StrategyRouter.UnwindParams memory u = _unwind(new uint256[](0), 0, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyRouter.RouterBalanceChanged.selector, address(usdc), 7, 8)
        );
        leaky.callUnwind(u);
    }

    // =====================================================================
    // FIX B-4: the exit floor reads the GLOBAL health factor
    // =====================================================================

    function test_FIX_B4_exitFloorHoldsWhenTheResidualDebtIsNotUsdc() public {
        cbbtc.mint(address(acct), COLLATERAL);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), COLLATERAL)));
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 20_000e6)));
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(weth), 5e18)));

        uint256[] memory none = new uint256[](0);
        // Clear ALL the USDC debt and withdraw 0.2 cbBTC in one call. The USDC debt is gone, so the
        // old per-asset gate disabled itself and the account came out at HF 1.35 against a 1.55
        // floor, silently. The gate is global now.
        // 1 cbBTC at $79,593.77 and LT 7800 is $62,083 of borrowing power; 5 WETH at $2,453.45 is
        // $12,267 of residual debt. Withdrawing 0.75 cbBTC leaves HF 1.265 — comfortably above
        // Aave's own HF-1 refusal, and squarely below the 1.55 floor the product advertises. That
        // is exactly the band the old per-asset gate let a user walk out into, silently.
        StrategyRouter.UnwindParams memory u = _unwind(none, type(uint256).max, 0.75e8);
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectPartialRevert(StrategyRouter.ExitHfTooLow.selector);
        acct.execWithCallback(address(router), 0, data);
        assertEq(cbbtc.balanceOf(address(acct)), 0, "atomic: no collateral left the venue");

        // A withdrawal that keeps the GLOBAL health factor at or above the floor still passes.
        u = _unwind(none, type(uint256).max, 0.05e8);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertGe(aaveVenue.healthFactor(address(acct)), registry.entryHfFloorWad());
    }

    // =====================================================================
    // FIX B-11: a fixed repay against zero debt is a no-op, not a revert
    // =====================================================================

    function test_FIX_B11_fixedRepayAgainstZeroDebtDoesNotKillTheExit() public {
        cbbtc.mint(address(acct), COLLATERAL);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), COLLATERAL)));
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), 10_000e6)));
        uint256[] memory none = new uint256[](0);

        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (_unwind(none, type(uint256).max, 0))));
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);

        // The racing second exit: a FIXED repay against a debt that is already zero. It used to
        // revert `NothingToRepay` and take the collateral withdraw with it.
        bytes memory ret = _ownerExec(
            address(router), abi.encodeCall(StrategyRouter.unwind, (_unwind(none, 1e6, COLLATERAL)))
        );
        (, uint256 repaid, uint256 withdrawn,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, 0, "nothing to repay is a no-op");
        assertEq(withdrawn, COLLATERAL, "and the withdraw still happened");
        assertEq(cbbtc.balanceOf(address(acct)), COLLATERAL, "collateral is out of Aave");
    }

    // =====================================================================
    // FIX B-7: the venue consults the registry, so `enabled = false` holds
    // =====================================================================

    function test_FIX_B7_cbzecStaysOutEvenAfterAaveListsIt() public {
        cbzec.mint(address(acct), 100e8);
        // Aave lists cbZEC — the exact day the registry flag has to do the work on its own.
        aave.setReserve(address(cbzec), 5000, 6000, 1000, true, false, 1020_00000000, 0);
        assertFalse(registry.isEnabled(address(cbzec)), "registry says DISABLED");

        // The direct venue call used to succeed here. It no longer does.
        bytes memory data = abi.encodeCall(ICollateralVenue.supply, (address(cbzec), 1e8));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AaveV3Venue.AssetNotOffered.selector, address(cbzec), address(aaveVenue))
        );
        acct.execWithCallback(address(aaveVenue), 0, data);
        assertEq(aaveVenue.collateral(address(acct), address(cbzec)), 0, "nothing supplied");

        // The router refuses it too, with the note the user is shown.
        StrategyRouter.OpenParams memory p = _open(0, 1_000e6, 1);
        p.collateralAsset = address(cbzec);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyRouter.AssetDisabled.selector, address(cbzec), "no collateral market on Base yet"
            )
        );
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));

        // Once the registry enables it, the same call works — the flag is the gate, not Aave.
        vm.prank(registryOwner);
        registry.setEnabled(address(cbzec), true, "");
        _ownerExec(address(aaveVenue), data);
        assertEq(aaveVenue.collateral(address(acct), address(cbzec)), 1e8);
    }

    /// The owner's exit is never gated by any of this: a raw `exec` to Aave still works when the
    /// asset is disabled, exactly as before.
    function test_FIX_B7b_theExitIsNeverGatedByTheRegistry() public {
        cbbtc.mint(address(acct), COLLATERAL);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), COLLATERAL)));
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "delisted");
        _ownerExec(
            address(aaveVenue),
            abi.encodeCall(ICollateralVenue.withdraw, (address(cbbtc), type(uint256).max))
        );
        assertEq(cbbtc.balanceOf(address(acct)), COLLATERAL);
    }
}

/// @notice An "account" that leaks one base unit of USDC to the router on every nested call. Nothing
///         in the product can do this — the router is never a token recipient — so it is the only
///         way to prove the delta assertion actually fires.
contract LeakyAccount {
    address public immutable ROUTER;
    address public immutable TOKEN;
    address public immutable OWNER;

    constructor(address router_, address token_, address owner_) {
        ROUTER = router_;
        TOKEN = token_;
        OWNER = owner_;
    }

    function owner() external view returns (address) {
        return OWNER;
    }

    function callUnwind(StrategyRouter.UnwindParams calldata p) external {
        StrategyRouter(ROUTER).unwind(p);
    }

    function execFromPeripheral(Call[] calldata calls) external returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].data);
            require(ok, "inner");
            results[i] = ret;
        }
    }

    function execNestedPeripheral(address peripheral, uint256, bytes calldata data)
        external
        returns (bytes memory)
    {
        IERC20(TOKEN).transfer(ROUTER, 1); // the leak
        (bool ok, bytes memory ret) = peripheral.call(data);
        require(ok, "nested");
        return ret;
    }
}
