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
            morphoVenue,
            lpVenue,
            registry,
            router,
            swapAdapter,
            aave,
            engine,
            poolWethUsdc,
            [usdc, weth, cbbtc, aero],
            POOL_WETH_USDC,
            [alice, keeper, registryOwner, treasury],
            [address(directVenue), address(poolSwapAdapter), address(cbzec)],
            gaugeCbzec,
            npmCbzec
        );
        handler.grantKeeper();

        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](25);
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
        sel[16] = Handler.switchVenue.selector;
        sel[17] = Handler.routerExitProbe.selector;
        sel[18] = Handler.supplyAndBorrowOnCurrentVenue.selector;
        sel[19] = Handler.repayAcrossProbe.selector;
        sel[20] = Handler.singleCloseProbe.selector;
        // W3-MED-3 (2026-09-11): the direct Slipstream venue joins the surface.
        sel[21] = Handler.openDirectLp.selector;
        sel[22] = Handler.accrueDirectReward.selector;
        sel[23] = Handler.ownerCloseDirect.selector;
        sel[24] = Handler.keeperUnwindDirect.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function invariant_userCanAlwaysExitViaExec() public view {
        assertFalse(handler.g_exitProbeFailed(), "raw owner exit failed in some state");
    }

    /// The product's own exit — `StrategyRouter.unwind` — reaches the position whatever the
    /// registry points at: after a venue switch it used to resolve the new venue, repay nothing and
    /// succeed (audit wave 2, M-HIGH-1). The handler switches cbBTC between Aave and Morpho at
    /// random; the probe runs under a snapshot after any sequence.
    function invariant_userCanAlwaysExitViaRouter() public view {
        assertFalse(handler.g_routerExitProbeFailed(), "the router's unwind failed to reach the position in some state");
    }

    /// 2026-09-10 (slice 2): the repay leg reaches EVERY book. The handler can now open on the
    /// registry's current venue — Morpho, after its own test-only propose → warp → accept — while
    /// the Aave book is still open. After an owner `unwind(repay max)` with enough USDC to cover
    /// the account's debt on every venue the registry names for cbBTC, no venue (the pointer or a
    /// `previousVenues` entry) still owes USDC, or the call reverted with a named custom error.
    /// `RISKS.md` §8 residual (a): before this, `invariant_userCanAlwaysExitViaRouter` could not
    /// see a two-book account because no action put debt on the second book.
    function invariant_repayReachesEveryBook() public view {
        assertFalse(
            handler.g_repayAcrossFailed(),
            "a venue still owed USDC after unwind(repay max) with USDC to cover, or the unwind reverted without a name"
        );
    }

    /// Slice D (2026-09-10) recorded this as a KNOWN FAILURE waiting for its fix; slice F
    /// (2026-09-11) flipped it (`RISKS.md` §8 "two-book Close", option (1)). The web's Close is ONE
    /// `unwind(ids, repay max, withdraw max)`; on an account with collateral on both venues the
    /// withdraw leg now visits EVERY venue holding the account's collateral, so after that one call,
    /// funded with every book's debt, no venue the registry names for cbBTC still holds any — and
    /// the call never reverts on such an account, with one named exception: an id both LP venues
    /// claim is W3-LOW-1's `AmbiguousPositionId`, which the probe resolves the documented way (the
    /// direct twin closed through its own venue) before asking again (`g_singleCloseAmbiguous`).
    function invariant_singleCloseClearsEveryBook() public view {
        assertFalse(
            handler.g_singleCloseUnexpected(),
            "a two-book single Close reverted although the account was funded to cover every book"
        );
        assertEq(
            handler.g_singleCloseStranded(),
            0,
            "one unwind(withdraw max) left collateral on a venue: the withdraw leg stopped early (RISKS section 8, two-book Close)"
        );
    }

    function invariant_keeperNeverExceedsGrant() public view {
        assertFalse(handler.g_keeperUngrantedSucceeded(), "an un-granted keeper call succeeded");
        (uint256 limitU, uint256 spentU) =
            acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(usdc));
        (uint256 limitW, uint256 spentW) =
            acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(weth));
        (uint256 limitZ, uint256 spentZ) =
            acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(cbzec));
        assertLe(spentU, limitU, "USDC budget overspent");
        assertLe(spentW, limitW, "WETH budget overspent");
        assertLe(spentZ, limitZ, "cbZEC budget overspent (the pool-direct callback's payment)");
        assertEq(usdc.balanceOf(keeper), 0, "keeper holds USDC");
        assertEq(weth.balanceOf(keeper), 0, "keeper holds WETH");
        assertEq(cbbtc.balanceOf(keeper), 0, "keeper holds cbBTC");
        assertEq(aero.balanceOf(keeper), 0, "keeper holds AERO");
        assertEq(cbzec.balanceOf(keeper), 0, "keeper holds cbZEC");
        assertEq(aaveVenue.collateral(keeper, address(cbbtc)), 0);
        assertEq(gaugeCbzec.stakedLength(keeper), 0, "keeper staked nothing of its own");
        assertEq(npmCbzec.balanceOf(keeper), 0, "keeper holds no Slipstream NFT");
    }

    function invariant_feeNeverTouchesPrincipal() public view {
        assertLe(usdc.balanceOf(treasury), (handler.g_yieldUsdc() * PERF_BPS) / 10_000, "USDC fee > 10% of yield");
        assertLe(weth.balanceOf(treasury), (handler.g_yieldWeth() * PERF_BPS) / 10_000, "WETH fee > 10% of yield");
        assertLe(aero.balanceOf(treasury), (handler.g_yieldAero() * PERF_BPS) / 10_000, "AERO fee > 10% of yield");
        assertEq(cbbtc.balanceOf(treasury), 0, "collateral is never yield");
        // The direct venue's principal comes back as USDC and cbZEC; neither is ever yield in this
        // model (the gauge pays AERO; no trading fees accrue on the mock while staked).
        assertEq(cbzec.balanceOf(treasury), 0, "direct-venue principal (cbZEC) is never yield");
    }

    /// A peripheral never ACQUIRES a balance: whatever it holds is exactly what was donated to it
    /// from outside. Asserting an absolute zero here is what let B-CRIT-1 pass — the handler had no
    /// action that could transfer a token to a peripheral, so the vacuous assertion looked strong
    /// while one base unit of USDC would have bricked the protocol for everyone, permanently.
    function invariant_peripheralsAcquireNothing() public view {
        address[7] memory peripherals = [
            address(router),
            address(aaveVenue),
            address(lpVenue),
            address(swapAdapter),
            address(morphoVenue),
            address(directVenue),
            address(poolSwapAdapter)
        ];
        MockERC20[5] memory toks = [usdc, weth, cbbtc, aero, MockERC20(address(cbzec))];
        for (uint256 i = 0; i < 7; i++) {
            for (uint256 j = 0; j < 5; j++) {
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
        // …including the direct deployment: the position manager (approved for the mint, reset
        // after) and the pool itself (never approved — the callback pays by transfer).
        address[6] memory spenders =
            [address(aave), address(engine), address(aeroRouter), address(morpho), address(npmCbzec), address(poolCbzecUsdc)];
        MockERC20[4] memory toks = [usdc, weth, cbbtc, MockERC20(address(cbzec))];
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = 0; j < 4; j++) {
                assertEq(toks[j].allowance(address(acct), spenders[i]), 0, "allowance left behind");
            }
        }
        assertEq(npmCbzec.getApprovedCount(address(acct)), 0, "no NFT approval left behind");
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

        // Audit wave 2, M-HIGH-1: the registry moves cbBTC to Morpho. The position is on Aave; the
        // product's own exit and the keeper's grant must both still reach it.
        handler.switchVenue(true);
        assertEq(handler.g_switches(), 1);
        assertEq(registry.venueOf(address(cbbtc)), address(morphoVenue));
        handler.glitchEnumeration(false); // let the ids enumerate so the probes actually close and repay
        handler.routerExitProbe();
        assertEq(handler.g_routerExitProbes(), 1);
        assertFalse(handler.g_routerExitProbeFailed(), "the router exit must follow the position after a venue switch");
        assertGt(aaveVenue.debt(address(acct), address(usdc)), 0, "probe state restored");
        handler.regrant();
        handler.keeperUnwind(5_000e6);
        assertEq(handler.g_keeperUnwinds(), 3, "keeper unwind still repays the Aave debt with the registry pointing at Morpho");

        // 2026-09-10, slice 2: the two-book state. With the registry on Morpho an open lands on
        // Morpho while the Aave book is still open; the owner's unwind(repay max) with USDC to
        // cover must clear BOTH, worst first (RISKS §8 residual (a)), and both exits must still
        // work with two books. (cbBTC was paused above; an open needs it offered, an exit never does.)
        handler.toggleAsset(true);
        handler.supplyAndBorrowOnCurrentVenue(1e8, 4000);
        assertEq(handler.g_morphoOpens(), 1, "the open landed on the registry's current venue, Morpho");
        assertGt(morphoVenue.debt(address(acct), address(usdc)), 0);
        assertGt(aaveVenue.debt(address(acct), address(usdc)), 0, "the Aave book is still open");
        handler.repayAcrossProbe();
        assertEq(handler.g_twoBookProbes(), 1, "the probe saw debt on both books");
        assertFalse(handler.g_repayAcrossFailed(), "unwind(repay max) must clear every book the registry names");
        assertEq(handler.g_repayAcrossNamedReverts(), 0, "nothing to refuse with USDC to cover");
        assertGt(morphoVenue.debt(address(acct), address(usdc)), 0, "probe state restored");
        // Slice D saw the web's single Close strand the second venue's collateral here; slice F
        // (2026-09-11) made one Close clear both — reached here, so the invariant is not vacuous.
        handler.singleCloseProbe();
        assertEq(handler.g_singleCloseTwoBook(), 1, "the probe saw collateral on both venues");
        assertEq(handler.g_singleCloseStranded(), 0, "one Close returns the collateral from BOTH venues (RISKS section 8, option 1)");
        assertFalse(handler.g_singleCloseUnexpected());
        assertGt(morphoVenue.collateral(address(acct), address(cbbtc)), 0, "probe state restored");
        handler.routerExitProbe();
        assertFalse(handler.g_routerExitProbeFailed(), "the router exit clears two books and withdraws from both venues in one call");
        handler.rawExitProbe();
        assertFalse(handler.g_exitProbeFailed(), "the raw exit clears the Morpho book too");
        handler.switchVenue(false);
        assertEq(registry.venueOf(address(cbbtc)), address(aaveVenue));
        assertEq(handler.g_switches(), 2);

        // W3-MED-3 (2026-09-11): the direct Slipstream venue is reachable — opened from idle USDC,
        // rewarded by the gauge, closed by the keeper inside its grant (the cbZEC callback payment
        // charged), and by the owner; the raw exit clears it at the gauge and the position manager.
        handler.supplyAndBorrow(1e8, 4000); // idle USDC to deploy
        handler.openDirectLp(type(uint256).max);
        assertEq(handler.g_directOpens(), 1, "the direct open landed");
        assertEq(directVenue.positionsOf(address(acct)).length, 1);
        handler.accrueDirectReward(0, 50e18);
        uint256 aeroFeeBefore = aero.balanceOf(treasury);
        handler.keeperUnwindDirect(5_000e6);
        assertEq(handler.g_keeperDirectUnwinds(), 1, "the keeper's direct unwind succeeds within its grant");
        assertEq(directVenue.positionsOf(address(acct)).length, 0, "closed through the router");
        assertGt(aero.balanceOf(treasury), aeroFeeBefore, "the fee was taken on the gauge's AERO");
        (, uint256 spentZ) = acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(cbzec));
        assertGt(spentZ, 0, "the callback's cbZEC payment was charged to the grant");
        handler.openDirectLp(type(uint256).max);
        handler.ownerCloseDirect(0);
        assertEq(handler.g_directCloses(), 1);
        handler.openDirectLp(type(uint256).max);
        handler.donate(5, 1); // the direct venue
        handler.donate(6, 1); // the pool-direct adapter
        handler.rawExitProbe();
        assertFalse(handler.g_exitProbeFailed(), "the raw exit clears the direct position at the gauge and the NPM");
        handler.routerExitProbe();
        assertFalse(handler.g_routerExitProbeFailed(), "the router exit clears the direct position too");
    }
}
