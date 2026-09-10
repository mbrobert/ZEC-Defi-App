// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {MockCLPool} from "./MockCLPool.sol";

/// @notice Test double for SnuggleVaultUpgradeable, faithful to the CHAIN-VERIFIED semantics
///         (AUDIT-FINDINGS-2026-09-03 Part 1), not to an interface we wished it had:
///           • FACT 1  `userPositions(address,uint256)` index getter — reverts past the end with an
///                     EMPTY revert (the shape MEASURED on the live engine 2026-09-10 at block
///                     51,127,409, `VERIFIED-BASE-FACTS.md` Addendum 3; the getter is the
///                     compiler-generated one, solc 0.8.33 via-IR). `setEndShape(Panic32)` keeps the
///                     `Panic(0x32)` variant a Solidity array read produces, so both shapes the venue
///                     accepts are covered. No array-returning getter exists.
///           • FACT 2  re-key REPLACES: the old id leaves the list and `positions(old)` reads zero.
///           • FACT 4  single-sided deposit mints with ≈ zero residual; dual deposit mints the
///                     balanced part at the pool price and BOUNCES the excess of the long leg to
///                     msg.sender; every deposit mints a NEW id; withdraw closes a whole id.
///           • deposits pull via transferFrom(msg.sender); withdraw / harvest / claimStakingRewards
///             pay the OWNER by transfer; harvest reverts on staked ids, claimStakingRewards on
///             unstaked ones; outOfRangeSince tracks range (0 = in range).
///           • the 60 s flash-loan hold (settable; default 0 for terse unit tests).
///         Plus switches that reproduce the engine failure modes the venue must survive: a
///         glitching index, a paused engine, an un-closable id, an id that refuses both claims.
contract MockSnuggleVault is ISnuggleVault {
    using SafeERC20 for IERC20;

    error PoolNotApproved(bytes32 poolId);
    error NotOwner();
    error UseClaimStakingRewards();
    error NotStaked();
    error ZeroLiquidityMinted();
    error MinimumHoldTimeNotMet();
    error EnginePaused();
    error Expired();
    error WithdrawRefused(uint256 tokenId);
    error ClaimRefused(uint256 tokenId);

    struct Pool {
        address pool;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        bool active;
    }

    struct Pos {
        bytes32 poolId;
        address owner;
        uint24 rangeWidthBps;
        uint64 rebalanceDelay;
        bool autoSnuggle;
        bool autoCompound;
        uint64 outOfRangeSince;
        uint64 depositTimestamp;
        uint256 amount0;
        uint256 amount1;
        bool exists;
    }

    uint256 private constant Q96 = 2 ** 96;

    mapping(bytes32 => Pool) internal pools;
    bytes32[] internal _poolIds;

    uint256 public nextTokenId = 1;
    mapping(uint256 => Pos) internal pos;
    mapping(uint256 => bool) public staked;
    mapping(address => uint256[]) internal _userPositions;

    // pending payouts per tokenId, transferred to the owner on claim
    mapping(uint256 => address[]) internal feeTokens;
    mapping(uint256 => uint256[]) internal feeAmounts;

    /// @notice How the index getter fails past the end: the live engine's empty revert (default,
    ///         measured) or the `Panic(0x32)` variant.
    enum EndShape {
        Empty,
        Panic32
    }

    // failure-mode switches
    EndShape public endShape;
    uint256 public minHoldTime;
    uint256 public withdrawSlippageBps;
    uint256 public singleSidedResidualBps;
    bool public paused;
    address public glitchUser;
    uint256 public glitchIndex;
    bool public glitchArmed;
    mapping(uint256 => bool) public withdrawRefused;
    mapping(uint256 => bool) public claimRefused;

    // ------------------------------------------------------------ test hooks

    function addPool(bytes32 id, address poolAddr, address token0, address token1, uint24 fee)
        external
    {
        int24 spacing = poolAddr.code.length != 0 ? MockCLPool(poolAddr).tickSpacing() : int24(100);
        pools[id] = Pool(poolAddr, token0, token1, fee, spacing, true);
        _poolIds.push(id);
    }

    function setPoolActive(bytes32 id, bool active) external {
        pools[id].active = active;
    }

    function setMinHoldTime(uint256 s) external {
        minHoldTime = s;
    }

    function setWithdrawSlippageBps(uint256 b) external {
        withdrawSlippageBps = b;
    }

    /// @dev Fraction of a single-sided deposit the engine hands back in the SAME token (≈ 0 live).
    function setSingleSidedResidualBps(uint256 b) external {
        singleSidedResidualBps = b;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setEndShape(EndShape s) external {
        endShape = s;
    }

    /// @dev Make `userPositions(user, index)` revert with a NON-end-of-list shape.
    function setGlitch(address user, uint256 index, bool armed) external {
        glitchUser = user;
        glitchIndex = index;
        glitchArmed = armed;
    }

    function setWithdrawRefused(uint256 tokenId, bool v) external {
        withdrawRefused[tokenId] = v;
    }

    function setClaimRefused(uint256 tokenId, bool v) external {
        claimRefused[tokenId] = v;
    }

    /// @dev Fund this contract with `token` first (mimics accrued fees / AERO).
    function setPendingFee(uint256 tokenId, address token, uint256 amount) external {
        feeTokens[tokenId].push(token);
        feeAmounts[tokenId].push(amount);
    }

    function setStaked(uint256 tokenId, bool v) external {
        staked[tokenId] = v;
    }

    function setOutOfRangeSince(uint256 tokenId, uint64 since) external {
        pos[tokenId].outOfRangeSince = since;
    }

    /// @dev FACT 2 — keeper rebalance: the id is REPLACED. Old id gone from the list and zeroed.
    function rekey(uint256 tokenId) external returns (uint256 newId) {
        Pos memory x = _mustPos(tokenId);
        _prune(x.owner, tokenId);
        delete pos[tokenId];
        newId = _mint(x.poolId, x.owner, x.rangeWidthBps, x.rebalanceDelay, x.autoSnuggle, x.autoCompound, x.amount0, x.amount1);
    }

    function positionAmounts(uint256 tokenId) external view returns (uint256, uint256) {
        return (pos[tokenId].amount0, pos[tokenId].amount1);
    }

    function userPositionCount(address user) external view returns (uint256) {
        return _userPositions[user].length;
    }

    // ------------------------------------------------------------ engine API

    function deposit(
        bytes32 poolId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint24 rangeWidthBps,
        uint256 rebalanceDelay,
        bool autoSnuggleEnabled,
        bool autoCompoundEnabled,
        uint256 deadline,
        address
    ) external returns (uint256 tokenId) {
        _live();
        if (deadline < block.timestamp) revert Expired();
        Pool storage p = _mustPool(poolId);
        if (amount0Desired == 0 || amount1Desired == 0) revert ZeroLiquidityMinted();
        IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        // Balanced part at the pool price; bounce the excess of the long leg (FACT 4).
        uint160 sqrtP = MockCLPool(p.pool).sqrtPriceX96();
        uint256 v0in1 = Math.mulDiv(Math.mulDiv(amount0Desired, sqrtP, Q96), sqrtP, Q96);
        uint256 keep0 = amount0Desired;
        uint256 keep1 = amount1Desired;
        if (v0in1 > amount1Desired) {
            keep0 = Math.mulDiv(Math.mulDiv(amount1Desired, Q96, sqrtP), Q96, sqrtP);
            uint256 bounce0 = amount0Desired - keep0;
            if (bounce0 != 0) IERC20(p.token0).safeTransfer(msg.sender, bounce0);
        } else if (v0in1 < amount1Desired) {
            keep1 = v0in1;
            uint256 bounce1 = amount1Desired - keep1;
            if (bounce1 != 0) IERC20(p.token1).safeTransfer(msg.sender, bounce1);
        }
        if (keep0 == 0 || keep1 == 0) revert ZeroLiquidityMinted();
        tokenId = _mint(
            poolId, msg.sender, rangeWidthBps, uint64(rebalanceDelay), autoSnuggleEnabled,
            autoCompoundEnabled, keep0, keep1
        );
    }

    function depositSingleSided(
        bytes32 poolId,
        address token,
        uint256 amount,
        uint24 rangeWidthBps,
        uint256 rebalanceDelay,
        bool autoSnuggleEnabled,
        bool autoCompoundEnabled,
        uint256 deadline,
        address
    ) external returns (uint256 tokenId) {
        _live();
        if (deadline < block.timestamp) revert Expired();
        Pool storage p = _mustPool(poolId);
        if (token != p.token0 && token != p.token1) revert PoolNotApproved(poolId);
        if (amount == 0) revert ZeroLiquidityMinted();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 residual = (amount * singleSidedResidualBps) / 10_000;
        if (residual != 0) IERC20(token).safeTransfer(msg.sender, residual);
        uint256 kept = amount - residual;
        (uint256 a0, uint256 a1) = token == p.token0 ? (kept, uint256(0)) : (uint256(0), kept);
        tokenId = _mint(
            poolId, msg.sender, rangeWidthBps, uint64(rebalanceDelay), autoSnuggleEnabled,
            autoCompoundEnabled, a0, a1
        );
    }

    function withdraw(uint256 tokenId, bool) external {
        _live();
        Pos storage x = _mustPos(tokenId);
        if (msg.sender != x.owner) revert NotOwner();
        if (withdrawRefused[tokenId]) revert WithdrawRefused(tokenId);
        if (block.timestamp < x.depositTimestamp + minHoldTime) revert MinimumHoldTimeNotMet();
        Pool storage p = pools[x.poolId];
        uint256 keep = 10_000 - withdrawSlippageBps;
        uint256 pay0 = (x.amount0 * keep) / 10_000;
        uint256 pay1 = (x.amount1 * keep) / 10_000;
        address owner = x.owner;
        _prune(owner, tokenId);
        delete pos[tokenId];
        if (pay0 > 0) IERC20(p.token0).safeTransfer(owner, pay0);
        if (pay1 > 0) IERC20(p.token1).safeTransfer(owner, pay1);
    }

    function harvest(uint256 tokenId) external {
        _live();
        if (staked[tokenId]) revert UseClaimStakingRewards();
        if (claimRefused[tokenId]) revert ClaimRefused(tokenId);
        _payout(tokenId);
    }

    function claimStakingRewards(uint256 tokenId) external returns (uint256 earned) {
        _live();
        if (!staked[tokenId]) revert NotStaked();
        if (claimRefused[tokenId]) revert ClaimRefused(tokenId);
        earned = _payout(tokenId);
    }

    function updateParameters(uint256 tokenId, uint256 d, uint24 w, bool s, bool c) external {
        Pos storage x = _mustPos(tokenId);
        if (msg.sender != x.owner) revert NotOwner();
        (x.rebalanceDelay, x.rangeWidthBps, x.autoSnuggle, x.autoCompound) = (uint64(d), w, s, c);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint256,
            bytes32,
            address,
            uint24,
            int24,
            int24,
            bool,
            bool,
            uint64,
            uint64,
            uint32,
            uint32,
            uint64,
            uint128,
            uint128,
            uint128,
            uint128
        )
    {
        // A deleted / re-keyed id reads all-zero (FACT 2): the storage struct is zero after delete.
        Pos storage x = pos[tokenId];
        return (
            x.exists ? tokenId : 0,
            x.poolId,
            x.owner,
            x.rangeWidthBps,
            0,
            0,
            x.autoSnuggle,
            x.autoCompound,
            x.rebalanceDelay,
            x.outOfRangeSince,
            0,
            0,
            x.depositTimestamp,
            0,
            0,
            0,
            0
        );
    }

    function approvedPools(bytes32 poolId)
        external
        view
        returns (address, address, address, uint24, int24, bool, address, address)
    {
        Pool storage p = pools[poolId];
        return (p.pool, p.token0, p.token1, p.fee, p.tickSpacing, p.active, address(0), address(0));
    }

    /// @dev FACT 1: index getter. Past the end it reverts EMPTY, as the live engine measured
    ///      (Addendum 3), or `Panic(0x32)` under `setEndShape(Panic32)`. The glitch switch
    ///      reproduces "some other revert" mid-list.
    function userPositions(address user, uint256 index) external view returns (uint256) {
        _live();
        if (glitchArmed && user == glitchUser && index == glitchIndex) revert("engine glitch");
        uint256[] storage list = _userPositions[user];
        if (index >= list.length) {
            if (endShape == EndShape.Panic32) return list[index]; // Panic(0x32)
            revert(); // the measured live shape: no data
        }
        return list[index];
    }

    function poolIds(uint256 i) external view returns (bytes32) {
        return _poolIds[i];
    }

    function poolIdsCount() external view returns (uint256) {
        _live();
        return _poolIds.length;
    }

    // -------------------------------------------------------------- internal

    function _mint(
        bytes32 poolId,
        address owner,
        uint24 w,
        uint64 d,
        bool s,
        bool c,
        uint256 a0,
        uint256 a1
    ) internal returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        pos[tokenId] = Pos(poolId, owner, w, d, s, c, 0, uint64(block.timestamp), a0, a1, true);
        _userPositions[owner].push(tokenId);
    }

    function _prune(address owner, uint256 tokenId) internal {
        uint256[] storage list = _userPositions[owner];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == tokenId) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    function _payout(uint256 tokenId) internal returns (uint256 total) {
        Pos storage x = _mustPos(tokenId);
        address[] memory ts = feeTokens[tokenId];
        uint256[] memory as_ = feeAmounts[tokenId];
        for (uint256 i = 0; i < ts.length; i++) {
            if (as_[i] > 0) {
                IERC20(ts[i]).safeTransfer(x.owner, as_[i]);
                total += as_[i];
            }
        }
        delete feeTokens[tokenId];
        delete feeAmounts[tokenId];
    }

    function _mustPool(bytes32 poolId) internal view returns (Pool storage p) {
        p = pools[poolId];
        if (!p.active) revert PoolNotApproved(poolId);
    }

    function _mustPos(uint256 tokenId) internal view returns (Pos storage x) {
        x = pos[tokenId];
        if (!x.exists) revert PoolNotApproved(bytes32(tokenId));
    }

    function _live() internal view {
        if (paused) revert EnginePaused();
    }
}
