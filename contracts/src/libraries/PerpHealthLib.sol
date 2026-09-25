// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PerpHealthLib — the health of a SHORT as an equivalent health factor, and the shared ladder in
///        integers (BUILD-PLAN §2b / D7 / D9 / D10; `docs/PERPS-DESIGN-2026-09-25.md` §4).
///
/// @notice A borrow at health factor HF is liquidated on a FALL of 1 − 1/HF; a short at distance `d` is
///         liquidated on a RISE of `d`. `hfEq = 1 / (1 − d)` maps one onto the other, so this library runs the
///         very same ladder derivation as `packages/shared` `ladderBpsFor` (and the Solana program's
///         `health.rs`): rung_i = round_to_100bps(1_000_000 + (e − 10_000) × k_i), emergency ≥ 1.05, each
///         milder rung ≥ the next + 0.01, hysteresis = round_to_100bps(max(0.02, 0.05 × (e − 1) ÷ 0.55)),
///         the acting rungs capped at an entry of 2.00 while warn keeps deriving. Every number here is
///         basis points of 1.0; `packages/shared/test/perps.test.ts` and the Foundry suite pin the two
///         implementations to each other value for value.
///
/// @dev The distance itself is the venue's own cross-margin liquidation rule (facts §6; checked against the
///      venue's `liquidationPx` for every short sampled 2026-09-25):
///          d = (A / (P·s) − mmr) / (1 + mmr), with mmr = 1 / (2 × maxLeverage) in tier 0.
library PerpHealthLib {
    uint256 internal constant BPS = 10_000;
    /// @notice `d` is taken as at most 0.99 (design §4): hfEq ≤ 100.
    uint256 internal constant MAX_DISTANCE_BPS = 9_900;
    // shared health.ts, in integers (LADDER_RUNG_FACTORS_PCT, EMERGENCY_HF_MIN_BPS, HF_HYSTERESIS_*, MAX/MIN_LADDER_ENTRY_HF)
    uint256 internal constant K_WARN_PCT = 91;
    uint256 internal constant K_REPAY_PCT = 64;
    uint256 internal constant K_DERISK_PCT = 36;
    uint256 internal constant K_EMERGENCY_PCT = 9;
    uint256 internal constant EMERGENCY_HF_MIN_BPS = 10_500;
    uint256 internal constant HYSTERESIS_MIN_BPS = 200;
    uint256 internal constant HYSTERESIS_SCALE_BPS = 500;
    uint256 internal constant HYSTERESIS_SPAN_BPS = 5_500;
    uint256 internal constant MIN_LADDER_ENTRY_HF_BPS = 11_000;
    uint256 internal constant MAX_LADDER_ENTRY_HF_BPS = 20_000;

    /// @notice Rung indices as `protect(rung, …)` names them. 0 (warn) only notifies and is never sent on chain.
    uint8 internal constant RUNG_WARN = 0;
    uint8 internal constant RUNG_REPAY = 1;
    uint8 internal constant RUNG_DERISK = 2;
    uint8 internal constant RUNG_EMERGENCY = 3;

    struct Ladder {
        /// Fires when hfEq < hf[i]; cleared when hfEq ≥ disarm[i]. Index = rung.
        uint32[4] hf;
        uint32[4] disarm;
    }

    error NotAShort(int64 szi);
    error ZeroNotional();
    error EntryTooThinForLadder(uint256 hfBps);

    // -------------------------------------------------------------- distance

    /// @notice |szi| × mark, in 10^6 USDC when szDecimals + pxDecimals = 6 (ZEC: 2 + 4). Refuses a long or an empty position.
    function notionalE6(int64 szi, uint64 markRaw, uint8 szDecimals) internal pure returns (uint256) {
        if (szi >= 0) revert NotAShort(szi);
        uint256 exp = 6 - szDecimals - (6 - szDecimals); // szDecimals + pxDecimals is 6 by the venue's own scaling
        uint256 ntl = uint256(uint64(-szi)) * uint256(markRaw) * (10 ** exp);
        if (ntl == 0) revert ZeroNotional();
        return ntl;
    }

    /// @notice The up-move that liquidates, in bps, floored at each division and clamped to [0, MAX_DISTANCE_BPS].
    function distanceBps(int256 accountValueE6, uint256 ntlE6, uint256 mmrBps) internal pure returns (uint256) {
        int256 ratioBps = _floorDiv(accountValueE6 * int256(BPS), int256(ntlE6));
        int256 d = _floorDiv((ratioBps - int256(mmrBps)) * int256(BPS), int256(BPS + mmrBps));
        if (d <= 0) return 0;
        return uint256(d) > MAX_DISTANCE_BPS ? MAX_DISTANCE_BPS : uint256(d);
    }

    /// @notice floor(10^8 / (10^4 − d)). 4285 → 17497.
    function equivalentHfBps(uint256 dBps) internal pure returns (uint256) {
        require(dBps <= MAX_DISTANCE_BPS, "distance");
        return 100_000_000 / (BPS - dBps);
    }

    /// @notice floor((hf − 1) / hf) in bps. 17497 → 4285.
    function distanceBpsForHf(uint256 hfBps) internal pure returns (uint256) {
        require(hfBps >= BPS, "hf");
        return ((hfBps - BPS) * BPS) / hfBps;
    }

    /// @notice The entry distance for margin worth `marginBps` of the notional (5_000 = "2x").
    function entryDistanceBpsForMargin(uint256 marginBps, uint256 mmrBps) internal pure returns (uint256) {
        if (marginBps <= mmrBps) return 0;
        uint256 d = ((marginBps - mmrBps) * BPS) / (BPS + mmrBps);
        return d > MAX_DISTANCE_BPS ? MAX_DISTANCE_BPS : d;
    }

    /// @notice The account value (10^6) a short of `ntlE6` needs to stand at `dBps`: ceil(ntl × (d(1 + mmr) + mmr)).
    function accountValueForDistanceE6(uint256 ntlE6, uint256 dBps, uint256 mmrBps) internal pure returns (uint256) {
        uint256 num = ntlE6 * (dBps * (BPS + mmrBps) + mmrBps * BPS);
        return (num + BPS * BPS - 1) / (BPS * BPS);
    }

    /// @notice The largest size (raw) at which `accountValueE6` stands at or above `dBps`: floor(A × 10^8 / (unit × (d(1 + mmr) + mmr × 10^4))).
    function sizeForDistance(int256 accountValueE6, uint256 unitNtlE6, uint256 dBps, uint256 mmrBps) internal pure returns (uint256) {
        if (accountValueE6 <= 0) return 0;
        uint256 den = unitNtlE6 * (dBps * (BPS + mmrBps) + mmrBps * BPS);
        return (uint256(accountValueE6) * 100_000_000) / den;
    }

    /// @notice Tier-0 maintenance margin rate: half the initial margin at max leverage, bps (10× → 500).
    function maintenanceMarginRateBps(uint8 maxLeverage) internal pure returns (uint256) {
        require(maxLeverage != 0 && BPS % (2 * uint256(maxLeverage)) == 0, "mmr");
        return BPS / (2 * uint256(maxLeverage));
    }

    // ---------------------------------------------------------------- ladder

    /// @notice shared `hysteresisBpsFor`: round_to_100bps(max(200 × 100, floor(500 × 100 × (e − 10_000) ÷ 5_500))).
    function hysteresisBps(uint256 entryHfBps) internal pure returns (uint256) {
        uint256 scaled = (HYSTERESIS_SCALE_BPS * 100 * (entryHfBps - BPS)) / HYSTERESIS_SPAN_BPS;
        uint256 floorScaled = HYSTERESIS_MIN_BPS * 100;
        return _roundTo100Bps(scaled > floorScaled ? scaled : floorScaled);
    }

    /// @notice shared `ladderBpsFor(entryHfBps)`, value for value. Reverts `EntryTooThinForLadder` under MIN_LADDER_ENTRY_HF
    ///         or when the warn rung would not sit below the entry.
    function ladderFor(uint256 entryHfBps) internal pure returns (Ladder memory l) {
        if (entryHfBps < MIN_LADDER_ENTRY_HF_BPS) revert EntryTooThinForLadder(entryHfBps);
        uint256 acting = entryHfBps < MAX_LADDER_ENTRY_HF_BPS ? entryHfBps : MAX_LADDER_ENTRY_HF_BPS;
        uint256 hWarn = hysteresisBps(entryHfBps);
        uint256 hActing = hysteresisBps(acting);
        uint256[4] memory raw;
        raw[0] = _roundTo100Bps(1_000_000 + (entryHfBps - BPS) * K_WARN_PCT);
        raw[1] = _roundTo100Bps(1_000_000 + (acting - BPS) * K_REPAY_PCT);
        raw[2] = _roundTo100Bps(1_000_000 + (acting - BPS) * K_DERISK_PCT);
        raw[3] = _roundTo100Bps(1_000_000 + (acting - BPS) * K_EMERGENCY_PCT);
        uint256[4] memory hf;
        hf[3] = raw[3] > EMERGENCY_HF_MIN_BPS ? raw[3] : EMERGENCY_HF_MIN_BPS;
        for (uint256 i = 3; i > 0; i--) {
            uint256 lifted = hf[i] + 100;
            hf[i - 1] = raw[i - 1] > lifted ? raw[i - 1] : lifted;
        }
        if (hf[0] >= entryHfBps) revert EntryTooThinForLadder(entryHfBps);
        for (uint256 i = 0; i < 4; i++) {
            l.hf[i] = uint32(hf[i]);
            l.disarm[i] = uint32(hf[i] + (i == 0 ? hWarn : hActing));
        }
    }

    // ------------------------------------------------------------------ math

    /// @dev round to the nearest 100 bps (0.01 of HF) from hundredths of a bp, halves up — shared `roundTo100Bps`.
    function _roundTo100Bps(uint256 hundredthsOfBps) private pure returns (uint256) {
        return ((hundredthsOfBps + 5_000) / 10_000) * 100;
    }

    function _floorDiv(int256 a, int256 b) private pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) != (b < 0))) q -= 1;
    }
}
