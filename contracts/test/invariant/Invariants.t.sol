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
        bytes4[] memory sel = new bytes4[](35);
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
        // 2026-09-16 (docs/BACKLOG.md §6): the eight reaches W3-MED-3 named and left open. None of
        // them adds a property — they widen what the sequences below can put the existing ones
        // through, which is what an auditor asks about before they ask how many runs.
        sel[25] = Handler.deadGauge.selector; // (a) a pool ungauged at open time
        sel[26] = Handler.singleSidedResidual.selector; // (a) the enumeration window's residual
        sel[27] = Handler.increaseLp.selector; // (b) increase, engine venue
        sel[28] = Handler.increaseDirectLp.selector; // (b) increase, direct venue
        sel[29] = Handler.ownerWithdrawAmount.selector; // (c) a fixed withdraw: CollateralShort, ExitHfTooLow
        sel[30] = Handler.switchVenueWeth.selector; // (d) the pointer moves under a WETH book too
        sel[31] = Handler.revokeOne.selector; // (e) the single-grant revoke path, not revokeAll
        sel[32] = Handler.poolMisbehaves.selector; // (f) a partial fill and a pool paying short
        sel[33] = Handler.pauseEngine.selector; // (g) the engine stops; the raw exit must not
        sel[34] = Handler.closeManyDirectRefused.selector; // (h) unstaked, then the NPM refuses
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

    /// The counterexample the 1,500-run sweep of 2026-09-16 found, replayed deterministically.
    ///
    /// The new reach for section 6 (h) — a position manager that refuses `decreaseLiquidity` —
    /// broke `invariant_singleCloseClearsEveryBook` when the refusal was left ARMED across calls.
    /// This is the fuzzer's own sequence, in its own order, with the refusal armed directly rather
    /// than through the handler action (which now disarms itself in the same call, so the state can
    /// no longer persist into a probe).
    ///
    /// What it establishes, and the reason it is written as an observation rather than a fix: the
    /// single Close reverts only when a two-book account ALSO holds a position that cannot be
    /// withdrawn. On a one-book account the same refusal does not stop it. The probe funds the
    /// account to cover every book, so the revert is not about money — it is `unwind` having no
    /// tolerance for one stuck id where `closeMany` has a `failed` array for exactly that.
    ///
    /// Not "safety" under `docs/ROADMAP.md` rule 3: nothing is lost or locked, and the raw `exec`
    /// exit — invariant 1 — is asserted below to still work in the same state.
    function test_obs_singleCloseUnderARefusingPositionManager() public {
        handler.switchVenue(true); // the registry points cbBTC at Morpho
        handler.supplyAndBorrowOnCurrentVenue(1e8, 4000); // a Morpho book
        handler.openLp(type(uint256).max);
        handler.switchVenue(false); // and back to Aave, leaving two books
        handler.supplyAndBorrow(1e8, 4000); // the Aave book
        handler.openDirectLp(type(uint256).max);
        assertGt(directVenue.positionsOf(address(acct)).length, 0, "a direct position to get stuck");
        assertGt(morphoVenue.debt(address(acct), address(usdc)), 0, "the Morpho book is open");
        assertGt(aaveVenue.debt(address(acct), address(usdc)), 0, "and the Aave book");

        // Armed and LEFT armed, which is what the handler action no longer does.
        npmCbzec.setRefuseDecrease(true);
        handler.singleCloseProbe();
        assertTrue(
            handler.g_singleCloseUnexpected(),
            "OBSERVED 2026-09-16: a two-book Close reverts wholesale when one position cannot be withdrawn"
        );

        // The always-works path is unaffected, which is why this is availability and not funds.
        handler.rawExitProbe();
        assertFalse(handler.g_exitProbeFailed(), "the owner's raw exit still clears both books with the manager refusing");

        // And it is about tolerance during the refusal, not a permanently broken path.
        npmCbzec.setRefuseDecrease(false);
    }

    /// 2026-09-16 (`docs/BACKLOG.md` §6): the eight reaches W3-MED-3 named, each driven once and
    /// each PROVED to have taken the branch it was added for.
    ///
    /// This is the point of the whole exercise. An action that is registered but no-ops widens
    /// nothing, and the difference is invisible from a run count — which is why wave 3's own answer
    /// to "what does the fuzz explore" was a list of what it did not. Every assertion below is on
    /// the branch, not on the call returning.
    function test_theEightNamedGapsAreReached() public {
        // ── (a) a pool whose gauge is DEAD, and the fallback nothing could reach ────────────
        //
        // `SnuggleLpVenue._claimOne` tries `claimStakingRewards` and, if that reverts, falls through
        // to `harvest`; if both refuse it emits ClaimSkipped and moves on. An un-gauged entry makes
        // the first leg revert `NoRewardAdapter()`, so the HARVEST fallback is the branch a dead
        // gauge selects — and nothing could ungauge the fixture's pool, so that try/catch had never
        // once been taken under fuzz. Aerodrome's voter can kill a gauge at any moment, including
        // between a user's quote and their signature.
        handler.supplyAndBorrow(1e8, 4000);
        handler.openLp(type(uint256).max);
        // USDC-only yield, deliberately: `accrueYield`'s AERO leg stakes the id, and a staked id
        // would take the FIRST leg and prove nothing about the fallback.
        handler.accrueYield(0, 1_000e6, 0, 0);
        handler.deadGauge(true);
        uint256 acctUsdcBefore = usdc.balanceOf(address(acct));
        handler.ownerClaim();
        assertGt(
            usdc.balanceOf(address(acct)),
            acctUsdcBefore,
            "(a) with the gauge dead, claimStakingRewards reverts and the harvest fallback must still pay the owner"
        );
        handler.deadGauge(false); // the voter can bring it back, and the run has to keep exploring

        // ── (a, second half) the enumeration window's own-position residual ───────────────────
        handler.singleSidedResidual(10);
        assertEq(engine.singleSidedResidualBps(), 10, "(a) the residual is armed");
        handler.singleSidedResidual(0);

        // ── (b) increase, on BOTH venues — the one call that grows an id set without `open` ────
        uint256 before = lpVenue.positionsOf(address(acct)).length;
        handler.increaseLp(0, type(uint256).max);
        assertEq(lpVenue.positionsOf(address(acct)).length, before + 1, "(b) increase mints a new id beside the old one");

        handler.supplyAndBorrow(1e8, 4000); // idle USDC: the claim and the increase above spent it
        handler.openDirectLp(type(uint256).max);
        uint256 beforeDirect = directVenue.positionsOf(address(acct)).length;
        assertGt(beforeDirect, 0, "a direct position to increase");
        handler.supplyAndBorrow(1e8, 4000); // and more idle USDC for the increase itself
        handler.increaseDirectLp(0, type(uint256).max);
        assertEq(directVenue.positionsOf(address(acct)).length, beforeDirect + 1, "(b) and on the direct venue too");

        // ── (c) a FIXED withdraw amount: both refusals, and a success ─────────────────────────
        // Asking for more collateral than the venue holds. The gate refuses and NOTHING moves —
        // which is the whole assertion: before this action no fuzz sequence could ask.
        uint256 heldBefore = aaveVenue.collateral(address(acct), address(cbbtc));
        assertGt(heldBefore, 0, "collateral to ask for");
        handler.ownerWithdrawAmount(4e8);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), heldBefore, "(c) CollateralShort: refused, nothing moved");
        // A dust withdraw against a healthy account goes through.
        handler.ownerWithdrawAmount(1);
        assertLt(aaveVenue.collateral(address(acct), address(cbbtc)), heldBefore, "(c) a withdraw the floor allows still works");

        // ── (d) the pointer moves under a WETH book ───────────────────────────────────────────
        assertEq(registry.venueOf(address(weth)), address(aaveVenue));
        handler.switchVenueWeth(true);
        assertEq(handler.g_switchesWeth(), 1, "(d) WETH's own pointer moved, not cbBTC's");
        assertEq(registry.venueOf(address(weth)), address(morphoVenue));
        handler.switchVenueWeth(false);
        assertEq(registry.venueOf(address(weth)), address(aaveVenue));
        assertEq(handler.g_switchesWeth(), 2);

        // ── (e) the single-grant revoke, which is different code from revokeAll ───────────────
        handler.regrant();
        (bool activeBefore,,,,,,) = acct.grantOf(keeper, address(router), StrategyRouter.unwind.selector);
        assertTrue(activeBefore, "the grant is live before the revoke");
        uint256 unwindsBefore = handler.g_keeperUnwinds();
        handler.revokeOne();
        // `revoke` kills the grant by zeroing its expiry, which is what every authorisation check
        // reads. Asserted on `grantOf(...).active` rather than on an unwind succeeding first:
        // whether a given unwind goes through depends on the account's state at that moment, and
        // this is a claim about `revoke`, not about the router.
        (bool activeAfter,,,,,,) = acct.grantOf(keeper, address(router), StrategyRouter.unwind.selector);
        assertFalse(activeAfter, "(e) revoke() alone kills the grant, the same as revokeAll would");
        handler.keeperUnwind(1_000e6);
        assertEq(handler.g_keeperUnwinds(), unwindsBefore, "(e) and the keeper is refused afterwards");
        assertFalse(handler.g_keeperUngrantedSucceeded());
        // Found by this action, on its first run (2026-09-16): `tokenBudgetOf` is the ONE grant view
        // that does not consult expiry, so it keeps reporting a revoked keeper's budget while
        // `grantOf` correctly says `active: false`. Not a hole — the authorisation path reads the
        // expiry this just checked, and the keeper is refused above — and not user-visible, because
        // `web/components/KeeperPanel.tsx` gates the budget rows on `active`. An integrator reading
        // `tokenBudgetOf` alone would over-report. Recorded as backlog G-1; pinned here so the
        // behaviour cannot change without someone reading that entry.
        (uint256 staleBudget,) = acct.tokenBudgetOf(keeper, address(router), StrategyRouter.unwind.selector, address(usdc));
        assertGt(staleBudget, 0, "backlog G-1: tokenBudgetOf still reports a revoked grant's budget");

        // ── (f) the pool paying short and filling partially ───────────────────────────────────
        handler.regrant();
        handler.supplyAndBorrow(1e8, 4000);
        handler.poolMisbehaves(500, 5_000);
        assertEq(poolCbzecUsdc.shortPayBps(), 500, "(f) the pool is settling the callback short");
        assertEq(poolCbzecUsdc.fillBps(), 5_000, "(f) and filling half of what is asked");
        handler.openDirectLp(type(uint256).max);
        // Whatever the pool did, the adapter is a conduit and ends holding nothing — the property
        // that could never before have been asserted about a pool behaving badly.
        assertEq(usdc.balanceOf(address(poolSwapAdapter)), 0, "(f) the adapter keeps nothing from a short-paying pool");
        assertEq(cbzec.balanceOf(address(poolSwapAdapter)), 0, "(f) nor of the other leg");
        handler.poolMisbehaves(0, 10_000);

        // ── (g) the engine stops, and the owner's raw exit does not ───────────────────────────
        handler.openLp(type(uint256).max);
        handler.pauseEngine(true);
        assertTrue(engine.paused(), "(g) the engine is stopped");
        handler.rawExitProbe();
        assertFalse(handler.g_exitProbeFailed(), "(g) the raw exit must work with the engine PAUSED - invariant 1, in the state it was written for");
        handler.pauseEngine(false);

        // ── (h) closeMany unstakes and then cannot withdraw ───────────────────────────────────
        handler.openDirectLp(type(uint256).max);
        uint256[] memory directIds = directVenue.positionsOf(address(acct));
        assertGt(directIds.length, 0, "a direct position to close");
        uint256 victim = directIds[0];
        assertTrue(gaugeCbzec.stakedContains(address(acct), victim), "staked before the refusal");
        // The refusal is on the position manager, not the gauge: a gauge that refuses never lets the
        // id out, which is a different state. This one unstakes and THEN cannot withdraw.
        handler.closeManyDirectRefused(true);
        // The id left the gauge and the withdraw was refused, so the account still owns it and it is
        // no longer staked — the "left unstaked" branch, and the state a user could be stranded in.
        assertFalse(gaugeCbzec.stakedContains(address(acct), victim), "(h) it was unstaked before the refusal bit");
        handler.closeManyDirectRefused(false);
        handler.rawExitProbe();
        assertFalse(handler.g_exitProbeFailed(), "(h) and the owner still gets out once the refusal lifts");
    }
}
