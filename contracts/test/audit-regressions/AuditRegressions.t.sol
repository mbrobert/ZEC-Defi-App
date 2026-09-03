// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {RewardRouter} from "../../src/RewardRouter.sol";
import {SnuggleAdapter} from "../../src/adapters/SnuggleAdapter.sol";
import {PositionHolder} from "../../src/adapters/PositionHolder.sol";
import {LpParams} from "../../src/interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSnuggleVault} from "../mocks/MockSnuggleVault.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @title AuditRegressions — the pre-audit findings, asserted FIXED.
///
/// @notice Each test is the repro scenario from the pre-audit report
///         (/tmp findings C-1, H-1, M-1..M-9, L-1..L-8, I-2 as shipped to the
///         parent repo), rewritten to assert the fixed behaviour. The engine
///         double is the upgraded MockSnuggleVault with live-engine fidelity:
///         keeper rebalance re-keys tokenIds, deposits refund 88bps, rewards
///         (AERO) are paid on claim AND on close, and a 60s minimum hold is
///         active — the behaviours whose absence let the originals ship.
contract AuditRegressionsTest is Test {
    PositionVault vault;
    RewardRouter router;
    SnuggleAdapter adapter;
    MockSnuggleVault engine;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 aero;

    address admin = address(this);
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address intents = makeAddr("intents");
    bytes32 constant POOL = keccak256("aero-weth-usdc");
    string constant ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";

    LpParams params = LpParams({rangeWidthBps: 800, rebalanceDelay: 1 hours, autoCompound: true});

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aero = new MockERC20("Aerodrome", "AERO", 18);
        vault = new PositionVault(admin);
        engine = new MockSnuggleVault();
        engine.setMinHoldTime(60); // real engine: MinimumHoldTimeNotMet under 60s
        engine.addPool(POOL, makeAddr("pool"), address(usdc), address(weth), 500);
        adapter = new SnuggleAdapter(address(vault), ISnuggleVault(address(engine)), admin, admin);
        router = new RewardRouter(admin, vault);

        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        adapter.setRewardTokens(rts);

        vault.setOperator(operator, true);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setTokenAllowed(address(usdc), true);
        vault.setTokenAllowed(address(weth), true);
        vault.setRewardRouter(address(router));
        router.setOperator(operator, true);
        router.setMaxRoutePerTx(address(usdc), 25_000e6);
    }

    function _open(address user, uint256 amt, PositionVault.RewardPreference pref)
        internal
        returns (uint256 id)
    {
        usdc.mint(address(vault), amt);
        vm.prank(operator);
        id = vault.openFor(
            user, address(adapter), POOL, address(usdc), amt, params, pref,
            pref == PositionVault.RewardPreference.SEND_TO_ZCASH ? ZADDR : ""
        );
    }

    // =====================================================================
    // C-1 (Critical): keeper rebalance RE-KEYS the engine tokenId. The old
    // adapter pinned the stale id — every rebalanced position was permanently
    // un-withdrawable. Fixed: per-position holders + live-id resolution.
    // =====================================================================
    function test_FIX_C1_rebalancedPositionFullyExits() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        uint256 oldId = adapter.tokenIdsOf(id, 0);

        // Keeper auto-snuggles — twice, for good measure.
        uint256 midId = engine.rebalance(oldId);
        uint256 newId = engine.rebalance(midId);
        assertFalse(engine.exists(oldId));
        assertTrue(engine.exists(newId));

        // The adapter tracks the LIVE id, not the pinned one.
        assertEq(adapter.tokenIdsOf(id, 0), newId);
        assertEq(adapter.tokenCount(id), 1);

        // Exit works at any share, for the full amount.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6); // refund idle folded in too
        assertEq(adapter.tokenCount(id), 0);
        assertFalse(vault.getPosition(id).active);
        assertEq(usdc.balanceOf(address(engine)), 0); // nothing orphaned
    }

    function test_FIX_C1_claimConsolidateIncreaseSurviveRekey() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        uint256 newId = engine.rebalance(adapter.tokenIdsOf(id, 0));

        // Claims find the live id (fees accrued under the NEW id).
        usdc.mint(address(engine), 10e6);
        engine.setPendingFee(newId, address(usdc), 10e6);
        vm.prank(operator);
        (uint256 amt,) = router.compound(id);
        assertEq(amt, 10e6);

        // Operator increase and consolidate also work against live ids.
        usdc.mint(address(vault), 100e6);
        vm.warp(vm.getBlockTimestamp() + vault.OPERATOR_TOUCH_COOLDOWN() + 1);
        vm.prank(operator);
        vault.increase(id, 100e6);
        engine.rebalance(adapter.tokenIdsOf(id, 0)); // re-key again mid-flight
        vm.warp(vm.getBlockTimestamp() + vault.OPERATOR_TOUCH_COOLDOWN() + 1);
        vm.prank(operator);
        assertEq(vault.consolidate(id, 0), 1);

        // And the range view reads LIVE state (no zeros-decoding lie).
        assertTrue(adapter.inRange(id));
        engine.setOutOfRangeSince(adapter.tokenIdsOf(id, 0), uint64(vm.getBlockTimestamp()));
        assertFalse(adapter.inRange(id));

        // Full exit still clean.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(vault.getPosition(id).shares, 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    // =====================================================================
    // H-1 (High): Aerodrome-gauge positions pay AERO only. The router used to
    // revert NothingClaimed (rolling the claim back), and AERO paid on close
    // was stranded in the shared adapter. Fixed: hold-don't-revert in the
    // router + full incentive-balance forwarding on withdraw.
    // =====================================================================
    function test_FIX_H1_aeroOnlyClaimHeldForOwner_notReverted() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.SEND_TO_ZCASH);
        uint256 eid = adapter.tokenIdsOf(id, 0);
        engine.setStaked(eid, true);
        aero.mint(address(engine), 50e18);
        engine.setPendingFee(eid, address(aero), 50e18); // emissions only, no USDC

        // No revert; the claim stands; AERO is held & attributed in the router.
        vm.prank(operator);
        uint256 routed = router.routeToZcash(id, intents, keccak256("q"));
        assertEq(routed, 0);
        assertEq(aero.balanceOf(address(router)), 50e18);
        assertEq(router.unmatchedOf(id, address(aero)), 50e18);
        assertEq(aero.balanceOf(address(engine)), 0); // actually left the gauge

        // The position OWNER (nobody else) can pull it out.
        vm.prank(alice);
        router.claimUnmatched(id, address(aero), alice);
        assertEq(aero.balanceOf(alice), 50e18);
    }

    function test_FIX_H1_aeroPaidOnCloseReachesRecipient() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        uint256 eid = adapter.tokenIdsOf(id, 0);
        engine.setStaked(eid, true);
        aero.mint(address(engine), 50e18);
        engine.setPendingFee(eid, address(aero), 50e18);

        // Full exit: the engine pays AERO to the position's holder on close;
        // the adapter forwards it to the recipient instead of stranding it.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(aero.balanceOf(alice), 50e18); // rewards arrive WITH principal
        assertEq(aero.balanceOf(address(adapter)), 0);
        assertEq(aero.balanceOf(adapter.holderOf(id)), 0);
    }

    // =====================================================================
    // Refund stranding (known finding + M-2): the engine refunds un-fitting
    // deposit leftovers in-tx (88bps on a live receipt). Fixed: refunds stay
    // on the position's holder as attributed idle — reported via idleOf,
    // folded on consolidate, included in withdrawal payouts. Never swept.
    // =====================================================================
    function test_FIX_refundIdle_reportedFoldedAndPaidOut() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);

        // 88bps refund is attributed to the position, visible on-chain.
        (uint256 idle0, uint256 idle1) = adapter.idleOf(id);
        assertEq(idle0, 88e6);
        assertEq(idle1, 0);
        assertEq(usdc.balanceOf(address(engine)), 9_912e6);
        assertEq(usdc.balanceOf(address(adapter)), 0); // NOT on the shared adapter

        // Consolidate folds idle back into the engine position (it closes the
        // engine position, so the 60s hold must have elapsed first).
        engine.setRefundBps(0); // so the fold is visible (no fresh refund)
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(operator);
        vault.consolidate(id, 0);
        (idle0,) = adapter.idleOf(id);
        assertEq(idle0, 0);
        assertEq(usdc.balanceOf(address(engine)), 10_000e6); // refund re-deployed

        // And a full withdraw returns every unit, idle included (the
        // consolidate re-mint restarted the hold clock).
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }

    function test_FIX_refundIdle_partialWithdrawPaysShareOfIdle() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 5_000, alice, 0, 0, 0);
        // 50% of (engine 9_912e6 + idle 88e6) — idle is IN the payout base.
        assertEq(usdc.balanceOf(alice), 5_000e6);
        assertEq(vault.getPosition(id).shares, 5_000e6);
    }

    // =====================================================================
    // M-2: tokens the engine/keeper pushes to the position's account OUTSIDE
    // our own tx used to be unattributable on the shared adapter. Fixed: they
    // land on the per-position holder — pool tokens join idle/payouts,
    // incentive tokens are swept on the next claim.
    // =====================================================================
    function test_FIX_M2_keeperPushedTokensAttributedAndRecoverable() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        address holder = adapter.holderOf(id);

        // Keeper auto-compound leftovers arrive between our transactions.
        aero.mint(holder, 7e18);
        usdc.mint(holder, 5e6);

        // The USDC shows up as this position's idle...
        (uint256 idle0,) = adapter.idleOf(id);
        assertEq(idle0, 88e6 + 5e6);

        // ...the AERO is swept by the owner's own claim (paused or not)...
        vault.pause();
        vm.prank(alice);
        vault.claimSelf(id, alice);
        assertEq(aero.balanceOf(alice), 7e18);
        vault.unpause();

        // ...and the USDC is paid out with the principal on exit.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_005e6);
    }

    // =====================================================================
    // M-1: 1-wei operator increases / same-block consolidates could hold the
    // engine's 60s clock fresh forever and block the owner's exit. Fixed:
    // minimum operator increase (principal/1000) + shared 1h cooldown.
    // Owner-initiated paths are unaffected.
    // =====================================================================
    function test_FIX_M1_operatorGriefingBlocked() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        uint256 t0 = vm.getBlockTimestamp();

        // The 1-wei grief is dead on arrival.
        usdc.mint(address(vault), 1);
        vm.warp(t0 + 59);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.OperatorIncreaseTooSmall.selector, id, 1, 10e6)
        );
        vault.increase(id, 1);

        // A legitimate-size increase works once — and then the operator is in
        // cooldown, so the clock can be extended at most once per hour.
        usdc.mint(address(vault), 10e6);
        vm.prank(operator);
        vault.increase(id, 10e6);
        usdc.mint(address(vault), 11e6); // above the (grown) principal/1000 min
        vm.warp(t0 + 118);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.OperatorCooldownActive.selector, id, t0 + 59 + 1 hours
            )
        );
        vault.increase(id, 11e6);

        // The same-block consolidate race is throttled by the SAME cooldown.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.OperatorCooldownActive.selector, id, t0 + 59 + 1 hours
            )
        );
        vault.consolidate(id, 0);

        // Alice exits as soon as the last legitimate deposit's hold elapses.
        vm.warp(t0 + 59 + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_010e6);
    }

    function test_FIX_M1_ownerIncreaseUnaffectedByThrottle() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        usdc.mint(alice, 3);
        vm.startPrank(alice);
        usdc.approve(address(vault), 3);
        vault.increase(id, 1); // tiny and immediate — owner only delays herself
        vault.increase(id, 1);
        vault.increase(id, 1);
        vm.stopPrank();
        assertEq(vault.getPosition(id).shares, 10_000e6 + 3);
    }

    // =====================================================================
    // M-3: poolExposure summed raw units of DIFFERENT entry tokens per pool —
    // a USDC cap made $3 of WETH revert (or left WETH unbounded). Fixed:
    // exposure and caps are keyed (poolKey, token).
    // =====================================================================
    function test_FIX_M3_exposureCapsPerToken() public {
        vault.setMaxDepositPerPool(POOL, address(usdc), 100_000e6); // "$100k" in USDC units

        // $3 of WETH no longer trips the USDC-denominated cap.
        weth.mint(address(vault), 0.001e18);
        vm.prank(operator);
        uint256 wid = vault.openFor(
            alice, address(adapter), POOL, address(weth), 0.001e18, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
        assertTrue(vault.getPosition(wid).active);
        assertEq(vault.poolExposure(POOL, address(weth)), 0.001e18);
        assertEq(vault.poolExposure(POOL, address(usdc)), 0);

        // Each token is bounded in ITS OWN units.
        vault.setMaxDepositPerPool(POOL, address(weth), 1e18);
        weth.mint(address(vault), 2e18);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.PoolExposureCapExceeded.selector,
                POOL,
                address(weth),
                2e18 + 0.001e18,
                1e18
            )
        );
        vault.openFor(
            alice, address(adapter), POOL, address(weth), 2e18, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        // The USDC budget is untouched by WETH entries.
        uint256 id = _open(alice, 100_000e6, PositionVault.RewardPreference.COMPOUND);
        assertTrue(vault.getPosition(id).active);
    }

    // =====================================================================
    // M-4: rewards were reachable only through the operator+router and not at
    // all while paused. Fixed: claimSelf — owner-gated, never pausable.
    // =====================================================================
    function test_FIX_M4_claimSelfWorksPausedAndOperatorless() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.SEND_TO_ZCASH);
        uint256 eid = adapter.tokenIdsOf(id, 0);
        usdc.mint(address(engine), 40e6);
        engine.setPendingFee(eid, address(usdc), 40e6);
        aero.mint(address(engine), 3e18);
        engine.setPendingFee(eid, address(aero), 3e18);

        vault.pause();
        vault.setOperator(operator, false); // dead agent

        vm.prank(alice);
        (address[] memory tokens, uint256[] memory amounts) = vault.claimSelf(id, alice);
        assertEq(tokens[0], address(usdc));
        assertEq(amounts[0], 40e6);
        assertEq(usdc.balanceOf(alice), 40e6);
        assertEq(aero.balanceOf(alice), 3e18);

        // Owner-gated; recipient must be real.
        vm.prank(operator);
        vm.expectRevert(PositionVault.NotPositionOwner.selector);
        vault.claimSelf(id, operator);
        vm.prank(alice);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        vault.claimSelf(id, address(0));
    }

    // =====================================================================
    // M-6 / L-8: zero-address entries. openFor(0) locked principal forever;
    // WETH9 does not revert on transfer to address(0), so a zeroed withdraw
    // recipient burned the payout. Fixed: explicit reverts.
    // =====================================================================
    function test_FIX_M6_zeroOwnerOpenReverts() public {
        usdc.mint(address(vault), 5_000e6);
        vm.prank(operator);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        vault.openFor(
            address(0), address(adapter), POOL, address(usdc), 5_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );
    }

    function test_FIX_L8_zeroRecipientWithdrawReverts() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vm.expectRevert(PositionVault.ZeroAddress.selector);
        vault.withdraw(id, 10_000, address(0), 0, 0, 0);
    }

    // =====================================================================
    // L-1: routeToZcash's cap check was atomic with the claim — accrual above
    // maxRoutePerTx deadlocked the position forever. Fixed: route
    // min(claimed + held, cap), hold the remainder.
    // =====================================================================
    function test_FIX_L1_routeCapDeadlockResolved() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.SEND_TO_ZCASH);
        uint256 eid = adapter.tokenIdsOf(id, 0);
        usdc.mint(address(engine), 30_000e6);
        engine.setPendingFee(eid, address(usdc), 30_000e6); // accrual > 25k cap

        vm.prank(operator);
        uint256 routed = router.routeToZcash(id, intents, keccak256("q1"));
        assertEq(routed, 25_000e6); // cap's worth moved NOW
        assertEq(router.unmatchedOf(id, address(usdc)), 5_000e6); // remainder held

        vm.prank(operator);
        routed = router.routeToZcash(id, intents, keccak256("q2"));
        assertEq(routed, 5_000e6); // held remainder clears next tx
        assertEq(usdc.balanceOf(intents), 30_000e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // =====================================================================
    // L-2: with tiny principal and shareBps=9_999, rounding used to mark the
    // vault position closed while a live engine position (1 raw unit) stayed
    // behind it, unreachable. Fixed: below-dust remainders are paid out and
    // `closed` additionally requires no live ids and no idle.
    // =====================================================================
    function test_FIX_L2_dustRemainderPaidOutAndTrulyClosed() public {
        uint256 id = _open(alice, 5_000, PositionVault.RewardPreference.COMPOUND); // 0.005 USDC
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 9_999, alice, 0, 0, 0);

        PositionVault.Position memory p = vault.getPosition(id);
        assertFalse(p.active);
        assertEq(p.shares, 0);
        assertEq(adapter.tokenCount(id), 0); // NO live engine position behind it
        (uint256 idle0,) = adapter.idleOf(id);
        assertEq(idle0, 0);
        assertEq(usdc.balanceOf(alice), 5_000); // the dust went to the owner
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    // =====================================================================
    // L-3: the exit path used to re-read engine.approvedPools — an engine
    // upgrade re-ordering PoolConfig (or corrupting the registry) would brick
    // withdraw. Fixed: token0/token1 captured into Meta at open; the exit
    // path's engine surface is withdraw(id) only.
    // =====================================================================
    function test_FIX_L3_exitSurvivesRegistryCorruption() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);

        // Engine upgrade re-lays-out the PoolConfig getter: approvedPools now
        // decodes garbage token addresses. Entry paths (which still consult
        // the registry) break loudly...
        engine.corruptRegistryView(POOL, address(0xdead), address(0xbeef));
        usdc.mint(address(vault), 100e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleAdapter.TokenNotInPool.selector, address(usdc), POOL)
        );
        vault.increase(id, 100e6);

        // ...but the EXIT path never re-reads the registry (tokens captured
        // in Meta at open) and still works in full.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(adapter.tokenCount(id), 0);
    }

    // =====================================================================
    // L-7: deadline computed in-tx (vm.getBlockTimestamp() + 15m) was a no-op for
    // queued transactions. Fixed: callers pass a deadline (0 = default
    // window); a stale tx reverts instead of executing at the landing price.
    // =====================================================================
    function test_FIX_L7_callerDeadlineRespected() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        vm.warp(vm.getBlockTimestamp() + 61);

        uint256 stale = vm.getBlockTimestamp() - 1;
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleAdapter.DeadlineExpired.selector, stale)
        );
        vault.withdraw(id, 5_000, alice, 0, 0, stale);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleAdapter.DeadlineExpired.selector, stale)
        );
        vault.consolidate(id, stale);

        // A live deadline (and the 0 default) work.
        vm.prank(alice);
        vault.withdraw(id, 5_000, alice, 0, 0, vm.getBlockTimestamp() + 5 minutes);
        assertEq(usdc.balanceOf(alice), 5_000e6);
    }

    // =====================================================================
    // M-8: with SNUGGLE_ENGINE unset, the deploy script silently deployed the
    // permissionless-hook mock engine and allowlisted an adapter to it — on
    // any chain. Fixed: refuses on Base mainnet.
    // =====================================================================
    function test_FIX_M8_deployRefusesMockEngineOnMainnet() public {
        vm.setEnv("SNUGGLE_ENGINE", "0x0000000000000000000000000000000000000000");
        vm.chainId(8453);
        Deploy d = new Deploy();
        vm.expectRevert(bytes("mock engine on mainnet"));
        d.run();
    }

    // =====================================================================
    // I-2: observability — the mappings incident response needs are now
    // emitted: holder + engine-token identity at open, re-deposits, reward
    // token config, amounts on withdraw, source tags on increase.
    // =====================================================================
    function test_FIX_I2_eventsCarryForensicData() public {
        // RewardTokensSet on config.
        address[] memory rts = new address[](1);
        rts[0] = address(aero);
        vm.expectEmit(address(adapter));
        emit SnuggleAdapter.RewardTokensSet(rts);
        adapter.setRewardTokens(rts);

        // EngineTokenObserved at open (first live id = 1).
        usdc.mint(address(vault), 10_000e6);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit SnuggleAdapter.EngineTokenObserved(1, 1);
        vm.prank(operator);
        uint256 id = vault.openFor(
            alice, address(adapter), POOL, address(usdc), 10_000e6, params,
            PositionVault.RewardPreference.COMPOUND, ""
        );

        // PositionIncreased carries the funding source.
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 100e6);
        vm.expectEmit(address(vault));
        emit PositionVault.PositionIncreased(
            id, 100e6, 100e6, PositionVault.IncreaseSource.OWNER
        );
        vault.increase(id, 100e6);
        vm.stopPrank();

        // Partial withdraw emits the re-deposit and the paid amounts.
        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vm.expectEmit(address(adapter));
        emit SnuggleAdapter.Redeposited(id, 5_050e6, 0);
        vm.expectEmit(address(vault));
        emit PositionVault.PositionWithdrawn(id, 5_000, alice, false, 5_050e6, 0, 0);
        vault.withdraw(id, 5_000, alice, 0, 0, 0);
    }

    // =====================================================================
    // Hardening found during the fix pass: reward forwarding now sits on the
    // withdraw path, so a misconfigured rewardTokens entry (EOA, junk, or a
    // reverting contract) must not be able to brick the always-open exit.
    // Failed forwards are skipped (balance stays on the holder, recoverable);
    // principal payout stays strict.
    // =====================================================================
    function test_FIX_rewardTokenMisconfigCannotBrickExit() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);

        // Owner fat-fingers the list: an EOA and a contract that reverts on
        // every call, alongside the real AERO.
        RevertingToken bomb = new RevertingToken();
        address[] memory rts = new address[](3);
        rts[0] = makeAddr("not-a-token");
        rts[1] = address(bomb);
        rts[2] = address(aero);
        adapter.setRewardTokens(rts);
        aero.mint(adapter.holderOf(id), 2e18); // real rewards on the holder

        vm.warp(vm.getBlockTimestamp() + 61);
        vm.prank(alice);
        vault.withdraw(id, 10_000, alice, 0, 0, 0); // exit MUST still work
        assertEq(usdc.balanceOf(alice), 10_000e6); // principal strict + intact
        assertEq(aero.balanceOf(alice), 2e18); // healthy rewards still forwarded
    }

    // =====================================================================
    // Holder plumbing: exec is adapter-gated, init is one-shot — a stranger
    // can never act as a position's engine account.
    // =====================================================================
    function test_FIX_holderAccessControl() public {
        uint256 id = _open(alice, 10_000e6, PositionVault.RewardPreference.COMPOUND);
        PositionHolder holder = PositionHolder(adapter.holderOf(id));

        vm.expectRevert(PositionHolder.OnlyAdapter.selector);
        holder.exec(address(usdc), abi.encodeCall(usdc.transfer, (address(this), 1)));

        vm.expectRevert(PositionHolder.AlreadyInitialized.selector);
        holder.init(address(this));
    }
}

/// @dev Reverts on every call — simulates a broken "token" in rewardTokens.
contract RevertingToken {
    fallback() external {
        revert("broken token");
    }
}
