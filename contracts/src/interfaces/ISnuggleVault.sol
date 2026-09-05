// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISnuggleVault — REAL external surface of SnuggleVaultUpgradeable (MaxFi / Snuggle engine).
///
/// @notice Proxy on Base 0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55, implementation (EIP-1967)
///         0x359f90ee4c2e21cbf6e32c5a062eeef306822d28. Re-verified against the live chain on
///         2026-09-03 (AUDIT-FINDINGS-2026-09-03 Part 1, head ≈ block 50,821,540):
///
///   FACT 1  `userPositions` is the compiler-generated getter of `mapping(address => uint256[])`:
///           `userPositions(address,uint256) returns (uint256)` — one id per index, REVERTS past the
///           end. `userPositions(address) returns (uint256[])` DOES NOT EXIST (selector 0x613cf420
///           reverts). Enumerate by index until revert; the revert shape is measured at runtime by
///           a canary probe, never assumed (SnuggleLpVenue.positionsOf).
///   FACT 2  Re-key (keeper rebalance) REPLACES the id: the old id is removed from the list and
///           `positions(old)` reads back all-zero; the new id is in the list.
///   FACT 3  `rangeWidthBps` is the TOTAL tick span (1 bps = 1 tick). Deployed bounds [150, 5000].
///   FACT 4  `depositSingleSided` swaps to ratio inside the engine, ≈ zero residual. Dual `deposit`
///           mints the balanced part and bounces the excess of the long leg to msg.sender. There is
///           NO increaseLiquidity: every deposit mints a NEW id; `withdraw(id)` closes a whole id.
///   Also:   poolId is a bytes32 registry key (`approvedPools`), not a pool address; harvest /
///           claimStakingRewards pay the owner by transfer (measure by balance diff), net of the
///           engine's own performance fee; `ref` is a referral address locked at first deposit.
interface ISnuggleVault {
    function deposit(
        bytes32 poolId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint24 rangeWidthBps,
        uint256 rebalanceDelay,
        bool autoSnuggleEnabled,
        bool autoCompoundEnabled,
        uint256 deadline,
        address ref
    ) external returns (uint256 tokenId);

    function depositSingleSided(
        bytes32 poolId,
        address token,
        uint256 amount,
        uint24 rangeWidthBps,
        uint256 rebalanceDelay,
        bool autoSnuggleEnabled,
        bool autoCompoundEnabled,
        uint256 deadline,
        address ref
    ) external returns (uint256 tokenId);

    /// @notice Closes the position entirely; tokens are sent to the owner.
    function withdraw(uint256 tokenId, bool returnNFT) external;

    /// @notice Collect trading fees (reverts if position is staked).
    function harvest(uint256 tokenId) external;

    /// @notice Claim staking rewards + trading fees for staked positions.
    function claimStakingRewards(uint256 tokenId) external returns (uint256 earned);

    function updateParameters(
        uint256 tokenId,
        uint256 newRebalanceDelay,
        uint24 newRangeWidthBps,
        bool newAutoSnuggleEnabled,
        bool newAutoCompoundEnabled
    ) external;

    /// @notice Auto-generated public-mapping getter → flattened UserPosition. All-zero after a
    ///         withdraw or a re-key (FACT 2).
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint256 tokenId_,
            bytes32 poolId,
            address owner,
            uint24 rangeWidthBps,
            int24 currentTickLower,
            int24 currentTickUpper,
            bool autoSnuggleEnabled,
            bool autoCompoundEnabled,
            uint64 rebalanceDelay,
            uint64 outOfRangeSince,
            uint32 totalRebalances,
            uint32 lastRebalanceTime,
            uint64 depositTimestamp,
            uint128 cumulativeFees0,
            uint128 cumulativeFees1,
            uint128 cumulativeRewards,
            uint128 reserved
        );

    /// @notice Auto-generated public-mapping getter → flattened PoolConfig.
    function approvedPools(bytes32 poolId)
        external
        view
        returns (
            address pool,
            address token0,
            address token1,
            uint24 fee,
            int24 tickSpacing,
            bool active,
            address positionAdapter,
            address rewardAdapter
        );

    /// @notice FACT 1 — index getter. Reverts past the end of `user`'s list.
    function userPositions(address user, uint256 index) external view returns (uint256 tokenId);

    function poolIds(uint256 index) external view returns (bytes32);

    function poolIdsCount() external view returns (uint256);
}
