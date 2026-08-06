// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISnuggleVault — REAL external surface of SnuggleVaultUpgradeable.
///
/// @notice Extracted from the verified implementation behind the MaxFi Vault
///         proxy on Base (proxy 0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55,
///         impl 0x359f90ee4c2e21cbf6e32c5a062eeef306822d28, solc 0.8.33,
///         source: base.blockscout.com verified code, fetched 2026-08-05).
///         MaxFi and SnuggleFi share this contract ("Snuggle protocol").
///
/// Semantics that shaped our adapter:
///   • poolId is a bytes32 registry key (`approvedPools`), NOT a pool address.
///   • withdraw() closes the WHOLE position — no partial exits. Partials are
///     emulated adapter-side (close → pay share → re-deposit remainder).
///   • harvest()/claimStakingRewards() route fees through the engine vault for
///     its 15% performance fee, then pay the position owner — collect by
///     balance-diff, not return values.
///   • No pending-fee views; range status is tracked engine-side via
///     `outOfRangeSince` (0 = in range).
///   • `ref` is a referral address, immutable after first deposit per user.
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

    /// @notice Auto-generated public-mapping getter → flattened UserPosition.
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

    function userPositions(address user) external view returns (uint256[] memory);

    function poolIds(uint256 index) external view returns (bytes32);

    function poolIdsCount() external view returns (uint256);
}
