// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {RewardRouter} from "../src/RewardRouter.sol";
import {SnuggleAdapter} from "../src/adapters/SnuggleAdapter.sol";
import {LpParams} from "../src/interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSnuggleVault} from "./mocks/MockSnuggleVault.sol";

contract RewardRouterTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 aero; // staking incentive token

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address intentsDeposit = makeAddr("one-click-deposit-addr");

    bytes32 constant POOL = keccak256("aero-usdc-weth-5");
    string constant ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";

    LpParams params = LpParams({rangeWidthBps: 150, rebalanceDelay: 2 hours, autoCompound: false});

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aero = new MockERC20("Aerodrome", "AERO", 18);

        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.addPool(POOL, makeAddr("pool"), address(usdc), address(weth), 500);
        adapter =
            new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), treasury, admin);
        router = new RewardRouter(admin, vault);

        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        vm.prank(admin);
        adapter.setRewardTokens(rts);

        vm.startPrank(admin);
        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setRewardRouter(address(router));
        router.setOperator(operator, true);
        router.setMaxRoutePerTx(address(usdc), 1_000e6);
        vm.stopPrank();
    }

    function _open(PositionVault.RewardPreference pref) internal returns (uint256 id) {
        usdc.mint(address(vault), 10_000e6);
        vm.prank(operator);
        id = vault.openFor(
            alice, address(adapter), POOL, address(usdc), 10_000e6, params, pref,
            pref == PositionVault.RewardPreference.SEND_TO_ZCASH ? ZADDR : ""
        );
    }

    function _accrueFees(uint256 vaultPosId, uint256 usdcFee, uint256 aeroFee) internal {
        uint256 engineId = adapter.tokenIdsOf(vaultPosId, 0);
        if (usdcFee > 0) {
            usdc.mint(address(engine), usdcFee);
            engine.setPendingFee(engineId, address(usdc), usdcFee);
        }
        if (aeroFee > 0) {
            aero.mint(address(engine), aeroFee);
            engine.setPendingFee(engineId, address(aero), aeroFee);
        }
    }

    // --------------------------------------------------------------- compound

    function test_compound_reinvestsMatchingToken() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 250e6, 0);

        uint256 sharesBefore = vault.getPosition(id).shares;

        vm.prank(operator);
        (uint256 amount, uint256 added) = router.compound(id);

        assertEq(amount, 250e6);
        assertEq(added, 250e6);
        assertEq(vault.getPosition(id).shares, sharesBefore + 250e6);
        assertEq(usdc.balanceOf(address(router)), 0); // nothing stranded
        assertEq(adapter.tokenCount(id), 2); // compounded as an added engine position
    }

    function test_compound_worksViaStakingClaimPath() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 100e6, 0);
        engine.setStaked(adapter.tokenIdsOf(id, 0), true);

        vm.prank(operator);
        (uint256 amount,) = router.compound(id);
        assertEq(amount, 100e6);
    }

    function test_compound_holdsUnmatchedTokens() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 100e6, 5e18);

        vm.prank(operator);
        router.compound(id);

        assertEq(aero.balanceOf(address(router)), 5e18);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_compound_revertsWhenNothingAccrued() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        vm.prank(operator);
        vm.expectRevert(RewardRouter.NothingClaimed.selector);
        router.compound(id);
    }

    function test_compound_onlyOperator() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        vm.expectRevert(RewardRouter.NotOperator.selector);
        router.compound(id);
    }

    // ----------------------------------------------------------- routeToZcash

    function test_routeToZcash_transfersToIntentsDepositAddress() public {
        uint256 id = _open(PositionVault.RewardPreference.SEND_TO_ZCASH);
        _accrueFees(id, 300e6, 0);
        bytes32 quoteHash = keccak256("quote:zec-delivery:1");

        vm.expectEmit(true, true, true, true, address(router));
        emit RewardRouter.RewardsRouted(id, address(usdc), 300e6, intentsDeposit, ZADDR, quoteHash);

        vm.prank(operator);
        uint256 routed = router.routeToZcash(id, intentsDeposit, quoteHash);

        assertEq(routed, 300e6);
        assertEq(usdc.balanceOf(intentsDeposit), 300e6);
    }

    function test_routeToZcash_wrongPreferenceReverts() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 300e6, 0);
        vm.prank(operator);
        vm.expectRevert(RewardRouter.WrongPreference.selector);
        router.routeToZcash(id, intentsDeposit, bytes32(0));
    }

    function test_routeToZcash_respectsPerTxCap_holdsRemainder() public {
        // Accrual above the per-tx cap must not deadlock the position (the
        // claim used to be rolled back atomically, forever): route the cap,
        // hold the remainder, route it on the next call.
        uint256 id = _open(PositionVault.RewardPreference.SEND_TO_ZCASH);
        _accrueFees(id, 5_000e6, 0);
        vm.prank(operator);
        uint256 routed = router.routeToZcash(id, intentsDeposit, bytes32(0));
        assertEq(routed, 1_000e6); // capped
        assertEq(usdc.balanceOf(intentsDeposit), 1_000e6);
        assertEq(router.unmatchedOf(id, address(usdc)), 4_000e6); // held for next tx
        assertEq(usdc.balanceOf(address(router)), 4_000e6);

        // Next route moves another cap's worth from the held remainder even
        // with nothing newly accrued...
        vm.prank(operator);
        routed = router.routeToZcash(id, intentsDeposit, bytes32(0));
        assertEq(routed, 1_000e6);
        assertEq(router.unmatchedOf(id, address(usdc)), 3_000e6);

        // ...and a raised cap clears the rest in one go.
        vm.prank(admin);
        router.setMaxRoutePerTx(address(usdc), 10_000e6);
        vm.prank(operator);
        routed = router.routeToZcash(id, intentsDeposit, bytes32(0));
        assertEq(routed, 3_000e6);
        assertEq(router.unmatchedOf(id, address(usdc)), 0);
        assertEq(usdc.balanceOf(intentsDeposit), 5_000e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_routeToZcash_disabledTokenReverts() public {
        uint256 id = _open(PositionVault.RewardPreference.SEND_TO_ZCASH);
        _accrueFees(id, 100e6, 0);
        vm.prank(admin);
        router.setMaxRoutePerTx(address(usdc), 0);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(RewardRouter.RoutingDisabled.selector, address(usdc))
        );
        router.routeToZcash(id, intentsDeposit, bytes32(0));
    }

    function test_routeToZcash_zeroDepositAddressReverts() public {
        uint256 id = _open(PositionVault.RewardPreference.SEND_TO_ZCASH);
        _accrueFees(id, 100e6, 0);
        vm.prank(operator);
        vm.expectRevert(RewardRouter.ZeroAddress.selector);
        router.routeToZcash(id, address(0), bytes32(0));
    }

    // ------------------------------------------------- unmatched-reward claim

    function test_claimUnmatched_positionOwnerRecoversHeldRewards() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 50e6, 7e18);
        vm.prank(operator);
        router.compound(id);
        assertEq(router.unmatchedOf(id, address(aero)), 7e18);

        // Only the POSITION owner may claim, and only to a real recipient.
        vm.prank(operator);
        vm.expectRevert(RewardRouter.NotPositionOwner.selector);
        router.claimUnmatched(id, address(aero), operator);
        vm.prank(alice);
        vm.expectRevert(RewardRouter.ZeroAddress.selector);
        router.claimUnmatched(id, address(aero), address(0));

        vm.prank(alice);
        uint256 amount = router.claimUnmatched(id, address(aero), alice);
        assertEq(amount, 7e18);
        assertEq(aero.balanceOf(alice), 7e18);
        assertEq(router.unmatchedOf(id, address(aero)), 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RewardRouter.NothingHeld.selector, id, address(aero))
        );
        router.claimUnmatched(id, address(aero), alice);
    }

    // ---------------------------------------------------------------- rescue

    function test_rescue_cannotTouchHeldUserRewards() public {
        uint256 id = _open(PositionVault.RewardPreference.COMPOUND);
        _accrueFees(id, 50e6, 7e18);
        vm.prank(operator);
        router.compound(id); // 7e18 AERO now held for alice

        // Held user rewards are out of the admin's reach...
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRouter.RescueExceedsUserHeld.selector, address(aero), 7e18, 0
            )
        );
        router.rescueToken(address(aero), admin, 7e18);

        // ...but a mistaken direct transfer (outside the accounting) is.
        aero.mint(address(router), 3e18);
        vm.prank(admin);
        router.rescueToken(address(aero), admin, 3e18);
        assertEq(aero.balanceOf(admin), 3e18);
        assertEq(router.unmatchedOf(id, address(aero)), 7e18); // untouched
    }

    function test_rescue_onlyOwner() public {
        vm.prank(operator);
        vm.expectRevert();
        router.rescueToken(address(aero), operator, 1);
    }
}
