// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {RewardRouter} from "../../src/RewardRouter.sol";
import {SnuggleAdapter} from "../../src/adapters/SnuggleAdapter.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSnuggleVault} from "../mocks/MockSnuggleVault.sol";
import {Handler} from "./Handler.sol";

/// @title Invariants — properties that MUST hold in every reachable state.
///
/// Foundry drives Handler with random action sequences (runs × depth state
/// transitions, configured in foundry.toml). After each sequence, every
/// invariant_* here is asserted. A single violation across the whole search
/// space fails the suite.
contract InvariantsTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 aero;
    Handler handler;

    function setUp() public {
        address admin = address(this);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aero = new MockERC20("Aerodrome", "AERO", 18);

        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.setMinHoldTime(60); // exercise the real flash-loan guard
        adapter = new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), admin, admin);
        router = new RewardRouter(admin, vault);

        bytes32[3] memory pools;
        pools[0] = keccak256("pool-A");
        pools[1] = keccak256("pool-B");
        pools[2] = keccak256("pool-C");
        for (uint256 i = 0; i < 3; i++) {
            engine.addPool(pools[i], address(uint160(uint256(pools[i]))), address(usdc), address(weth), 500);
        }

        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        adapter.setRewardTokens(rts);

        vault.setOperator(address(0x0FE2), true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setRewardRouter(address(router));
        router.setOperator(address(0x0FE2), true);
        router.setMaxRoutePerTx(address(usdc), type(uint256).max);

        handler = new Handler(vault, router, adapter, engine, usdc, weth, aero, pools);

        // Grant the handler the roles it plays.
        vault.setOperator(address(handler), true);
        router.setOperator(address(handler), true);

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = Handler.deposit.selector;
        sel[1] = Handler.increase.selector;
        sel[2] = Handler.withdraw.selector;
        sel[3] = Handler.accrueFees.selector;
        sel[4] = Handler.compound.selector;
        sel[5] = Handler.routeToZcash.selector;
        sel[6] = Handler.changePref.selector;
        sel[7] = Handler.goOutOfRange.selector;
        sel[8] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// MASTER CONSERVATION: no USDC is created or destroyed. Every unit is
    /// either held somewhere in the system or was paid out to a user/intents.
    function invariant_usdcConservation() public view {
        uint256 held = usdc.balanceOf(address(engine)) + usdc.balanceOf(address(router))
            + usdc.balanceOf(address(vault)) + usdc.balanceOf(address(adapter));
        uint256 lhs = held + handler.g_paidToUsers() + handler.g_paidToIntents();
        uint256 rhs = handler.g_depositedExternal() + handler.g_feesMintedUsdc();
        assertEq(lhs, rhs, "USDC conservation broken");
    }

    /// The adapter is a pass-through: it must never hold idle funds between txs.
    function invariant_adapterHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter holds USDC");
        assertEq(weth.balanceOf(address(adapter)), 0, "adapter holds WETH");
        assertEq(aero.balanceOf(address(adapter)), 0, "adapter holds AERO");
    }

    /// The vault never holds idle principal between actions (funds go straight
    /// into the engine on open/increase; withdrawals pay the adapter→recipient).
    function invariant_vaultHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(vault)), 0, "vault holds idle USDC");
        assertEq(weth.balanceOf(address(vault)), 0, "vault holds idle WETH");
    }

    /// The matched (position) token is never stranded in the RewardRouter —
    /// compound re-deposits it, route sends it. Only non-matching incentive
    /// tokens (AERO) may accumulate pending a sweep.
    function invariant_routerNoMatchedToken() public view {
        assertEq(usdc.balanceOf(address(router)), 0, "USDC stuck in router");
    }

    /// active == (shares > 0) for every position ever opened.
    function invariant_activeFlag() public view {
        assertTrue(handler.activeFlagConsistent(), "active flag desynced");
    }

    /// Accounting shares can never exceed the money that entered the system
    /// (no share inflation / value creation).
    function invariant_noShareInflation() public view {
        assertLe(
            handler.sumActiveShares(),
            handler.g_depositedExternal() + handler.g_feesMintedUsdc(),
            "shares exceed money in"
        );
    }

    /// Users only ever get their own money back — the intents sink only grows
    /// from routed rewards, never from principal (bounded by fees minted).
    function invariant_intentsBoundedByFees() public view {
        assertLe(handler.g_paidToIntents(), handler.g_feesMintedUsdc(), "intents paid from principal");
    }

    function invariant_callSummary() public view {
        // Not an assertion — surfaces coverage in -vvv logs.
    }
}
