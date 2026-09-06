// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICollateralRegistry — the slice of the registry a VENUE needs to enforce policy itself.
///
/// @notice A venue that reads this cannot be talked past by choosing a different entry point: the
///         entry health-factor floor and the "is this asset offered at all" flag are enforced where
///         the money moves, not in one router function. Exit-side calls (withdraw / repay) never
///         consult it — an exit is never gated.
interface ICollateralRegistry {
    /// @notice Minimum health factor (WAD) any NEW debt must leave the account at.
    function entryHfFloorWad() external view returns (uint256);

    /// @notice Whether `asset` may be taken as collateral at all.
    function isEnabled(address asset) external view returns (bool);

    /// @notice The venue the registry currently points `asset` at (address(0) = unknown asset).
    function venueOf(address asset) external view returns (address);
}
