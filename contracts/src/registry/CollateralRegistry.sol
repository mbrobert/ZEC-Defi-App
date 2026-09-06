// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {ICollateralRegistry} from "../interfaces/ICollateralRegistry.sol";

/// @title CollateralRegistry — which assets may be collateral, at which venue, and the top LTV we
///        OFFER for each — derived on chain, never typed.
///
/// @notice `maxOfferedLtvBps(asset)` = min(liquidationThresholdBps / entryHfFloor, maxLtvBps,
///         MAX_OFFERED_LTV_CAP_BPS), with BOTH venue risk parameters read at call time: Aave retires
///         a collateral by setting LTV → 0 while keeping the liquidation threshold, and a registry
///         that reads only the threshold would keep advertising 50 % while every open reverted.
///         A disabled asset offers 0. The venue itself refuses any new debt that would leave the
///         account below `entryHfFloorWad`, so what the registry advertises is exactly what the
///         chain enforces on every path, not just through one router function. cbZEC is registered
///         DISABLED with the reason shown to users.
///
/// @dev **Which powers the owner has, stated plainly.** Pointing an asset at a different venue is
///      the one power that could redirect user funds, so it is TIMELOCKED: `proposeVenue` →
///      `TIMELOCK_DELAY` seconds → `acceptVenue`, with an event at each step carrying the old and
///      new venue, so an off-chain watcher sees a pending change before it can take effect. First
///      registration of an asset is immediate (no position exists to redirect) and `setEnabled` is
///      immediate in BOTH directions (turning an asset off is the ops safety valve and must not
///      wait; turning it on redirects nothing). A timelocked owner is still an owner: it can still
///      disable an asset, still change the entry floor within its bounds, and still replace a venue
///      after the delay. Until that owner is a multisig with a published delay, the product must not
///      claim "no operator custody" — see docs.
contract CollateralRegistry is Ownable2Step, ICollateralRegistry {
    struct AssetConfig {
        address venue;
        uint8 decimals;
        /// @dev Display / keeper feed (Chainlink). The venue prices risk with its own oracle.
        address priceFeed;
        bool enabled;
        /// @dev Shown verbatim in the UI when `enabled` is false.
        string note;
    }

    /// @notice A venue replacement waiting out the timelock.
    struct PendingVenue {
        address venue;
        address priceFeed;
        uint40 eta;
    }

    /// @notice Never offer more than 50 % LTV regardless of the venue's threshold.
    uint256 public constant MAX_OFFERED_LTV_CAP_BPS = 5000;
    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;

    /// @notice Bounds on the immutable timelock delay chosen at construction.
    uint256 public constant MIN_TIMELOCK_DELAY = 1 hours;
    uint256 public constant MAX_TIMELOCK_DELAY = 30 days;

    /// @notice Seconds between proposing a venue replacement and being able to accept it. Immutable.
    uint256 public immutable TIMELOCK_DELAY;

    /// @notice Minimum health factor at entry (WAD). Set from packages/shared `ENTRY_HF_FLOOR`.
    uint256 public override entryHfFloorWad;

    mapping(address => AssetConfig) internal _configs;
    mapping(address => PendingVenue) internal _pending;
    address[] internal _assets;

    event AssetRegistered(
        address indexed asset, address indexed venue, uint8 decimals, address priceFeed, bool enabled
    );
    event AssetEnabled(address indexed asset, bool enabled, string note);
    event EntryHfFloorSet(uint256 wad);
    /// @notice A venue replacement was proposed. `eta` is the earliest second it may be accepted.
    event VenueChangeProposed(
        address indexed asset,
        address indexed currentVenue,
        address indexed proposedVenue,
        address priceFeed,
        uint40 eta
    );
    event VenueChangeCancelled(address indexed asset, address indexed proposedVenue);
    event VenueChangeAccepted(
        address indexed asset, address indexed previousVenue, address indexed newVenue
    );

    error ZeroAddress();
    error VenueDisabled(address venue);
    error UnknownAsset(address asset);
    error AssetNotEnabled(address asset);
    error InvalidHfFloor(uint256 wad);
    error InvalidTimelock(uint256 delay);
    error VenueDoesNotKnowAsset(address asset);
    error AssetAlreadyRegistered(address asset);
    error NoPendingChange(address asset);
    error TimelockNotElapsed(uint40 eta);

    constructor(address initialOwner, uint256 entryHfFloorWad_, uint256 timelockDelay)
        Ownable(initialOwner)
    {
        if (timelockDelay < MIN_TIMELOCK_DELAY || timelockDelay > MAX_TIMELOCK_DELAY) {
            revert InvalidTimelock(timelockDelay);
        }
        TIMELOCK_DELAY = timelockDelay;
        _setEntryHfFloor(entryHfFloorWad_);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Register an asset for the FIRST time. Decimals are read from the token, not typed.
    /// @dev Invariant: owner-only; the asset must be unknown (changing an existing asset's venue is
    ///      `proposeVenue` / `acceptVenue`); an enabled asset's venue must itself be enabled and must
    ///      report a non-zero liquidation threshold AND a non-zero max LTV for the asset.
    function register(address asset, address venue, address priceFeed, bool enabled, string calldata note)
        external
        onlyOwner
    {
        if (asset == address(0) || venue == address(0)) revert ZeroAddress();
        if (_configs[asset].venue != address(0)) revert AssetAlreadyRegistered(asset);
        if (enabled) _requireListed(asset, venue);
        uint8 decimals = IERC20Metadata(asset).decimals();
        _assets.push(asset);
        _configs[asset] = AssetConfig({
            venue: venue, decimals: decimals, priceFeed: priceFeed, enabled: enabled, note: note
        });
        emit AssetRegistered(asset, venue, decimals, priceFeed, enabled);
        emit AssetEnabled(asset, enabled, note);
    }

    /// @notice Start the clock on pointing `asset` at a different venue (or at a new price feed).
    /// @dev Invariant: owner-only; the asset must already exist; the new venue must list it. The
    ///      change cannot take effect before `block.timestamp + TIMELOCK_DELAY`, and both the
    ///      proposal and the acceptance are events an off-chain watcher can act on.
    function proposeVenue(address asset, address venue, address priceFeed) external onlyOwner {
        if (venue == address(0)) revert ZeroAddress();
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0)) revert UnknownAsset(asset);
        _requireListed(asset, venue);
        uint40 eta = uint40(block.timestamp + TIMELOCK_DELAY);
        _pending[asset] = PendingVenue({venue: venue, priceFeed: priceFeed, eta: eta});
        emit VenueChangeProposed(asset, c.venue, venue, priceFeed, eta);
    }

    /// @notice Drop a pending venue change. Owner-only, immediate — cancelling is always safe.
    function cancelVenueChange(address asset) external onlyOwner {
        PendingVenue memory pv = _pending[asset];
        if (pv.venue == address(0)) revert NoPendingChange(asset);
        delete _pending[asset];
        emit VenueChangeCancelled(asset, pv.venue);
    }

    /// @notice Apply a venue change whose timelock has elapsed.
    /// @dev Invariant: owner-only; `eta` must have passed; the new venue is re-checked at this
    ///      moment, not only when it was proposed.
    function acceptVenue(address asset) external onlyOwner {
        PendingVenue memory pv = _pending[asset];
        if (pv.venue == address(0)) revert NoPendingChange(asset);
        if (block.timestamp < pv.eta) revert TimelockNotElapsed(pv.eta);
        AssetConfig storage c = _configs[asset];
        if (c.enabled) _requireListed(asset, pv.venue);
        address previous = c.venue;
        delete _pending[asset];
        c.venue = pv.venue;
        c.priceFeed = pv.priceFeed;
        c.decimals = IERC20Metadata(asset).decimals();
        emit VenueChangeAccepted(asset, previous, pv.venue);
        emit AssetRegistered(asset, pv.venue, c.decimals, pv.priceFeed, c.enabled);
    }

    /// @notice Flip an asset on or off, with the reason users will see.
    /// @dev Invariant: owner-only; enabling re-checks that the venue lists the asset. Immediate in
    ///      both directions: this cannot redirect anything, and disabling is the safety valve.
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
    /// @dev Reads BOTH of the venue's risk parameters. An LTV→0 deprecation therefore takes the
    ///      offer to 0 immediately instead of advertising a loan that reverts inside the protocol.
    function maxOfferedLtvBps(address asset) external view returns (uint256) {
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0) || !c.enabled) return 0;
        ICollateralVenue v = ICollateralVenue(c.venue);
        uint256 derived = (v.liquidationThresholdBps(asset) * WAD) / entryHfFloorWad;
        uint256 venueLtv = v.maxLtvBps(asset);
        if (venueLtv < derived) derived = venueLtv;
        return derived > MAX_OFFERED_LTV_CAP_BPS ? MAX_OFFERED_LTV_CAP_BPS : derived;
    }

    /// @notice Entry health factor (WAD) a position opened at `ltvBps` would have: LT / LTV.
    /// @dev Answers only for an asset the product actually offers, so a client reading this and
    ///      `maxOfferedLtvBps` gets one coherent story instead of a number from one and an
    ///      exception from the other: a disabled asset is `AssetNotEnabled`, an asset the venue no
    ///      longer lists is `VenueDoesNotKnowAsset`, never a health factor of zero.
    function entryHfForLtv(address asset, uint256 ltvBps) external view returns (uint256) {
        AssetConfig storage c = _configs[asset];
        if (c.venue == address(0)) revert UnknownAsset(asset);
        if (!c.enabled) revert AssetNotEnabled(asset);
        if (ltvBps == 0) return type(uint256).max;
        uint256 lt = ICollateralVenue(c.venue).liquidationThresholdBps(asset);
        if (lt == 0) revert VenueDoesNotKnowAsset(asset);
        return (lt * WAD) / ltvBps;
    }

    function config(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    /// @notice The venue replacement waiting on the timelock, if any (`venue == 0` = none).
    function pendingVenue(address asset) external view returns (PendingVenue memory) {
        return _pending[asset];
    }

    function venueOf(address asset) external view override returns (address) {
        return _configs[asset].venue;
    }

    function isEnabled(address asset) external view override returns (bool) {
        return _configs[asset].enabled;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    // ------------------------------------------------------------- internal

    function _requireListed(address asset, address venue) internal view {
        if (!ICollateralVenue(venue).enabled()) revert VenueDisabled(venue);
        ICollateralVenue v = ICollateralVenue(venue);
        // A venue that reports either risk parameter as zero does not really list the asset: Aave
        // deprecates by zeroing the LTV alone, and an enabled asset with LTV 0 cannot be borrowed
        // against at all.
        if (v.liquidationThresholdBps(asset) == 0 || v.maxLtvBps(asset) == 0) {
            revert VenueDoesNotKnowAsset(asset);
        }
    }

    function _setEntryHfFloor(uint256 wad) internal {
        if (wad <= WAD || wad > 10 * WAD) revert InvalidHfFloor(wad);
        entryHfFloorWad = wad;
        emit EntryHfFloorSet(wad);
    }
}
