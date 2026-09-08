// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICollateralVenue — one lending venue as seen by the account, the router and the keeper.
///
/// @notice Mutating functions are called BY an OilskinAccount (it is `msg.sender`); the venue then
///         instructs the account so the ACCOUNT is the depositor / borrower at the underlying
///         protocol (`onBehalfOf` = account, funds always to the account). Views take the account
///         explicitly and are plain reads. Risk parameters are read from the venue at call time —
///         a venue never carries a liquidation threshold or LTV constant.
interface ICollateralVenue {
    /// @notice Supply `amount` of `asset` from the calling account as collateral of that account.
    function supply(address asset, uint256 amount) external;

    /// @notice Withdraw `amount` of `asset` (type(uint256).max = all) to the calling account.
    /// @return withdrawn Amount actually withdrawn.
    function withdraw(address asset, uint256 amount) external returns (uint256 withdrawn);

    /// @notice Borrow `amount` of `asset` on behalf of the calling account; funds land in it. On
    ///         an isolated-market venue the market is the venue's choice (most headroom that can
    ///         fill the amount); use `borrowAgainst` when the collateral is known.
    function borrow(address asset, uint256 amount) external;

    /// @notice Borrow `amount` of `loanToken` against `collateralAsset` specifically. On a
    ///         cross-collateral venue (Aave) this is `borrow`; on an isolated-market venue (Morpho)
    ///         the debt lands in `collateralAsset`'s market, so the review screen's liquidation
    ///         price names the asset the debt is really against (audit wave 2, M-MED-1).
    function borrowAgainst(address collateralAsset, address loanToken, uint256 amount) external;

    /// @notice Repay `amount` of `asset` (type(uint256).max = full debt) from the calling account.
    /// @return repaid Amount actually repaid.
    function repay(address asset, uint256 amount) external returns (uint256 repaid);

    /// @notice Health factor (WAD; type(uint256).max when there is no debt).
    function healthFactor(address account) external view returns (uint256);

    /// @notice Liquidation threshold of `asset` in bps, read live from the venue.
    function liquidationThresholdBps(address asset) external view returns (uint256);

    /// @notice Maximum LTV the venue allows for `asset` in bps, read live.
    function maxLtvBps(address asset) external view returns (uint256);

    /// @notice Current variable debt of `account` in `asset`, raw units.
    function debt(address account, address asset) external view returns (uint256);

    /// @notice Current collateral balance of `account` in `asset`, raw units.
    function collateral(address account, address asset) external view returns (uint256);

    /// @notice Variable borrow rate of `asset` as a ray (1e27 = 100 % APR).
    function borrowRateRay(address asset) external view returns (uint256);

    /// @notice False for a venue with nothing to serve (a MorphoBlueVenue built over no markets, as on
    ///         Base Sepolia). The registry refuses to point an asset at a venue that reports false.
    function enabled() external view returns (bool);
}
