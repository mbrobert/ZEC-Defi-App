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

/// @notice Tests for the anti-MEV / risk guards added in v0.5:
///   • withdrawal slippage floor (minOut) — protects against sandwiching the
///     engine close/re-deposit and against deep price impact on large exits;
///   • per-pool exposure cap — bounds concentration so no single position can
///     be a large enough fraction of a pool to eat outsized slippage.
contract GuardsTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;

    address admin = address(this);
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    bytes32 constant POOL = keccak256("aero-usdc-weth-5");

    LpParams params = LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.addPool(POOL, makeAddr("pool"), address(usdc), address(weth), 500);
        adapter = new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), admin, admin);
        router = new RewardRouter(admin, vault);
        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setRewardRouter(address(router));
    }

    function _open(uint256 amt) internal returns (uint256 id) {
        usdc.mint(address(vault), amt);
        vm.prank(operator);
        id = vault.openFor(
            alice, address(adapter), POOL, address(usdc), amt, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    // --------------------------------------------------------- slippage floor

    function test_withdraw_slippageFloorReverts() public {
        uint256 id = _open(1_000e6);
        engine.setWithdrawSlippageBps(300); // 3% price impact on exit

        // Full exit expects ~1000 USDC; a 990 floor (1% tolerance) must revert
        // because the engine only returns 970.
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(id, 10_000, alice, 990e6, 0);

        // A realistic floor (≤ 970) passes.
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 970e6, 0);
        assertEq(usdc.balanceOf(alice), 970e6);
    }

    function test_withdraw_zeroFloorAlwaysPasses() public {
        uint256 id = _open(1_000e6);
        engine.setWithdrawSlippageBps(500);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0); // no floor
        assertEq(usdc.balanceOf(alice), 950e6);
    }

    function test_withdraw_floorProtectsPartial() public {
        uint256 id = _open(1_000e6);
        engine.setWithdrawSlippageBps(200); // 2%
        // 40% of 1000 = 400 nominal; engine returns 392. Floor of 400 reverts.
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(id, 4_000, alice, 400e6, 0);
    }

    // ------------------------------------------------------- exposure cap

    function test_exposureCap_blocksOversizedOpen() public {
        vault.setMaxDepositPerPool(POOL, 10_000e6);
        usdc.mint(address(vault), 15_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector, POOL, 15_000e6, 10_000e6
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 15_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_exposureCap_accumulatesAcrossPositionsAndFrees() public {
        vault.setMaxDepositPerPool(POOL, 10_000e6);
        uint256 a = _open(6_000e6);
        assertEq(vault.poolExposure(POOL), 6_000e6);

        // Second open of 5k would breach the 10k cap.
        usdc.mint(address(vault), 5_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector, POOL, 11_000e6, 10_000e6
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        // Withdraw frees the budget; the same second open now fits.
        vm.prank(alice);
        vault.withdraw(a, 10_000, alice, 0, 0);
        assertEq(vault.poolExposure(POOL), 0);

        vm.prank(operator);
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        assertEq(vault.poolExposure(POOL), 5_000e6);
    }

    function test_exposureCap_zeroMeansUnlimited() public {
        // default 0 → no cap
        uint256 id = _open(10_000_000e6);
        assertEq(vault.poolExposure(POOL), 10_000_000e6);
        assertTrue(vault.getPosition(id).active);
    }

    function test_poolTokensOf_exposedForUI() public {
        uint256 id = _open(1_000e6);
        (address t0, address t1) = adapter.poolTokensOf(id);
        assertEq(t0, address(usdc));
        assertEq(t1, address(weth));
    }
}
