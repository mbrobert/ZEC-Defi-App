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

contract PositionVaultTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant POOL = keccak256("aero-usdc-weth-5");
    string constant ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";

    LpParams params = LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.addPool(POOL, makeAddr("uni-pool"), address(usdc), address(weth), 500);
        adapter =
            new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), treasury, admin);
        router = new RewardRouter(admin, vault);

        vm.startPrank(admin);
        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setRewardRouter(address(router));
        router.setOperator(operator, true);
        router.setMaxRoutePerTx(address(usdc), 10_000e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------- open: openFor

    function test_openFor_usesBridgedVaultBalance() public {
        usdc.mint(address(vault), 5_000e6);

        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(p.shares, 5_000e6);
        assertEq(p.poolKey, POOL);
        assertTrue(p.active);
        assertEq(usdc.balanceOf(address(vault)), 0);
        // Engine refunds 88bps of the deposit in-tx (live behavior); the
        // refund stays attributed to the position as its idle balance.
        assertEq(usdc.balanceOf(address(engine)), 5_000e6 - 44e6);
        (uint256 idle0,) = adapter.idleOf(id);
        assertEq(idle0, 44e6);
        assertEq(adapter.tokenCount(id), 1);

        uint256[] memory ids = vault.positionsOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }

    function test_openFor_revertsWithoutIdleBalance() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.InsufficientIdleBalance.selector, address(usdc), 1e6, 0
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 1e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_openFor_onlyOperator() public {
        usdc.mint(address(vault), 1e6);
        vm.prank(bob);
        vm.expectRevert(PositionVault.NotOperator.selector);
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 1e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_openFor_requiresZcashAddrForSendPref() public {
        usdc.mint(address(vault), 1e6);
        vm.prank(operator);
        vm.expectRevert(PositionVault.ZcashAddressRequired.selector);
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 1e6, params,
            PositionVault.RewardPreference.SEND_TO_ZCASH, ""
        );
    }

    function test_openFor_rejectsUnlistedAdapterAndToken() public {
        usdc.mint(address(vault), 1e6);
        address rogue = makeAddr("rogue");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.AdapterNotAllowed.selector, rogue));
        vault.openFor(
            alice, rogue, POOL, address(usdc), 1e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        MockERC20 weird = new MockERC20("X", "X", 18);
        weird.mint(address(vault), 1e18);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.TokenNotAllowed.selector, address(weird))
        );
        vault.openFor(
            alice, address(adapter), POOL, address(weird), 1e18, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    // --------------------------------------------------------- open: openSelf

    function test_openSelf_pullsFromCaller() public {
        usdc.mint(alice, 2_000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e6);
        uint256 id = vault.openSelf(
            address(adapter), POOL, address(usdc), 2_000e6, params,
            PositionVault.RewardPreference.SEND_TO_ZCASH, ZADDR
        );
        vm.stopPrank();

        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.owner, alice);
        assertEq(p.zcashAddress, ZADDR);
        assertEq(usdc.balanceOf(alice), 0);
    }

    // -------------------------------------------------------------- lifecycle

    function _openAlice(uint256 amount) internal returns (uint256 id) {
        usdc.mint(address(vault), amount);
        vm.prank(operator);
        id = vault.openFor(
            alice, address(adapter), POOL, address(usdc), amount, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_increase_byOperatorFromVaultBalance() public {
        uint256 id = _openAlice(1_000e6);
        usdc.mint(address(vault), 500e6); // second bridge arrival
        vm.prank(operator);
        uint256 added = vault.increase(id, 500e6);
        assertEq(added, 500e6);
        assertEq(vault.getPosition(id).shares, 1_500e6);
        // engine holds a second position under the same vault positionId
        assertEq(adapter.tokenCount(id), 2);
    }

    function test_increase_byStrangerReverts() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(bob);
        vm.expectRevert(PositionVault.NotOperator.selector);
        vault.increase(id, 1e6);
    }

    function test_consolidate_operatorCollapsesAndKeepsShares() public {
        uint256 id = _openAlice(1_000e6);
        usdc.mint(address(vault), 500e6);
        vm.prank(operator);
        vault.increase(id, 500e6);
        assertEq(adapter.tokenCount(id), 2);

        // Operator increase/consolidate share a per-position cooldown (M-1:
        // each one restarts the engine's 60s hold clock).
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        uint256 count = vault.consolidate(id, 0);

        assertEq(count, 1);
        assertEq(adapter.tokenCount(id), 1);
        // Vault share bookkeeping stays in lockstep with the adapter principal.
        assertEq(vault.getPosition(id).shares, 1_500e6);
        assertEq(adapter.shares(id), 1_500e6);
    }

    function test_consolidate_onlyOperator() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(bob);
        vm.expectRevert(PositionVault.NotOperator.selector);
        vault.consolidate(id, 0);
    }

    function test_consolidate_revertsOnInactivePosition() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0); // fully close
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.PositionNotActive.selector, id));
        vault.consolidate(id, 0);
    }

    function test_withdraw_partialThenFull() public {
        uint256 id = _openAlice(1_000e6);

        // Partial 40%: engine closes the whole position, pays 40% of
        // EVERYTHING attributable to the position (engine holdings + the idle
        // deposit refund), re-deposits the rest.
        vm.prank(alice);
        vault.withdraw(id, 4_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 400e6);
        PositionVault.Position memory p = vault.getPosition(id);
        assertEq(p.shares, 600e6);
        assertTrue(p.active);
        assertEq(adapter.tokenCount(id), 1); // fresh re-deposited position
        // 600e6 kept, of which 88bps (5.28e6) refunded to idle by the engine.
        assertEq(usdc.balanceOf(address(engine)), 600e6 - 5_280_000);

        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        p = vault.getPosition(id);
        assertEq(p.shares, 0);
        assertFalse(p.active);
    }

    function test_withdraw_onlyOwner() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(bob);
        vm.expectRevert(PositionVault.NotPositionOwner.selector);
        vault.withdraw(id, 10_000, bob, 0, 0, 0);
    }

    function test_withdraw_worksWhilePaused() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(admin);
        vault.pause();

        usdc.mint(address(vault), 1e6);
        vm.prank(operator);
        vm.expectRevert();
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 1e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    function test_setRewardPreference() public {
        uint256 id = _openAlice(1_000e6);

        vm.prank(alice);
        vault.setRewardPreference(id, PositionVault.RewardPreference.SEND_TO_ZCASH, ZADDR);
        assertEq(
            uint8(vault.getPosition(id).rewardPref),
            uint8(PositionVault.RewardPreference.SEND_TO_ZCASH)
        );

        vm.prank(bob);
        vm.expectRevert(PositionVault.NotPositionOwner.selector);
        vault.setRewardPreference(id, PositionVault.RewardPreference.COMPOUND, "");

        vm.prank(alice);
        vm.expectRevert(PositionVault.ZcashAddressRequired.selector);
        vault.setRewardPreference(id, PositionVault.RewardPreference.SEND_TO_ZCASH, "");
    }

    function test_claimTo_onlyRewardRouter() public {
        uint256 id = _openAlice(1_000e6);
        vm.prank(operator);
        vm.expectRevert(PositionVault.NotRewardRouter.selector);
        vault.claimTo(id, operator);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_withdrawNeverExceedsDeposit(uint96 amount, uint16 bps) public {
        amount = uint96(bound(amount, 1e6, 1_000_000e6));
        bps = uint16(bound(bps, 1, 10_000));

        uint256 id = _openAlice(amount);
        vm.prank(alice);
        vault.withdraw(id, bps, alice, 0, 0, 0);

        assertLe(usdc.balanceOf(alice), uint256(amount));
        // alice's payout + engine custody + the position's idle refund balance
        // == original deposit (nothing minted, nothing stranded)
        (uint256 idle0,) = adapter.idleOf(id);
        assertEq(
            usdc.balanceOf(alice) + usdc.balanceOf(address(engine)) + idle0, uint256(amount)
        );
    }
}
