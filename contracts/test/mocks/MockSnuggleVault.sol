// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";

/// @notice Test double for SnuggleVaultUpgradeable, faithful to the REAL
///         semantics our adapter depends on:
///           • bytes32 poolId registry (approvedPools)
///           • deposits pull via transferFrom(msg.sender)
///           • deposits REFUND un-fitting leftovers to msg.sender in the same
///             tx (live receipts show ~0.88% of a leg refunded; refundBps
///             defaults to 88 and is configurable)
///           • withdraw() closes the WHOLE position, pays the owner — and ALSO
///             pays accrued fees / staking rewards (e.g. AERO) in the same tx
///             (PositionWithdrawn + FeesHarvested/StakingRewardsClaimed share
///             a tx in the live fixtures)
///           • the keeper's rebalance() RE-KEYS the position: a NEW tokenId is
///             minted and positions(oldId) empties (verified live 2026-08-27)
///           • harvest() reverts for staked positions (use claimStakingRewards)
///           • fees/rewards are PAID BY TRANSFER to the owner (balance-diff),
///             not returned
///           • userPositions(owner) always reflects the LIVE tokenId set
///           • outOfRangeSince tracks range status (0 = in range)
contract MockSnuggleVault is ISnuggleVault {
    using SafeERC20 for IERC20;

    error PoolNotApproved(bytes32 poolId);
    error NotOwner();
    error UseClaimStakingRewards();
    error NotStaked();
    /// @dev Mirrors live-engine behavior (fork-verified): dual deposit with a
    ///      zero side mints zero liquidity and reverts at the pool.
    error ZeroLiquidityMinted();
    error PositionNotFound(uint256 tokenId);

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

    /// @dev Fork-verified live-engine behavior: flash-loan hold guard.
    ///      Settable (default 0) so simple unit tests stay terse; the invariant
    ///      suite and the dedicated hold test enable the real 60s.
    error MinimumHoldTimeNotMet();

    uint256 public minHoldTime;

    function setMinHoldTime(uint256 s) external {
        minHoldTime = s;
    }

    /// @dev Live-engine behavior: deposits refund the un-fitting leftover to
    ///      msg.sender in the deposit tx. Default mirrors the 0.88% seen on a
    ///      live receipt; configurable so specific tests can pin it.
    uint256 public refundBps = 88;

    function setRefundBps(uint256 b) external {
        refundBps = b;
    }

    /// @dev Live-engine behavior: withdraw also pays accrued fees/rewards to
    ///      the owner in the same tx. Hookable off for targeted tests.
    bool public payRewardsOnClose = true;

    function setPayRewardsOnClose(bool v) external {
        payRewardsOnClose = v;
    }

    /// @dev Simulate pool price-impact/slippage on exit: `withdraw` returns
    ///      this fraction less to the caller (the shortfall stays in the mock,
    ///      mimicking value left in the pool). Used to test the adapter's
    ///      minOut slippage floor.
    uint256 public withdrawSlippageBps;

    function setWithdrawSlippageBps(uint256 b) external {
        withdrawSlippageBps = b;
    }

    mapping(bytes32 => Pool) internal pools;
    bytes32[] internal _poolIds;

    uint256 public nextTokenId = 1;
    mapping(uint256 => Pos) internal pos;
    mapping(uint256 => bool) public staked;

    // live tokenId set per owner (the real engine maintains userPositions)
    mapping(address => uint256[]) internal _userPositions;
    mapping(uint256 => uint256) internal _userPosIndex;

    // pending payouts per tokenId (parallel arrays), transferred on claim
    mapping(uint256 => address[]) internal feeTokens;
    mapping(uint256 => uint256[]) internal feeAmounts;

    // ------------------------------------------------------------ test hooks

    function addPool(bytes32 id, address poolAddr, address token0, address token1, uint24 fee)
        external
    {
        pools[id] = Pool(poolAddr, token0, token1, fee, 60, true);
        _poolIds.push(id);
    }

    function setPoolActive(bytes32 id, bool active) external {
        pools[id].active = active;
    }

    // Simulates an engine upgrade re-ordering / corrupting the PoolConfig
    // GETTER layout (L-3): approvedPools(id) starts returning garbage while
    // the engine's internal accounting still works. An exit path that
    // re-reads the registry decodes junk token addresses and bricks.
    bytes32 internal _viewOverrideId;
    Pool internal _viewOverride;
    bool internal _viewOverrideSet;

    function corruptRegistryView(bytes32 id, address t0, address t1) external {
        _viewOverrideId = id;
        _viewOverride = Pool(address(0xdead), t0, t1, 0, 0, true);
        _viewOverrideSet = true;
    }

    /// @dev Fund this contract with `token` first (mimics accrued fees).
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

    function positionAmounts(uint256 tokenId) external view returns (uint256, uint256) {
        return (pos[tokenId].amount0, pos[tokenId].amount1);
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return pos[tokenId].exists;
    }

    /// @notice Keeper auto-snuggle: the LIVE engine mints a NEW tokenId and
    ///         empties the old one (SnuggleRebalanced(oldId, newId, ...)).
    ///         Public so handlers/invariants can drive rebalances at will.
    ///         Restarts the position's hold clock (fresh depositTimestamp) and
    ///         carries staking state and pending fees over to the new id.
    function rebalance(uint256 tokenId) external returns (uint256 newId) {
        Pos memory x = _mustPos(tokenId);
        newId = nextTokenId++;
        x.depositTimestamp = uint64(block.timestamp);
        x.outOfRangeSince = 0;
        pos[newId] = x;
        staked[newId] = staked[tokenId];
        feeTokens[newId] = feeTokens[tokenId];
        feeAmounts[newId] = feeAmounts[tokenId];
        _retrack(x.owner, tokenId, newId);
        delete pos[tokenId];
        delete staked[tokenId];
        delete feeTokens[tokenId];
        delete feeAmounts[tokenId];
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
        uint256,
        address
    ) external returns (uint256 tokenId) {
        Pool storage p = _mustPool(poolId);
        if (amount0Desired == 0 || amount1Desired == 0) revert ZeroLiquidityMinted();
        IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1Desired);
        // Live engine refunds the un-fitting leftover of the legs in-tx.
        amount0Desired = _refund(p.token0, amount0Desired);
        amount1Desired = _refund(p.token1, amount1Desired);
        tokenId = _mint(
            poolId,
            msg.sender,
            rangeWidthBps,
            uint64(rebalanceDelay),
            autoSnuggleEnabled,
            autoCompoundEnabled,
            amount0Desired,
            amount1Desired
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
        uint256,
        address
    ) external returns (uint256 tokenId) {
        Pool storage p = _mustPool(poolId);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        amount = _refund(token, amount);
        (uint256 a0, uint256 a1) = token == p.token0 ? (amount, uint256(0)) : (uint256(0), amount);
        tokenId = _mint(
            poolId,
            msg.sender,
            rangeWidthBps,
            uint64(rebalanceDelay),
            autoSnuggleEnabled,
            autoCompoundEnabled,
            a0,
            a1
        );
    }

    function withdraw(uint256 tokenId, bool) external {
        Pos storage x = _mustPos(tokenId);
        if (msg.sender != x.owner) revert NotOwner();
        if (block.timestamp < x.depositTimestamp + minHoldTime) {
            revert MinimumHoldTimeNotMet();
        }
        Pool storage p = pools[x.poolId];
        // Live engine pays accrued fees / staking rewards on close, same tx.
        if (payRewardsOnClose) _payout(tokenId);
        uint256 keep = 10_000 - withdrawSlippageBps;
        uint256 pay0 = (x.amount0 * keep) / 10_000;
        uint256 pay1 = (x.amount1 * keep) / 10_000;
        if (pay0 > 0) IERC20(p.token0).safeTransfer(x.owner, pay0);
        if (pay1 > 0) IERC20(p.token1).safeTransfer(x.owner, pay1);
        _untrack(x.owner, tokenId);
        delete pos[tokenId];
        delete staked[tokenId];
    }

    function harvest(uint256 tokenId) external {
        if (staked[tokenId]) revert UseClaimStakingRewards();
        _payout(tokenId);
    }

    function claimStakingRewards(uint256 tokenId) external returns (uint256 earned) {
        if (!staked[tokenId]) revert NotStaked();
        earned = _payout(tokenId);
    }

    function updateParameters(uint256 tokenId, uint256 d, uint24 w, bool s, bool c) external {
        Pos storage x = _mustPos(tokenId);
        if (msg.sender != x.owner) revert NotOwner();
        (x.rebalanceDelay, x.rangeWidthBps, x.autoSnuggle, x.autoCompound) =
            (uint64(d), w, s, c);
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
        Pos storage x = pos[tokenId];
        return (
            tokenId,
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
        Pool storage p =
            (_viewOverrideSet && poolId == _viewOverrideId) ? _viewOverride : pools[poolId];
        return (p.pool, p.token0, p.token1, p.fee, p.tickSpacing, p.active, address(0), address(0));
    }

    function userPositions(address user) external view returns (uint256[] memory) {
        return _userPositions[user];
    }

    function poolIds(uint256 i) external view returns (bytes32) {
        return _poolIds[i];
    }

    function poolIdsCount() external view returns (uint256) {
        return _poolIds.length;
    }

    // -------------------------------------------------------------- internal

    function _refund(address token, uint256 amount) internal returns (uint256 kept) {
        uint256 r = (amount * refundBps) / 10_000;
        if (r > 0) IERC20(token).safeTransfer(msg.sender, r);
        kept = amount - r;
    }

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
        pos[tokenId] =
            Pos(poolId, owner, w, d, s, c, 0, uint64(block.timestamp), a0, a1, true);
        _userPosIndex[tokenId] = _userPositions[owner].length;
        _userPositions[owner].push(tokenId);
    }

    function _untrack(address owner, uint256 tokenId) internal {
        uint256[] storage arr = _userPositions[owner];
        uint256 idx = _userPosIndex[tokenId];
        uint256 last = arr[arr.length - 1];
        arr[idx] = last;
        _userPosIndex[last] = idx;
        arr.pop();
        delete _userPosIndex[tokenId];
    }

    function _retrack(address owner, uint256 oldId, uint256 newId) internal {
        uint256 idx = _userPosIndex[oldId];
        _userPositions[owner][idx] = newId;
        _userPosIndex[newId] = idx;
        delete _userPosIndex[oldId];
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
        if (!x.exists) revert PositionNotFound(tokenId);
    }
}
