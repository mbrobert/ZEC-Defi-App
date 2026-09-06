// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Handler} from "./Handler.sol";

/// @title Invariants — properties that MUST hold in every reachable state (spec item 8).
///
///   1. The user can always exit via raw `exec`, whatever the router / venue / registry / grant
///      state (probed under snapshot after random sequences).
///   2. A keeper can never exceed a grant: no un-granted call ever succeeds, budgets are never
///      overspent, and the keeper never ends up holding a token.
///   3. The fee never touches principal: the treasury never holds more than performanceBps of
///      the yield the engine actually paid out.
///   4. The router (and every venue / adapter) holds zero balance after every call.
contract InvariantsTest is Fixture {
    Handler handler;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        handler = new Handler(
            acct,
            aaveVenue,
            lpVenue,
            registry,
            router,
            swapAdapter,
            aave,
            engine,
            poolWethUsdc,
            [usdc, weth, cbbtc, aero],
            POOL_WETH_USDC,
            [alice, keeper, registryOwner, treasury]
        );
        handler.grantKeeper();

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = Handler.supplyAndBorrow.selector;
        sel[1] = Handler.openLp.selector;
        sel[2] = Handler.accrueYield.selector;
        sel[3] = Handler.ownerClaim.selector;
        sel[4] = Handler.ownerCloseOne.selector;
        sel[5] = Handler.keeperUnwind.selector;
        sel[6] = Handler.keeperAttack.selector;
        sel[7] = Handler.rekey.selector;
        sel[8] = Handler.toggleAsset.selector;
        sel[9] = Handler.revokeAll.selector;
        sel[10] = Handler.regrant.selector;
        sel[11] = Handler.warp.selector;
        sel[12] = Handler.glitchEnumeration.selector;
        sel[13] = Handler.rawExitProbe.selector;
        sel[14] = Handler.ownerExit.selector;
        sel[15] = Handler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function invariant_userCanAlwaysExitViaExec() public view {
        assertFalse(handler.g_exitProbeFailed(), "raw owner exit failed in some state");
    }

    function invariant_keeperNeverExceedsGrant() public view {
        assertFalse(handler.g_keeperUngrantedSucceeded(), "an un-granted keeper call succeeded");
        (uint256 limitU, uint256 spentU) =
            acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(usdc));
        (uint256 limitW, uint256 spentW) =
            acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(weth));
        assertLe(spentU, limitU, "USDC budget overspent");
        assertLe(spentW, limitW, "WETH budget overspent");
        assertEq(usdc.balanceOf(keeper), 0, "keeper holds USDC");
        assertEq(weth.balanceOf(keeper), 0, "keeper holds WETH");
        assertEq(cbbtc.balanceOf(keeper), 0, "keeper holds cbBTC");
        assertEq(aero.balanceOf(keeper), 0, "keeper holds AERO");
        assertEq(aaveVenue.collateral(keeper, address(cbbtc)), 0);
    }

    function invariant_feeNeverTouchesPrincipal() public view {
        assertLe(usdc.balanceOf(treasury), (handler.g_yieldUsdc() * PERF_BPS) / 10_000, "USDC fee > 10% of yield");
        assertLe(weth.balanceOf(treasury), (handler.g_yieldWeth() * PERF_BPS) / 10_000, "WETH fee > 10% of yield");
        assertLe(aero.balanceOf(treasury), (handler.g_yieldAero() * PERF_BPS) / 10_000, "AERO fee > 10% of yield");
        assertEq(cbbtc.balanceOf(treasury), 0, "collateral is never yield");
    }

    /// A peripheral never ACQUIRES a balance: whatever it holds is exactly what was donated to it
    /// from outside. Asserting an absolute zero here is what let B-CRIT-1 pass — the handler had no
    /// action that could transfer a token to a peripheral, so the vacuous assertion looked strong
    /// while one base unit of USDC would have bricked the protocol for everyone, permanently.
    function invariant_peripheralsAcquireNothing() public view {
        address[4] memory peripherals = [address(router), address(aaveVenue), address(lpVenue), address(swapAdapter)];
        MockERC20[4] memory toks = [usdc, weth, cbbtc, aero];
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 4; j++) {
                assertEq(
                    toks[j].balanceOf(peripherals[i]),
                    handler.g_donated(peripherals[i], address(toks[j])),
                    "peripheral acquired a balance of its own"
                );
            }
            assertEq(peripherals[i].balance, 0);
        }
    }

    /// …and a donation is INERT: after any sequence that includes donations, the owner can still
    /// exit and the keeper can still run its protective unwind. (`g_exitProbeFailed` covers the
    /// exit; this asserts the donations actually happened, so the property is not vacuous.)
    function invariant_donationsDoNotBrickTheProtocol() public view {
        assertFalse(handler.g_exitProbeFailed(), "a donation broke the owner exit");
    }

    function invariant_noStandingAllowances() public view {
        address[3] memory spenders = [address(aave), address(engine), address(aeroRouter)];
        MockERC20[3] memory toks = [usdc, weth, cbbtc];
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 3; j++) {
                assertEq(toks[j].allowance(address(acct), spenders[i]), 0, "allowance left behind");
            }
        }
    }

    function invariant_callSummary() public view {
        // coverage only: surfaces in -vvv
        handler.g_calls();
    }

    /// The handler's paths are live (so the invariants above are not vacuous): a keeper unwind
    /// succeeds inside its grant, the raw-exit probe runs against real positions, and an attack
    /// is refused.
    function test_handlerPathsAreLive() public {
        handler.supplyAndBorrow(1e8, 4000);
        assertGt(aaveVenue.debt(address(acct), address(usdc)), 0);
        handler.openLp(type(uint256).max);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1);
        handler.accrueYield(0, 1_000e6, 0.1e18, 5e18);
        handler.keeperAttack(0, 1);
        handler.keeperAttack(2, 1);
        assertFalse(handler.g_keeperUngrantedSucceeded());
        handler.keeperUnwind(5_000e6);
        assertEq(handler.g_keeperUnwinds(), 1, "keeper unwind must succeed within its grant");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        assertGt(usdc.balanceOf(treasury), 0, "fee was taken on the yield");
        // One base unit at the router: the old absolute assertion made this a permanent,
        // protocol-wide brick. It must now be completely inert.
        handler.donate(0, 1);
        assertEq(usdc.balanceOf(address(router)), 1);
        handler.supplyAndBorrow(1e8, 4000);
        handler.openLp(type(uint256).max);
        handler.keeperUnwind(5_000e6);
        assertEq(handler.g_keeperUnwinds(), 2, "keeper unwind still works with a donated router");
        handler.glitchEnumeration(true);
        handler.toggleAsset(false);
        handler.revokeAll();
        handler.openLp(type(uint256).max);
        handler.rawExitProbe();
        assertEq(handler.g_exitProbes(), 1);
        assertFalse(handler.g_exitProbeFailed(), "raw exit must succeed with a glitching engine, a disabled asset and no grants");
        // state was restored by the probe's snapshot
        assertGt(aaveVenue.debt(address(acct), address(usdc)), 0);
    }
}
