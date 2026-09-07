// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Morpho Blue market key. `Id = keccak256(abi.encode(MarketParams))`.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice Morpho Blue market state, the six words `market(id)` returns, in order.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @notice Minimal Morpho Blue surface (Base: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb, code
///         presence verified 2026-09-05; the cbBTC/USDC and WETH/USDC market ids were read from
///         `idToMarketParams` on 2026-09-07 — VERIFIED-BASE-FACTS, Morpho addendum).
interface IMorphoBlue {
    function supplyCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        bytes memory data
    ) external;

    function withdrawCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    function idToMarketParams(bytes32 id)
        external
        view
        returns (
            address loanToken,
            address collateralToken,
            address oracle,
            address irm,
            uint256 lltv
        );
}

/// @notice Morpho's oracle interface: price of 1 collateral unit in loan units, scaled by 1e36.
interface IMorphoOracle {
    function price() external view returns (uint256);
}

/// @notice Morpho's interest-rate model. `borrowRateView` is the per-second borrow rate (WAD) the
///         market would accrue at right now; Morpho itself calls the mutating `borrowRate`.
interface IIrm {
    function borrowRateView(MarketParams memory marketParams, Market memory market)
        external
        view
        returns (uint256);
}
