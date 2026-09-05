// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Peripheral} from "../account/Peripheral.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {IMorphoBlue, MarketParams} from "../interfaces/IMorphoBlue.sol";

/// @title MorphoBlueVenue — SKELETON. Ships DISABLED in v1.
///
/// @notice Morpho Blue on Base (0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb) holds code, but the live
///         market ids for cbBTC/USDC and WETH/USDC were NOT discovered when VERIFIED-BASE-FACTS was
///         written (the public GraphQL listing failed on schema field names three times), and no
///         cbZEC market exists. Every mutating function and every risk view therefore reverts
///         `VenueDisabled` — a router or keeper that reaches this venue fails closed rather than
///         acting on a market it cannot see.
///
/// @dev TODO (v1.1, venue-adapter engineer) — market discovery, in this order:
///        1. Enumerate `CreateMarket(Id indexed id, MarketParams marketParams)` events on the Morpho
///           Blue contract (topic0 = keccak256("CreateMarket(bytes32,(address,address,address,address,uint256))"))
///           and keep those whose loanToken == USDC and collateralToken ∈ {cbBTC, WETH}.
///        2. For each candidate read `market(id)` (liquidity, lastUpdate) and `idToMarketParams(id)`
///           (oracle, irm, lltv); cross-check `marketId(params) == id` with the helper below.
///        3. Choose per asset the market with the deepest USDC supply and an oracle whose source is
///           a Chainlink feed from VERIFIED-BASE-FACTS; record (id, params, lltv, oracle) in
///           VERIFIED-BASE-FACTS with block height and date BEFORE wiring it here.
///        4. Replace the reverts: `liquidationThresholdBps` = lltv / 1e14 (Morpho LLTV is WAD),
///           `maxLtvBps` = same (Morpho has one threshold), `healthFactor` = collateral × price ×
///           lltv / borrowAssets, mutators via `supplyCollateral` / `borrow` / `repay` /
///           `withdrawCollateral` with onBehalf = receiver = the calling account.
///        5. Re-run the fork suite against the chosen ids and flip `enabled()`.
contract MorphoBlueVenue is ICollateralVenue, Peripheral {
    IMorphoBlue public immutable MORPHO;

    error VenueDisabled();

    constructor(IMorphoBlue morpho) {
        MORPHO = morpho;
    }

    /// @notice Morpho's market id derivation, for the discovery step and for tests.
    function marketId(MarketParams memory params) public pure returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    /// @inheritdoc ICollateralVenue
    function supply(address, uint256) external pure override {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function withdraw(address, uint256) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function borrow(address, uint256) external pure override {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function repay(address, uint256) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function healthFactor(address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function liquidationThresholdBps(address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function maxLtvBps(address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function debt(address, address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function collateral(address, address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function borrowRateRay(address) external pure override returns (uint256) {
        revert VenueDisabled();
    }

    /// @inheritdoc ICollateralVenue
    function enabled() external pure override returns (bool) {
        return false;
    }
}
