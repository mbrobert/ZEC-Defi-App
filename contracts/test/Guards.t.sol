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

        // Deposit refunded 8.8e6 (88bps) as the position's idle; the engine
        // holds 991.2e6 and pays 3% less on close:
        // 991.2e6 * 0.97 + 8.8e6 = 970.264e6. A 990 floor must revert.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnuggleAdapter.SlippageExceeded.selector, 970_264_000, 0, 990e6, 0
            )
        );
        vault.withdraw(id, 10_000, alice, 990e6, 0, 0);

        // A realistic floor (≤ 970.264) passes.
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 970e6, 0, 0);
        assertEq(usdc.balanceOf(alice), 970_264_000);
    }

    function test_withdraw_zeroFloorAlwaysPasses() public {
        uint256 id = _open(1_000e6);
        engine.setWithdrawSlippageBps(500);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0); // no floor
        // 991.2e6 * 0.95 + 8.8e6 idle refund
        assertEq(usdc.balanceOf(alice), 950_440_000);
    }

    function test_withdraw_floorProtectsPartial() public {
        uint256 id = _open(1_000e6);
        engine.setWithdrawSlippageBps(200); // 2%
        // got = 991.2e6 * 0.98 + 8.8e6 = 980.176e6; 40% = 392.07e6 < 400e6 floor.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnuggleAdapter.SlippageExceeded.selector, 392_070_400, 0, 400e6, 0
            )
        );
        vault.withdraw(id, 4_000, alice, 400e6, 0, 0);
    }

    // ------------------------------------------------------- exposure cap

    function test_exposureCap_blocksOversizedOpen() public {
        vault.setMaxDepositPerPool(POOL, address(usdc), 10_000e6);
        usdc.mint(address(vault), 15_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector, POOL, address(usdc), 15_000e6, 10_000e6
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 15_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_exposureCap_accumulatesAcrossPositionsAndFrees() public {
        vault.setMaxDepositPerPool(POOL, address(usdc), 10_000e6);
        uint256 a = _open(6_000e6);
        assertEq(vault.poolExposure(POOL, address(usdc)), 6_000e6);

        // Second open of 5k would breach the 10k cap.
        usdc.mint(address(vault), 5_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector, POOL, address(usdc), 11_000e6, 10_000e6
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        // Withdraw frees the budget; the same second open now fits.
        vm.prank(alice);
        vault.withdraw(a, 10_000, alice, 0, 0, 0);
        assertEq(vault.poolExposure(POOL, address(usdc)), 0);

        vm.prank(operator);
        vault.openFor(
            alice, address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        assertEq(vault.poolExposure(POOL, address(usdc)), 5_000e6);
    }

    function test_exposureCap_zeroMeansUnlimited() public {
        // default 0 → no cap
        uint256 id = _open(10_000_000e6);
        assertEq(vault.poolExposure(POOL, address(usdc)), 10_000_000e6);
        assertTrue(vault.getPosition(id).active);
    }

    function test_poolTokensOf_exposedForUI() public {
        uint256 id = _open(1_000e6);
        (address t0, address t1) = adapter.poolTokensOf(id);
        assertEq(t0, address(usdc));
        assertEq(t1, address(weth));
    }
}
