// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    IAaveOracle,
    IAavePool,
    IAavePoolDataProvider,
    IPoolAddressesProvider
} from "../../src/interfaces/IAaveV3.sol";

/// @notice Aave v3 test double: PoolAddressesProvider + Pool + PoolDataProvider + Oracle in one.
///         Reserve parameters are set by tests to the values VERIFIED on Base 2026-09-05
///         (cbBTC LT 7800 / LTV 7300, WETH 8300 / 8000, USDC 7800 / 7500 borrowable). Semantics we
///         rely on: supply pulls from msg.sender and credits `onBehalfOf`; borrow requires
///         msg.sender == onBehalfOf (no credit delegation configured) and pays msg.sender; withdraw
///         pays `to`; repay pulls from msg.sender for `onBehalfOf`; borrowing power = Σ collateral ×
///         LTV; withdraw must leave HF ≥ 1; HF = Σ collateral × LT / debt (WAD, max when no debt).
contract MockAave is IPoolAddressesProvider, IAavePool, IAavePoolDataProvider, IAaveOracle {
    using SafeERC20 for IERC20;

    struct Reserve {
        bool listed;
        uint256 ltvBps;
        uint256 ltBps;
        uint256 bonusBps;
        bool collateralEnabled;
        bool borrowable;
        uint256 priceE8;
        uint256 variableBorrowRateRay;
        uint8 decimals;
    }

    error ReserveNotListed(address asset);
    error CollateralCannotCoverNewBorrow();
    error HealthFactorBelowOne();
    error BorrowingNotEnabled(address asset);
    error CreditDelegationNotSupported();
    error InvalidRateMode();

    mapping(address => Reserve) public reserves;
    address[] public listedAssets;
    mapping(address => mapping(address => uint256)) public collateralOf;
    mapping(address => mapping(address => uint256)) public debtOf;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    // --------------------------------------------------------------- hooks

    function setReserve(
        address asset,
        uint256 ltvBps,
        uint256 ltBps,
        uint256 bonusBps,
        bool collateralEnabled,
        bool borrowable,
        uint256 priceE8,
        uint256 variableBorrowRateRay
    ) external {
        if (!reserves[asset].listed) listedAssets.push(asset);
        reserves[asset] = Reserve({
            listed: true,
            ltvBps: ltvBps,
            ltBps: ltBps,
            bonusBps: bonusBps,
            collateralEnabled: collateralEnabled,
            borrowable: borrowable,
            priceE8: priceE8,
            variableBorrowRateRay: variableBorrowRateRay,
            decimals: IERC20Metadata(asset).decimals()
        });
    }

    function setPrice(address asset, uint256 priceE8) external {
        reserves[asset].priceE8 = priceE8;
    }

    /// @dev The measured rounding (VERIFIED-BASE-FACTS Addendum 3): Aave reads a same-block borrow
    ///      `units` over what it lent. A test-only hook; the real pool does this on its own.
    function bumpDebt(address user, address asset, uint256 units) external {
        debtOf[user][asset] += units;
    }

    /// @dev Simulate interest: grow a user's debt by `bps`.
    function accrueDebt(address user, address asset, uint256 bps) external {
        debtOf[user][asset] += (debtOf[user][asset] * bps) / BPS;
    }

    // ------------------------------------------------------------ provider

    function getPool() external view returns (address) {
        return address(this);
    }

    function getPoolDataProvider() external view returns (address) {
        return address(this);
    }

    function getPriceOracle() external view returns (address) {
        return address(this);
    }

    // ---------------------------------------------------------------- pool

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        Reserve storage r = _listed(asset);
        if (!r.collateralEnabled) revert ReserveNotListed(asset);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[onBehalfOf][asset] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        _listed(asset);
        uint256 have = collateralOf[msg.sender][asset];
        uint256 out = amount > have ? have : amount;
        collateralOf[msg.sender][asset] = have - out;
        if (_totalDebtBase(msg.sender) != 0 && _healthFactor(msg.sender) < WAD) {
            revert HealthFactorBelowOne();
        }
        IERC20(asset).safeTransfer(to, out);
        return out;
    }

    function borrow(address asset, uint256 amount, uint256 mode, uint16, address onBehalfOf)
        external
    {
        Reserve storage r = _listed(asset);
        if (mode != 2) revert InvalidRateMode();
        if (!r.borrowable) revert BorrowingNotEnabled(asset);
        if (onBehalfOf != msg.sender) revert CreditDelegationNotSupported();
        debtOf[onBehalfOf][asset] += amount;
        if (_totalDebtBase(onBehalfOf) > _borrowPowerBase(onBehalfOf)) {
            revert CollateralCannotCoverNewBorrow();
        }
        IERC20(asset).safeTransfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256 mode, address onBehalfOf)
        external
        returns (uint256)
    {
        _listed(asset);
        if (mode != 2) revert InvalidRateMode();
        uint256 owed = debtOf[onBehalfOf][asset];
        uint256 paid = amount > owed ? owed : amount;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), paid);
        debtOf[onBehalfOf][asset] = owed - paid;
        return paid;
    }

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        totalCollateralBase = _totalCollateralBase(user);
        totalDebtBase = _totalDebtBase(user);
        uint256 power = _borrowPowerBase(user);
        availableBorrowsBase = power > totalDebtBase ? power - totalDebtBase : 0;
        currentLiquidationThreshold =
            totalCollateralBase == 0 ? 0 : (_weightedLtBase(user) * BPS) / totalCollateralBase;
        ltv = totalCollateralBase == 0 ? 0 : (power * BPS) / totalCollateralBase;
        healthFactor = _healthFactor(user);
    }

    // ------------------------------------------------------- data provider

    function getReserveConfigurationData(address asset)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool)
    {
        Reserve storage r = reserves[asset];
        // Unlisted assets return zeros — exactly what Base returns for cbZEC.
        return (
            r.decimals,
            r.ltvBps,
            r.ltBps,
            r.bonusBps,
            0,
            r.collateralEnabled,
            r.borrowable,
            false,
            r.listed,
            false
        );
    }

    function getReserveData(address asset)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint40
        )
    {
        Reserve storage r = reserves[asset];
        return (0, 0, 0, 0, 0, 0, r.variableBorrowRateRay, 0, 0, 0, 0, uint40(block.timestamp));
    }

    function getUserReserveData(address asset, address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint40, bool)
    {
        return (
            collateralOf[user][asset],
            0,
            debtOf[user][asset],
            0,
            0,
            0,
            0,
            uint40(block.timestamp),
            collateralOf[user][asset] != 0
        );
    }

    // -------------------------------------------------------------- oracle

    function getAssetPrice(address asset) external view returns (uint256) {
        return reserves[asset].priceE8;
    }

    // ------------------------------------------------------------ internal

    function _listed(address asset) internal view returns (Reserve storage r) {
        r = reserves[asset];
        if (!r.listed) revert ReserveNotListed(asset);
    }

    function _valueBase(address asset, uint256 amount) internal view returns (uint256) {
        Reserve storage r = reserves[asset];
        return (amount * r.priceE8) / (10 ** r.decimals);
    }

    function _totalCollateralBase(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < listedAssets.length; i++) {
            total += _valueBase(listedAssets[i], collateralOf[user][listedAssets[i]]);
        }
    }

    function _weightedLtBase(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < listedAssets.length; i++) {
            address a = listedAssets[i];
            total += (_valueBase(a, collateralOf[user][a]) * reserves[a].ltBps) / BPS;
        }
    }

    function _borrowPowerBase(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < listedAssets.length; i++) {
            address a = listedAssets[i];
            total += (_valueBase(a, collateralOf[user][a]) * reserves[a].ltvBps) / BPS;
        }
    }

    function _totalDebtBase(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < listedAssets.length; i++) {
            total += _valueBase(listedAssets[i], debtOf[user][listedAssets[i]]);
        }
    }

    function _healthFactor(address user) internal view returns (uint256) {
        uint256 debt = _totalDebtBase(user);
        if (debt == 0) return type(uint256).max;
        return (_weightedLtBase(user) * WAD) / debt;
    }
}
