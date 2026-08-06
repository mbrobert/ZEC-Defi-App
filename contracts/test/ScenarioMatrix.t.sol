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

/// @title ScenarioMatrix — deterministic enumeration of user-selectable
///        combinations. Complements the random invariant fuzzing with a named,
///        exhaustive cross-product so every documented option is exercised at
///        least once and value conservation is asserted per scenario.
///
/// Dimensions (all user-controllable):
///   pool (3) × rangeWidth (5) × rebalanceDelay (2) × rewardPref (2)
///   × depositSize (3) × withdrawalPattern (3)  =  540 scenarios.
contract ScenarioMatrixTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 aero;

    address admin = address(this);
    address operator = makeAddr("operator");
    address user = makeAddr("user");
    address constant INTENTS = 0x00000000000000000000000000000000DeaDBeef;
    string constant ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";

    bytes32[3] pools;
    uint24[5] ranges = [uint24(10), 150, 800, 2500, 5000];
    uint64[2] delays = [uint64(0), 7 days];
    uint256[3] sizes = [uint256(1e6), 25_000e6, 1_000_000e6];

    // ghost conservation totals
    uint256 gDep;
    uint256 gFees;
    uint256 gUsers;
    uint256 gIntents;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aero = new MockERC20("Aerodrome", "AERO", 18);
        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.setMinHoldTime(60);
        adapter = new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), admin, admin);
        router = new RewardRouter(admin, vault);

        pools[0] = keccak256("A");
        pools[1] = keccak256("B");
        pools[2] = keccak256("C");
        for (uint256 i = 0; i < 3; i++) {
            engine.addPool(pools[i], address(uint160(uint256(pools[i]))), address(usdc), address(weth), 500);
        }
        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        adapter.setRewardTokens(rts);

        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setRewardRouter(address(router));
        router.setOperator(operator, true);
        router.setMaxRoutePerTx(address(usdc), type(uint256).max);
    }

    function test_matrix_allUserSelectionCombos() public {
        uint256 scenarios;
        for (uint256 pi = 0; pi < 3; pi++) {
            for (uint256 ri = 0; ri < 5; ri++) {
                for (uint256 di = 0; di < 2; di++) {
                    for (uint256 pref = 0; pref < 2; pref++) {
                        for (uint256 si = 0; si < 3; si++) {
                            for (uint256 wp = 0; wp < 3; wp++) {
                                _runScenario(pi, ri, di, pref == 0, si, wp);
                                _assertConservation();
                                scenarios++;
                            }
                        }
                    }
                }
            }
        }
        assertEq(scenarios, 540, "scenario count");
        emit log_named_uint("scenarios exercised", scenarios);
    }

    function _runScenario(uint256 pi, uint256 ri, uint256 di, bool send, uint256 si, uint256 wp)
        internal
    {
        uint256 amt = sizes[si];
        LpParams memory p =
            LpParams({rangeWidthBps: ranges[ri], rebalanceDelay: delays[di], autoCompound: (wp & 1) == 0});

        usdc.mint(address(vault), amt);
        vm.prank(operator);
        uint256 id = vault.openFor(
            user, address(adapter), pools[pi], address(usdc), amt, p,
            send ? PositionVault.RewardPreference.SEND_TO_ZCASH : PositionVault.RewardPreference.COMPOUND,
            send ? ZADDR : ""
        );
        gDep += amt;

        // Accrue a fee proportional to size, plus a non-matching incentive.
        uint256 fee = amt / 100;
        if (fee > 0) {
            uint256 eid = adapter.tokenIdsOf(id, 0);
            usdc.mint(address(engine), fee);
            engine.setPendingFee(eid, address(usdc), fee);
            aero.mint(address(engine), 1e18);
            engine.setPendingFee(eid, address(aero), 1e18);
            gFees += fee;
        }

        // Realize the reward per preference.
        if (send && fee > 0) {
            uint256 b = usdc.balanceOf(INTENTS);
            vm.prank(operator);
            router.routeToZcash(id, INTENTS, keccak256(abi.encode(id)));
            gIntents += usdc.balanceOf(INTENTS) - b;
        } else if (fee > 0) {
            vm.prank(operator);
            router.compound(id);
        }

        // Withdrawal pattern.
        vm.warp(block.timestamp + 61);
        uint256 before = usdc.balanceOf(user);
        if (wp == 0) {
            vm.prank(user);
            vault.withdraw(id, 10_000, user, 0, 0);
        } else if (wp == 1) {
            vm.prank(user);
            vault.withdraw(id, 5_000, user, 0, 0);
            vm.warp(block.timestamp + 61);
            vm.prank(user);
            vault.withdraw(id, 10_000, user, 0, 0);
        } else {
            vm.prank(user);
            vault.withdraw(id, 2_500, user, 0, 0);
            vm.warp(block.timestamp + 61);
            vm.prank(user);
            vault.withdraw(id, 3_333, user, 0, 0);
            vm.warp(block.timestamp + 61);
            vm.prank(user);
            vault.withdraw(id, 10_000, user, 0, 0);
        }
        gUsers += usdc.balanceOf(user) - before;

        // Position fully closed at the end of every scenario.
        assertFalse(vault.getPosition(id).active, "position not closed");
        assertEq(adapter.tokenCount(id), 0, "engine positions leaked");
    }

    function _assertConservation() internal view {
        uint256 held = usdc.balanceOf(address(engine)) + usdc.balanceOf(address(router))
            + usdc.balanceOf(address(vault)) + usdc.balanceOf(address(adapter));
        assertEq(held + gUsers + gIntents, gDep + gFees, "conservation");
        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter dust");
        assertEq(usdc.balanceOf(address(vault)), 0, "vault dust");
    }
}
