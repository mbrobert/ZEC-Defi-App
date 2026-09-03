// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {RewardRouter} from "../../src/RewardRouter.sol";
import {SnuggleAdapter} from "../../src/adapters/SnuggleAdapter.sol";
import {LpParams} from "../../src/interfaces/ILPAdapter.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSnuggleVault} from "../mocks/MockSnuggleVault.sol";

/// @title Handler — drives random sequences of every user- and operator-
///        controllable action against the live contract graph, with fuzzed
///        parameters, so the invariants in Invariants.t.sol are checked across
///        tens of thousands of reachable states.
///
/// Every branch a real user can trigger is represented: deposit amounts, range
/// widths, rebalance delays, auto-compound, reward preference, increases,
/// consolidations, partial and full withdrawals at any share, fee accrual,
/// compounding, routing to Zcash, preference changes, out-of-range flips, time
/// warps (to clear the engine's flash-loan hold) — and the engine keeper's
/// rebalance, which RE-KEYS positions (new tokenId, old emptied). The re-key
/// action is what makes invariant_exitLiveness a real C-1 regression.
contract Handler is Test {
    PositionVault public immutable vault;
    RewardRouter public immutable router;
    SnuggleAdapter public immutable adapter;
    MockSnuggleVault public immutable engine;
    MockERC20 public immutable usdc; // token0 / entry / workhorse
    MockERC20 public immutable weth; // token1
    MockERC20 public immutable aero; // non-matching reward

    address public constant OPERATOR = address(0x0FE2);
    address public constant INTENTS = 0x00000000000000000000000000000000DeaDBeef;
    address[4] public actors = [address(0xA11CE), address(0xB0B), address(0xCA51), address(0xD00D)];
    bytes32[3] public pools;

    // ---- tracked positions
    uint256[] public positionIds;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => bool) public isSend; // reward pref == SEND_TO_ZCASH

    // ---- ghost accounting (USDC, the only token ever deposited single-sided)
    uint256 public g_depositedExternal; // user deposits + increases (new money in)
    uint256 public g_feesMintedUsdc; // USDC fees minted into the engine
    uint256 public g_paidToUsers; // USDC returned to users on withdraw
    uint256 public g_paidToIntents; // USDC routed to the intents deposit addr
    uint256 public g_rebalances; // keeper re-keys executed

    // ---- call counters (visibility into what the fuzzer actually exercised)
    mapping(bytes32 => uint256) public calls;

    string constant ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";

    constructor(
        PositionVault _vault,
        RewardRouter _router,
        SnuggleAdapter _adapter,
        MockSnuggleVault _engine,
        MockERC20 _usdc,
        MockERC20 _weth,
        MockERC20 _aero,
        bytes32[3] memory _pools
    ) {
        vault = _vault;
        router = _router;
        adapter = _adapter;
        engine = _engine;
        usdc = _usdc;
        weth = _weth;
        aero = _aero;
        pools = _pools;
    }

    // ------------------------------------------------------------ modifiers

    modifier count(bytes32 key) {
        calls[key]++;
        _;
    }

    function _pickActive(uint256 seed) internal view returns (bool ok, uint256 id) {
        uint256 n = positionIds.length;
        if (n == 0) return (false, 0);
        for (uint256 i = 0; i < n; i++) {
            uint256 idx = (seed + i) % n;
            uint256 pid = positionIds[idx];
            if (vault.getPosition(pid).active) return (true, pid);
        }
        return (false, 0);
    }

    // ------------------------------------------------------------- actions

    function deposit(uint256 actorSeed, uint256 amt, uint256 rangeSeed, uint256 delaySeed, uint256 prefSeed)
        external
        count("deposit")
    {
        address user = actors[actorSeed % 4];
        amt = bound(amt, 1e6, 1_000_000e6);
        LpParams memory p = LpParams({
            rangeWidthBps: uint24(bound(rangeSeed, 10, 5000)),
            rebalanceDelay: uint64(bound(delaySeed, 0, 30 days)),
            autoCompound: (prefSeed & 1) == 0
        });
        bool send = (prefSeed & 2) == 0;
        bytes32 pool = pools[prefSeed % 3];

        usdc.mint(address(vault), amt);
        vm.prank(OPERATOR);
        try vault.openFor(
            user,
            address(adapter),
            pool,
            address(usdc),
            amt,
            p,
            send ? PositionVault.RewardPreference.SEND_TO_ZCASH : PositionVault.RewardPreference.COMPOUND,
            send ? ZADDR : ""
        ) returns (uint256 id) {
            positionIds.push(id);
            ownerOf[id] = user;
            isSend[id] = send;
            g_depositedExternal += amt;
        } catch {
            // Out-of-bound params etc. — burn the unused mint to keep ghost books exact.
            vm.prank(address(vault));
            usdc.transfer(address(0xdead), amt);
        }
    }

    function increase(uint256 posSeed, uint256 amt) external count("increase") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        if (adapter.tokenCount(id) >= adapter.MAX_ENGINE_POSITIONS()) return;
        // Operator increases are throttled (M-1): respect the per-position
        // cooldown and the minimum size so the action stays productive.
        vm.warp(block.timestamp + vault.OPERATOR_TOUCH_COOLDOWN() + 1);
        uint256 minAmt = vault.getPosition(id).shares / vault.MIN_OPERATOR_INCREASE_DIVISOR();
        if (minAmt < 1e6) minAmt = 1e6;
        amt = bound(amt, minAmt, minAmt + 500_000e6);
        usdc.mint(address(vault), amt);
        vm.prank(OPERATOR);
        try vault.increase(id, amt) {
            g_depositedExternal += amt;
        } catch {
            vm.prank(address(vault));
            usdc.transfer(address(0xdead), amt);
        }
    }

    /// @notice The engine keeper auto-snuggle: RE-KEYS a random live engine
    ///         position (new tokenId minted, old one emptied). The shipped
    ///         adapter used to pin the stale id — this action is what lets
    ///         invariant_exitLiveness prove exits survive re-keys.
    function keeperRebalance(uint256 posSeed, uint256 idSeed) external count("keeperRebalance") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        uint256 n = adapter.tokenCount(id);
        if (n == 0) return;
        uint256 engineId = adapter.tokenIdsOf(id, idSeed % n);
        engine.rebalance(engineId);
        g_rebalances++;
    }

    function consolidate(uint256 posSeed) external count("consolidate") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        // Respect the operator touch cooldown (shared with increase).
        vm.warp(block.timestamp + vault.OPERATOR_TOUCH_COOLDOWN() + 1);
        vm.prank(OPERATOR);
        try vault.consolidate(id, 0) {} catch {}
    }

    function withdraw(uint256 posSeed, uint256 bpsSeed, uint256 warpSeed) external count("withdraw") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        vm.warp(block.timestamp + bound(warpSeed, 61, 3 days)); // clear engine hold
        uint256 bps = bound(bpsSeed, 1, 10_000);
        address user = ownerOf[id];
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        try vault.withdraw(id, bps, user, 0, 0, 0) {
            g_paidToUsers += usdc.balanceOf(user) - before;
        } catch {}
    }

    function accrueFees(uint256 posSeed, uint256 usdcFee, uint256 aeroFee) external count("accrueFees") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        if (adapter.tokenCount(id) == 0) return;
        uint256 engineId = adapter.tokenIdsOf(id, 0);
        usdcFee = bound(usdcFee, 0, 50_000e6);
        aeroFee = bound(aeroFee, 0, 100e18);
        if (usdcFee > 0) {
            usdc.mint(address(engine), usdcFee);
            engine.setPendingFee(engineId, address(usdc), usdcFee);
            g_feesMintedUsdc += usdcFee;
        }
        if (aeroFee > 0) {
            aero.mint(address(engine), aeroFee);
            engine.setPendingFee(engineId, address(aero), aeroFee);
        }
    }

    function compound(uint256 posSeed) external count("compound") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        if (adapter.tokenCount(id) >= adapter.MAX_ENGINE_POSITIONS()) return;
        vm.prank(OPERATOR);
        try router.compound(id) {} catch {}
    }

    function routeToZcash(uint256 posSeed) external count("route") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok || !isSend[id]) return;
        uint256 before = usdc.balanceOf(INTENTS);
        vm.prank(OPERATOR);
        try router.routeToZcash(id, INTENTS, keccak256(abi.encode(id))) {
            g_paidToIntents += usdc.balanceOf(INTENTS) - before;
        } catch {}
    }

    function changePref(uint256 posSeed, uint256 prefSeed) external count("changePref") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        bool send = (prefSeed & 1) == 0;
        address user = ownerOf[id];
        vm.prank(user);
        try vault.setRewardPreference(
            id,
            send ? PositionVault.RewardPreference.SEND_TO_ZCASH : PositionVault.RewardPreference.COMPOUND,
            send ? ZADDR : ""
        ) {
            isSend[id] = send;
        } catch {}
    }

    function goOutOfRange(uint256 posSeed, bool v) external count("outOfRange") {
        (bool ok, uint256 id) = _pickActive(posSeed);
        if (!ok) return;
        if (adapter.tokenCount(id) == 0) return;
        engine.setOutOfRangeSince(adapter.tokenIdsOf(id, 0), v ? uint64(block.timestamp) : 0);
    }

    function warp(uint256 s) external count("warp") {
        vm.warp(block.timestamp + bound(s, 1, 7 days));
    }

    // -------------------------------------------------------------- helpers

    function positionCount() external view returns (uint256) {
        return positionIds.length;
    }

    function idAt(uint256 i) external view returns (uint256) {
        return positionIds[i];
    }

    function sumActiveShares() external view returns (uint256 total) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            total += vault.getPosition(positionIds[i]).shares;
        }
    }

    /// @notice USDC sitting idle on every position's holder (deposit refunds).
    function sumHolderUsdc() external view returns (uint256 total) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            total += usdc.balanceOf(adapter.holderOf(positionIds[i]));
        }
    }

    /// @notice Σ idleOf across all tracked positions (token0 = USDC leg).
    function sumIdleOf() external view returns (uint256 total) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            (uint256 i0,) = adapter.idleOf(positionIds[i]);
            total += i0;
        }
    }

    /// @notice Every tracked position's active flag must equal (shares > 0).
    function activeFlagConsistent() external view returns (bool) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            PositionVault.Position memory p = vault.getPosition(positionIds[i]);
            if (p.active != (p.shares > 0)) return false;
        }
        return true;
    }
}
