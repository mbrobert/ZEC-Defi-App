// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";

/// @title CollateralRegistry — which assets may be collateral, at which venue, and the top LTV we
///        OFFER for each — derived on chain, never typed.
///
/// @notice `maxOfferedLtvBps(asset)` = floor(liquidationThresholdBps(asset) / entryHfFloor), capped
///         at MAX_OFFERED_LTV_CAP_BPS, with the liquidation threshold read from the venue at call
///         time. A disabled asset offers 0. The router refuses any open whose post-borrow health
///         factor is below `entryHfFloorWad`, so what the registry advertises is exactly what the
///         chain enforces. cbZEC is registered DISABLED with the reason shown to users.
contract CollateralRegistry is Ownable2Step {
    struct AssetConfig {
        address venue;
        uint8 decimals;
        /// @dev Display / keeper feed (Chainlink). The venue prices risk with its own oracle.
        address priceFeed;
        bool enabled;
        /// @dev Shown verbatim in the UI when `enabled` is false.
        string note;
    }

    /// @notice Never offer more than 50 % LTV regardless of the venue's threshold.
    uint256 public constant MAX_OFFERED_LTV_CAP_BPS = 5000;
    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;

    /// @notice Minimum health factor at entry (WAD). Set from packages/shared `ENTRY_HF_FLOOR`.
    uint256 public entryHfFloorWad;

    mapping(address => AssetConfig) internal _configs;
    address[] internal _assets;

    event AssetRegistered(
        address indexed asset, address indexed venue, uint8 decimals, address priceFeed, bool enabled
    );
    event AssetEnabled(address indexed asset, bool enabled, string note);
    event EntryHfFloorSet(uint256 wad);

    error ZeroAddress();
    error VenueDisabled(address venue);
    error UnknownAsset(address asset);
    error InvalidHfFloor(uint256 wad);
    error VenueDoesNotKnowAsset(address asset);

    constructor(address initialOwner, uint256 entryHfFloorWad_) Ownable(initialOwner) {
        _setEntryHfFloor(entryHfFloorWad_);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Register or update an asset. Decimals are read from the token, not typed.
    /// @dev Invariant: owner-only; an enabled asset's venue must itself be enabled and must report a
    ///      non-zero liquidation threshold for the asset (otherwise the venue does not list it).
    function register(address asset, address venue, address priceFeed, bool enabled, string calldata note)
        external
        onlyOwner
    {
        if (asset == address(0) || venue == address(0)) revert ZeroAddress();
        if (enabled) _requireListed(asset, venue);
        uint8 decimals = IERC20Metadata(asset).decimals();
        if (_configs[asset].venue == address(0)) _assets.push(asset);
        _configs[asset] = AssetConfig({
            venue: venue, decimals: decimals, priceFeed: priceFeed, enabled: enabled, note: note
        });
        emit AssetRegistered(asset, venue, decimals, priceFeed, enabled);
        emit AssetEnabled(asset, enabled, note);
    }

    /// @notice Flip an asset on or off, with the reason users will see.
    /// @dev Invariant: owner-only; enabling re-checks that the venue lists the asset.
    function setEnabled(address asset, bool enabled, string calldata note) external onlyOwner {
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0)) revert UnknownAsset(asset);
        if (enabled) _requireListed(asset, c.venue);
        c.enabled = enabled;
        c.note = note;
        emit AssetEnabled(asset, enabled, note);
    }

    /// @notice Set the entry health-factor floor (WAD, 1.0 < floor ≤ 10.0).
    /// @dev Invariant: owner-only; bounded so the offered LTV can never exceed the venue's
    ///      threshold or collapse to zero by a typo.
    function setEntryHfFloor(uint256 wad) external onlyOwner {
        _setEntryHfFloor(wad);
    }

    // ---------------------------------------------------------------- views

    /// @notice The top LTV (bps) the product offers for `asset` — derived, capped, 0 if disabled.
    function maxOfferedLtvBps(address asset) external view returns (uint256) {
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0) || !c.enabled) return 0;
        uint256 lt = ICollateralVenue(c.venue).liquidationThresholdBps(asset);
        uint256 derived = (lt * WAD) / entryHfFloorWad;
        return derived > MAX_OFFERED_LTV_CAP_BPS ? MAX_OFFERED_LTV_CAP_BPS : derived;
    }

    /// @notice Entry health factor (WAD) a position opened at `ltvBps` would have: LT / LTV.
    function entryHfForLtv(address asset, uint256 ltvBps) external view returns (uint256) {
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0)) revert UnknownAsset(asset);
        if (ltvBps == 0) return type(uint256).max;
        uint256 lt = ICollateralVenue(c.venue).liquidationThresholdBps(asset);
        return (lt * WAD) / ltvBps;
    }

    function config(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    function venueOf(address asset) external view returns (address) {
        return _configs[asset].venue;
    }

    function isEnabled(address asset) external view returns (bool) {
        return _configs[asset].enabled;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    // ------------------------------------------------------------- internal

    function _requireListed(address asset, address venue) internal view {
        if (!ICollateralVenue(venue).enabled()) revert VenueDisabled(venue);
        if (ICollateralVenue(venue).liquidationThresholdBps(asset) == 0) {
            revert VenueDoesNotKnowAsset(asset);
        }
    }

    function _setEntryHfFloor(uint256 wad) internal {
        if (wad <= WAD || wad > 10 * WAD) revert InvalidHfFloor(wad);
        entryHfFloorWad = wad;
        emit EntryHfFloorSet(wad);
    }
}
