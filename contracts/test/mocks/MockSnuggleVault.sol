// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";

/// @notice Test double for SnuggleVaultUpgradeable, faithful to the REAL
///         semantics our adapter depends on:
///           • bytes32 poolId registry (approvedPools)
///           • deposits pull via transferFrom(msg.sender)
///           • withdraw() closes the WHOLE position, pays the owner
///           • harvest() reverts for staked positions (use claimStakingRewards)
///           • fees/rewards are PAID BY TRANSFER to the owner (balance-diff),
///             not returned
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
        uint256 keep = 10_000 - withdrawSlippageBps;
        uint256 pay0 = (x.amount0 * keep) / 10_000;
        uint256 pay1 = (x.amount1 * keep) / 10_000;
        if (pay0 > 0) IERC20(p.token0).safeTransfer(x.owner, pay0);
        if (pay1 > 0) IERC20(p.token1).safeTransfer(x.owner, pay1);
        delete pos[tokenId];
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
        Pool storage p = pools[poolId];
        return (p.pool, p.token0, p.token1, p.fee, p.tickSpacing, p.active, address(0), address(0));
    }

    function userPositions(address) external pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function poolIds(uint256 i) external view returns (bytes32) {
        return _poolIds[i];
    }

    function poolIdsCount() external view returns (uint256) {
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
        pos[tokenId] =
            Pos(poolId, owner, w, d, s, c, 0, uint64(block.timestamp), a0, a1, true);
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
}
