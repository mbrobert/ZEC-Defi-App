// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {ICollateralRegistry} from "../interfaces/ICollateralRegistry.sol";
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
///
/// @dev **Policy lives on the ENTRY side of this contract, not in one router function.** `supply`
///      refuses an asset the registry does not offer at this venue, and `borrow` refuses any amount
///      that would leave the account below the registry's entry health-factor floor. There is
///      therefore no reachable sequence through this venue — the router, a raw owner `execBatch`, a
///      keeper call — that opens debt below the floor. `withdraw` and `repay` consult nothing: an
///      exit is never gated.
contract AaveV3Venue is ICollateralVenue, Peripheral {
    /// @notice Aave PoolAddressesProvider (Base: 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D).
    IPoolAddressesProvider public immutable PROVIDER;
    /// @notice The registry whose offer this venue enforces (entry floor + which assets are offered).
    ICollateralRegistry public immutable REGISTRY;

    uint256 private constant VARIABLE_RATE = 2;
    uint16 private constant NO_REFERRAL = 0;

    error ZeroAmount();
    error ZeroAddress();
    error NothingToRepay();
    /// @notice The account holds none of the loan token it asked to repay with (`held` = 0).
    error InsufficientLoanToken(address asset, uint256 held, uint256 owed);
    /// @notice The registry does not offer this asset at this venue (or has it disabled).
    error AssetNotOffered(address asset, address venue);
    /// @notice The borrow would leave the account below the registry's entry floor.
    error EntryHfTooLow(uint256 healthFactor, uint256 floor);

    constructor(IPoolAddressesProvider provider, ICollateralRegistry registry) {
        if (address(provider) == address(0) || address(registry) == address(0)) revert ZeroAddress();
        PROVIDER = provider;
        REGISTRY = registry;
    }

    // ------------------------------------------------------------- mutators

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: the registry offers `asset` at THIS venue and has it enabled (so the flag the
    ///      operator sets holds on every path, not only through the router — the day Aave lists cbZEC
    ///      the registry's `enabled = false` still keeps it out); the account is `onBehalfOf`; the
    ///      allowance is exact and reset to zero.
    function supply(address asset, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        if (REGISTRY.venueOf(asset) != address(this) || !REGISTRY.isEnabled(asset)) {
            revert AssetNotOffered(asset, address(this));
        }
        address pool = PROVIDER.getPool();
        _approveCallReset(
            asset,
            pool,
            amount,
            Call({
                target: pool,
                value: 0,
                data: abi.encodeCall(IAavePool.supply, (asset, amount, msg.sender, NO_REFERRAL)),
                callback: false
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
    /// @dev Invariant: variable rate, `onBehalfOf` = the calling account (no credit delegation), and
    ///      the account's GLOBAL health factor after the borrow is at or above the registry's entry
    ///      floor. This IS the floor, not a copy of it: every path that borrows through this venue
    ///      passes through here, so there is no entry point left that can open debt below it.
    function borrow(address asset, uint256 amount) external override {
        _borrow(asset, amount);
    }

    function _borrow(address asset, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        _exec(
            pool,
            abi.encodeCall(
                IAavePool.borrow, (asset, amount, VARIABLE_RATE, NO_REFERRAL, msg.sender)
            )
        );
        uint256 floor = REGISTRY.entryHfFloorWad();
        (,,,,, uint256 hf) = IAavePool(pool).getUserAccountData(msg.sender);
        if (hf < floor) revert EntryHfTooLow(hf, floor);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Aave is ONE cross-collateral position: the collateral named is informational and the
    ///      path is exactly `borrow`, floor included.
    function borrowAgainst(address, address loanToken, uint256 amount) external override {
        _borrow(loanToken, amount);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: repays the calling account's own debt only; approves exactly what Aave will
    ///      pull, which is never more than the account holds. Aave reads a same-block borrow one
    ///      unit over what it lent (measured 2026-09-10, `VERIFIED-BASE-FACTS.md` Addendum 3), so an
    ///      account holding exactly what it borrowed asking for `type(uint256).max` used to die in
    ///      Aave's `transferFrom`; it now repays everything it holds and leaves the rounding unit,
    ///      which `debt()` reports and `LoanDust` classifies (slice C, `RISKS.md` §8). `repaid` is
    ///      what Aave took. An account holding none of the loan token is refused by name.
    function repay(address asset, uint256 amount) external override returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        address pool = PROVIDER.getPool();
        uint256 owed = _debt(asset, msg.sender);
        if (owed == 0) revert NothingToRepay();
        uint256 held = IERC20(asset).balanceOf(msg.sender);
        if (held == 0) revert InsufficientLoanToken(asset, held, owed);
        uint256 pay = amount > owed ? owed : amount;
        bool clamped = pay > held;
        if (clamped) pay = held;
        // Aave's own "everything" path when the account can cover the whole debt; the exact held
        // amount when it cannot.
        uint256 askAave = clamped ? pay : amount;
        bytes memory ret = _approveCallReset(
            asset,
            pool,
            pay,
            Call({
                target: pool,
                value: 0,
                data: abi.encodeCall(IAavePool.repay, (asset, askAave, VARIABLE_RATE, msg.sender)),
                callback: false
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
