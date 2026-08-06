// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SnuggleAdapter} from "../src/adapters/SnuggleAdapter.sol";
import {LpParams} from "../src/interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../src/interfaces/ISnuggleVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSnuggleVault} from "./mocks/MockSnuggleVault.sol";

/// @notice Adapter-level tests for the engine-reality translations:
///         multi-tokenId increase, close-and-reopen partial withdraw,
///         staked vs unstaked claims, and engine-tracked range status.
contract SnuggleAdapterTest is Test {
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;

    address vault = makeAddr("vault"); // adapter trusts only this caller
    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address recipient = makeAddr("recipient");

    bytes32 constant POOL = keccak256("uni-usdc-weth-5");

    LpParams params = LpParams({rangeWidthBps: 800, rebalanceDelay: 12 hours, autoCompound: true});

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        engine = new MockSnuggleVault();
        engine.addPool(POOL, makeAddr("pool"), address(usdc), address(weth), 500);
        adapter = new SnuggleAdapter(vault, ISnuggleVault(address(engine)), treasury, admin);
    }

    function _fundVaultAndApprove(uint256 amount) internal {
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.approve(address(adapter), amount);
    }

    function _open(uint256 positionId, uint256 amount) internal {
        _fundVaultAndApprove(amount);
        vm.prank(vault);
        adapter.open(positionId, POOL, address(usdc), amount, params);
    }

    function test_onlyVaultGuards() public {
        vm.expectRevert(SnuggleAdapter.OnlyVault.selector);
        adapter.open(1, POOL, address(usdc), 1e6, params);
        vm.expectRevert(SnuggleAdapter.OnlyVault.selector);
        adapter.withdraw(1, 10_000, recipient, 0, 0);
        vm.expectRevert(SnuggleAdapter.OnlyVault.selector);
        adapter.claim(1, recipient);
    }

    function test_open_rejectsInactivePoolAndForeignToken() public {
        _fundVaultAndApprove(1e6);

        MockERC20 dai = new MockERC20("DAI", "DAI", 18);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleAdapter.TokenNotInPool.selector, address(dai), POOL)
        );
        adapter.open(1, POOL, address(dai), 1e6, params);

        engine.setPoolActive(POOL, false);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(SnuggleAdapter.PoolInactive.selector, POOL));
        adapter.open(1, POOL, address(usdc), 1e6, params);
    }

    function test_increase_addsEngingPositionUnderSameId() public {
        _open(1, 1_000e6);
        assertEq(adapter.tokenCount(1), 1);
        assertEq(adapter.shares(1), 1_000e6);

        _fundVaultAndApprove(500e6);
        vm.prank(vault);
        uint256 added = adapter.increase(1, address(usdc), 500e6);

        assertEq(added, 500e6);
        assertEq(adapter.tokenCount(1), 2);
        assertEq(adapter.shares(1), 1_500e6);
    }

    function test_partialWithdraw_closesAllPaysShareRedeposits() public {
        _open(1, 1_000e6);
        _fundVaultAndApprove(500e6);
        vm.prank(vault);
        adapter.increase(1, address(usdc), 500e6); // two engine positions live

        vm.prank(vault);
        (address[] memory tokens, uint256[] memory amounts) =
            adapter.withdraw(1, 2_500, recipient, 0, 0); // 25%

        assertEq(tokens[0], address(usdc));
        assertEq(amounts[0], 375e6); // 25% of 1500
        assertEq(usdc.balanceOf(recipient), 375e6);
        assertEq(adapter.shares(1), 1_125e6);
        assertEq(adapter.tokenCount(1), 1); // consolidated into one fresh position
        assertEq(usdc.balanceOf(address(engine)), 1_125e6);
        assertEq(usdc.balanceOf(address(adapter)), 0); // never holds idle funds
    }

    function test_fullWithdraw_leavesNothingBehind() public {
        _open(1, 1_000e6);
        vm.prank(vault);
        adapter.withdraw(1, 10_000, recipient, 0, 0);

        assertEq(usdc.balanceOf(recipient), 1_000e6);
        assertEq(adapter.shares(1), 0);
        assertEq(adapter.tokenCount(1), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_claim_unstakedUsesHarvest_stakedUsesStakingClaim() public {
        _open(1, 1_000e6);
        uint256 engineId = adapter.tokenIdsOf(1, 0);

        // unstaked: harvest path
        usdc.mint(address(engine), 40e6);
        engine.setPendingFee(engineId, address(usdc), 40e6);
        vm.prank(vault);
        (, uint256[] memory amounts) = adapter.claim(1, recipient);
        assertEq(amounts[0], 40e6);
        assertEq(usdc.balanceOf(recipient), 40e6);

        // staked: claimStakingRewards path
        engine.setStaked(engineId, true);
        usdc.mint(address(engine), 25e6);
        engine.setPendingFee(engineId, address(usdc), 25e6);
        vm.prank(vault);
        adapter.claim(1, recipient);
        assertEq(usdc.balanceOf(recipient), 65e6);
    }

    function test_claim_sweepsConfiguredRewardTokens() public {
        MockERC20 aero = new MockERC20("Aerodrome", "AERO", 18);
        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        vm.prank(admin);
        adapter.setRewardTokens(rts);

        _open(1, 1_000e6);
        uint256 engineId = adapter.tokenIdsOf(1, 0);
        aero.mint(address(engine), 3e18);
        engine.setPendingFee(engineId, address(aero), 3e18);

        vm.prank(vault);
        (address[] memory tokens, uint256[] memory amounts) = adapter.claim(1, recipient);
        assertEq(tokens.length, 3); // token0, token1, AERO
        assertEq(tokens[2], address(aero));
        assertEq(amounts[2], 3e18);
        assertEq(aero.balanceOf(recipient), 3e18);
    }

    function test_inRange_reflectsEngineOutOfRangeSince() public {
        _open(1, 1_000e6);
        assertTrue(adapter.inRange(1));

        engine.setOutOfRangeSince(adapter.tokenIdsOf(1, 0), uint64(block.timestamp));
        assertFalse(adapter.inRange(1));
    }

    function test_setRewardTokens_onlyOwner() public {
        address[] memory rts = new address[](0);
        vm.expectRevert(SnuggleAdapter.OnlyOwner.selector);
        adapter.setRewardTokens(rts);
    }
}
