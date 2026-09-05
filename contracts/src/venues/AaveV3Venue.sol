// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {
    IAaveOracle,
    IAavePool,
    IAavePoolDataProvider,
    IPoolAddressesProvider
} from "../interfaces/IAaveV3.sol";

/// @title AaveV3Venue — ICollateralVenue over Aave v3 on Base (library-style: no storage, no admin).
///
/// @notice Every position lives under the calling ACCOUNT (`onBehalfOf` = account, `to` = account).
///         E-mode is not used in v1. Liquidation threshold and LTV are read from the
///         PoolDataProvider at call time; the pool, data provider and oracle are resolved through
///         the PoolAddressesProvider on every call so an Aave upgrade cannot strand us on a stale
///         address. Nothing here is a constant.
contract AaveV3Venue is ICollateralVenue, Peripheral {
    /// @notice Aave PoolAddressesProvider (Base: 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D).
    IPoolAddressesProvider public immutable PROVIDER;

    uint256 private constant VARIABLE_RATE = 2;
    uint16 private constant NO_REFERRAL = 0;

    error ZeroAmount();
    error NothingToRepay();

    constructor(IPoolAddressesProvider provider) {
        PROVIDER = provider;
    }

    // ------------------------------------------------------------- mutators

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: the account is `onBehalfOf`; the allowance is exact and reset to zero.
    function supply(address asset, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        _approveCallReset(
            asset,
            pool,
            amount,
            Call({
                target: pool,
                value: 0,
                data: abi.encodeCall(IAavePool.supply, (asset, amount, msg.sender, NO_REFERRAL))
            })
        );
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: funds go to the calling account and nowhere else.
    function withdraw(address asset, uint256 amount)
        external
        override
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        bytes memory ret =
            _exec(pool, abi.encodeCall(IAavePool.withdraw, (asset, amount, msg.sender)));
        withdrawn = abi.decode(ret, (uint256));
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: variable rate, `onBehalfOf` = the calling account (no credit delegation).
    function borrow(address asset, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        _exec(
            pool,
            abi.encodeCall(
                IAavePool.borrow, (asset, amount, VARIABLE_RATE, NO_REFERRAL, msg.sender)
            )
        );
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: repays the calling account's own debt only; approves exactly what is owed.
    function repay(address asset, uint256 amount) external override returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        uint256 owed = _debt(asset, msg.sender);
        if (owed == 0) revert NothingToRepay();
        uint256 toApprove = amount > owed ? owed : amount;
        bytes memory ret = _approveCallReset(
            asset,
            pool,
            toApprove,
            Call({
                target: pool,
                value: 0,
                data: abi.encodeCall(IAavePool.repay, (asset, amount, VARIABLE_RATE, msg.sender))
            })
        );
        repaid = abi.decode(ret, (uint256));
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc ICollateralVenue
    function healthFactor(address account) external view override returns (uint256 hf) {
        (,,,,, hf) = IAavePool(PROVIDER.getPool()).getUserAccountData(account);
    }

    /// @inheritdoc ICollateralVenue
    function liquidationThresholdBps(address asset) external view override returns (uint256 lt) {
        (,, lt,,,,,,,) = _data().getReserveConfigurationData(asset);
    }

    /// @inheritdoc ICollateralVenue
    function maxLtvBps(address asset) external view override returns (uint256 ltv) {
        (, ltv,,,,,,,,) = _data().getReserveConfigurationData(asset);
    }

    /// @inheritdoc ICollateralVenue
    function debt(address account, address asset) external view override returns (uint256) {
        return _debt(asset, account);
    }

    /// @inheritdoc ICollateralVenue
    function collateral(address account, address asset)
        external
        view
        override
        returns (uint256 aTokens)
    {
        (aTokens,,,,,,,,) = _data().getUserReserveData(asset, account);
    }

    /// @inheritdoc ICollateralVenue
    function borrowRateRay(address asset) external view override returns (uint256 rate) {
        (,,,,,, rate,,,,,) = _data().getReserveData(asset);
    }

    /// @inheritdoc ICollateralVenue
    function enabled() external pure override returns (bool) {
        return true;
    }

    /// @notice Aave oracle price of `asset` (USD, 8 decimals on Base).
    function assetPrice(address asset) external view returns (uint256) {
        return IAaveOracle(PROVIDER.getPriceOracle()).getAssetPrice(asset);
    }

    // ------------------------------------------------------------- internal

    function _data() internal view returns (IAavePoolDataProvider) {
        return IAavePoolDataProvider(PROVIDER.getPoolDataProvider());
    }

    function _debt(address asset, address account) internal view returns (uint256 variableDebt) {
        (,, variableDebt,,,,,,) = _data().getUserReserveData(asset, account);
    }
}
