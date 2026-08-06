// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {RewardRouter} from "../../src/RewardRouter.sol";
import {SnuggleAdapter} from "../../src/adapters/SnuggleAdapter.sol";
import {LpParams} from "../../src/interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fork tests against the LIVE MaxFi/Snuggle engine on Base mainnet.
///         Validates that ISnuggleVault matches deployed bytecode and that our
///         full deposit → withdraw path works against the real thing.
///
/// Run:  FORK_URL=<base rpc> forge test --match-contract EngineForkTest -vv
/// Skipped automatically when FORK_URL is unset.
contract EngineForkTest is Test {
    ISnuggleVault constant ENGINE =
        ISnuggleVault(0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55);

    // From our on-chain registry enumeration (2026-08-06):
    bytes32 constant POOL_AERO_WETH_USDC =
        0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8;
    bytes32 constant POOL_UNI_WETH_USDC =
        0x12fc2fd09d3d3bfeca3b2a731167f3740c3a543755afa8d0d93fd95889e41796;
    bytes32 constant POOL_UNI_USDC_CBBTC =
        0xb1830be2f9077713501ee7b52c92f6c8307ea8ceb16309d1f7fb1ad2643837e6;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    bool forked;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;

        vault = new PositionVault(admin);
        router = new RewardRouter(admin, vault);
        adapter = new SnuggleAdapter(address(vault), ENGINE, admin, admin);
        vm.startPrank(admin);
        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(USDC, true);
        vault.setRewardRouter(address(router));
        router.setOperator(operator, true);
        router.setMaxRoutePerTx(USDC, 25_000e6);
        vm.stopPrank();
    }

    modifier onlyForked() {
        if (!forked) {
            console2.log("SKIP: FORK_URL not set");
            return;
        }
        _;
    }

    /// ABI check: approvedPools getter layout matches deployed bytecode.
    function test_fork_registryLayout() public onlyForked {
        (address pool, address t0, address t1, uint24 fee,, bool active,,) =
            ENGINE.approvedPools(POOL_AERO_WETH_USDC);
        console2.log("pool", pool);
        console2.log("t0  ", t0);
        console2.log("t1  ", t1);
        console2.log("fee ", fee);
        assertTrue(active, "pool inactive");
        assertTrue(t0 == USDC || t1 == USDC, "USDC not in pool");
        assertTrue(t0 == WETH || t1 == WETH, "WETH not in pool");
        assertEq(pool, 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59, "unexpected pool addr");
    }

    /// ABI check: positions getter (17-field flattened struct) decodes.
    function test_fork_positionsGetterLayout() public onlyForked {
        // tokenId 1 may or may not exist; the call must not revert either way.
        (, bytes32 poolId, address owner,,,,,,,,,,,,,,) = ENGINE.positions(1);
        console2.log("positions(1) owner", owner);
        console2.logBytes32(poolId);
    }

    /// The money test: full open → partial withdraw → full withdraw against
    /// the LIVE engine with real Uniswap/Aerodrome liquidity underneath.
    function test_fork_openWithdrawRoundTrip() public onlyForked {
        deal(USDC, address(vault), 1_000e6);

        LpParams memory p =
            LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});

        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL_AERO_WETH_USDC, USDC, 1_000e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        assertEq(adapter.tokenCount(id), 1);
        assertGt(vault.getPosition(id).shares, 0);
        console2.log("opened engine tokenId", adapter.tokenIdsOf(id, 0));

        // Engine flash-loan protection: MIN_POSITION_HOLD_TIME = 1 minute.
        // Warp targets derive from ONE timestamp read: via-IR legally CSEs
        // repeated block.timestamp reads (TIMESTAMP is tx-invariant in real
        // EVM), which silently no-ops a second warp(block.timestamp + x).
        // Root-caused on-fork 2026-08-06 (docs/AUDIT.md round 3).
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 2 minutes);

        // Partial 40% out — engine full-close + re-deposit path.
        vm.prank(alice);
        vault.withdraw(id, 4_000, alice, 0, 0);
        uint256 aliceUsdc = IERC20(USDC).balanceOf(alice);
        uint256 aliceWeth = IERC20(WETH).balanceOf(alice);
        console2.log("after 40%: USDC", aliceUsdc, "WETH", aliceWeth);
        assertGt(aliceUsdc + aliceWeth, 0, "nothing received");
        assertEq(adapter.tokenCount(id), 1, "no re-deposit happened");

        // The re-deposited position restarts the engine's 1-minute hold clock.
        vm.warp(t0 + 4 minutes);

        // Full exit.
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0);
        assertEq(adapter.tokenCount(id), 0);
        assertEq(vault.getPosition(id).shares, 0);
        console2.log(
            "final: USDC", IERC20(USDC).balanceOf(alice), "WETH", IERC20(WETH).balanceOf(alice)
        );
        // Round-trip loss must be bounded (engine fees/slippage only).
        assertGt(IERC20(USDC).balanceOf(alice), 900e6, "excessive round-trip loss");
    }

    /// Real-engine flash-loan guard: withdrawing before the 1-minute hold must
    /// revert, and succeed once it elapses. Confirms our adapter surfaces the
    /// engine revert rather than corrupting state.
    function test_fork_minimumHoldEnforced() public onlyForked {
        deal(USDC, address(vault), 500e6);
        LpParams memory p =
            LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});
        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL_AERO_WETH_USDC, USDC, 500e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        vm.prank(alice);
        vm.expectRevert(); // MinimumHoldTimeNotMet from the live engine
        vault.withdraw(id, 10_000, alice, 0, 0);

        vm.warp(block.timestamp + 61 seconds);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0);
        assertEq(adapter.tokenCount(id), 0);
        assertGt(IERC20(USDC).balanceOf(alice), 490e6);
    }

    /// Same round trip on a second real pool (Uniswap WETH/USDC) — proves the
    /// integration is not pool-specific.
    function test_fork_secondPoolRoundTrip() public onlyForked {
        deal(USDC, address(vault), 1_000e6);
        LpParams memory p =
            LpParams({rangeWidthBps: 1200, rebalanceDelay: 6 hours, autoCompound: false});
        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL_UNI_WETH_USDC, USDC, 1_000e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        vm.warp(block.timestamp + 2 minutes);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0);
        assertGt(IERC20(USDC).balanceOf(alice), 950e6, "second-pool loss too high");
    }

    /// Moderate-notional deposit (0.5% of pool TVL): round-trips within 1%.
    /// Confirms the re-deposit path does not amplify slippage at sane sizes.
    function test_fork_moderateDepositRoundTrip() public onlyForked {
        deal(USDC, address(vault), 50_000e6);
        LpParams memory p =
            LpParams({rangeWidthBps: 2000, rebalanceDelay: 12 hours, autoCompound: true});
        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL_AERO_WETH_USDC, USDC, 50_000e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        uint256 t0 = block.timestamp; // single read — see CSE note in openWithdrawRoundTrip
        vm.warp(t0 + 2 minutes);
        vm.prank(alice);
        vault.withdraw(id, 5_000, alice, 0, 0); // 50% partial → close + re-deposit
        vm.warp(t0 + 4 minutes); // clears the re-deposit's fresh 60s hold
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0);
        assertGt(IERC20(USDC).balanceOf(alice), 49_500e6, "moderate round-trip lost >1%");
    }

    /// FORK-PROVEN GUARD: an oversized deposit (large fraction of pool TVL, the
    /// exact case that incurred >1% price impact in testing) is rejected by the
    /// per-pool exposure cap before it can reach the engine — protecting users
    /// from taking a position too large to exit cleanly.
    function test_fork_exposureCapBlocksOversizedDeposit() public onlyForked {
        vm.prank(admin);
        vault.setMaxDepositPerPool(POOL_AERO_WETH_USDC, 100_000e6);
        deal(USDC, address(vault), 250_000e6);
        LpParams memory p =
            LpParams({rangeWidthBps: 2000, rebalanceDelay: 12 hours, autoCompound: true});
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector,
                POOL_AERO_WETH_USDC,
                250_000e6,
                100_000e6
            )
        );
        vault.openFor(
            alice, address(adapter), POOL_AERO_WETH_USDC, USDC, 250_000e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    /// Slippage floor against the LIVE engine: a withdrawal demanding more than
    /// the pool can return at that size reverts, protecting the user.
    function test_fork_withdrawSlippageFloor() public onlyForked {
        deal(USDC, address(vault), 1_000e6);
        LpParams memory p =
            LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});
        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL_AERO_WETH_USDC, USDC, 1_000e6, p,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        vm.warp(block.timestamp + 2 minutes);
        // Demand strictly more USDC than deposited — impossible, must revert.
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(id, 10_000, alice, 1_100e6, type(uint256).max);
    }
}
