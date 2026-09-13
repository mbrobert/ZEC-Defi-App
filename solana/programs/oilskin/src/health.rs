//! Health on chain, from Kamino's own refreshed obligation fields (docs/SOLANA-ARCHITECTURE.md §4).
//!
//! HF = unhealthy_borrow_value / borrow_factor_adjusted_debt_value — the ratio Kamino liquidates at 1.0 —
//! expressed in basis points of 1.0 so it compares directly with the generated ladder constants. No debt (or
//! dust) is `u64::MAX`, the "healthy" sentinel, never a division by zero.

use crate::generated::ladder::{
    Rung, EMERGENCY_HF_MIN_BPS, ENTRY_HF_FLOOR_BPS, HF_HYSTERESIS_MIN_BPS, HF_HYSTERESIS_SCALE_BPS, HF_HYSTERESIS_SPAN_BPS,
    LADDER, LADDER_RUNG_FACTORS_PCT, LOAN_DUST_UNITS, MIN_LADDER_ENTRY_HF_BPS,
};
use crate::kamino::ObligationView;
use crate::errors::OilskinError;
use anchor_lang::prelude::*;

/// Kamino's scaled fraction: values are multiplied by 2^60.
pub const SF_ONE: u128 = 1u128 << 60;
pub const BPS: u128 = 10_000;
pub const HF_NO_DEBT: u64 = u64::MAX;

/// True when the obligation's USDC debt, in base units, is at or below the shared dust threshold.
pub fn debt_is_dust(view: &ObligationView) -> bool {
    view.usdc_borrowed_amount_sf / SF_ONE <= LOAN_DUST_UNITS as u128
}

/// Health factor in basis points. `u64::MAX` when there is no (non-dust) debt.
pub fn hf_bps(view: &ObligationView) -> Result<u64> {
    if view.borrow_factor_adjusted_debt_value_sf == 0 || debt_is_dust(view) {
        return Ok(HF_NO_DEBT);
    }
    let num = view
        .unhealthy_borrow_value_sf
        .checked_mul(BPS)
        .ok_or(OilskinError::HealthOverflow)?;
    let hf = num / view.borrow_factor_adjusted_debt_value_sf;
    Ok(u64::try_from(hf).unwrap_or(u64::MAX))
}

/// Loan-to-value in basis points (Kamino's definition: borrow-factor-adjusted debt over deposited value).
/// 0 when there is no debt; `u64::MAX` when there is debt and no collateral.
pub fn ltv_bps(view: &ObligationView) -> Result<u64> {
    if view.borrow_factor_adjusted_debt_value_sf == 0 {
        return Ok(0);
    }
    if view.deposited_value_sf == 0 {
        return Ok(u64::MAX);
    }
    let num = view
        .borrow_factor_adjusted_debt_value_sf
        .checked_mul(BPS)
        .ok_or(OilskinError::HealthOverflow)?;
    Ok(u64::try_from(num / view.deposited_value_sf).unwrap_or(u64::MAX))
}

/// The LTV ceiling the venue itself sets on this reserve, in bps. Since 2026-09-12 (BUILD-PLAN D7) there is
/// no product-wide cap under it: the only ceilings on a borrow are the entry floor (`require_entry_floor`,
/// LT ÷ 1.25 in LTV terms) and this, the reserve's own `loanToValuePct` — the same two bounds
/// `packages/shared` `offeredLtvBounds` applies (§6). On the ZCASH market that is Kamino's 40 %.
pub fn offered_ltv_cap_bps(reserve_ltv_pct: u8) -> u64 {
    (reserve_ltv_pct as u64) * 100
}

/// The entry floor: HF after an owner action that adds debt or removes collateral must be at or above it,
/// unless the debt is dust (a fully-repaid position may withdraw everything).
pub fn require_entry_floor(view: &ObligationView, err: OilskinError) -> Result<u64> {
    let hf = hf_bps(view)?;
    if hf < ENTRY_HF_FLOOR_BPS {
        return Err(err.into());
    }
    Ok(hf)
}

// ---------------------------------------------------------------- the per-position ladder (D7 / §14.2)

/// Round a value in hundredths of a basis point to the nearest 100 bps (0.01 of HF), halves up — shared `round2`.
fn round_to_100_bps(hundredths: u128) -> u64 {
    ((hundredths + 5_000) / 10_000 * 100) as u64
}

/// shared `hysteresisBpsFor`: max(min, scale × (e − 1) ÷ span), to 0.01. Input and output in bps.
pub fn hysteresis_bps_for(entry_hf_bps: u64) -> u64 {
    let buffer = (entry_hf_bps - 10_000) as u128;
    let scaled = (HF_HYSTERESIS_SCALE_BPS as u128) * 100 * buffer / (HF_HYSTERESIS_SPAN_BPS as u128);
    round_to_100_bps(scaled.max((HF_HYSTERESIS_MIN_BPS as u128) * 100))
}

/// shared `ladderBpsFor`: the four rungs a position opened at `entry_hf_bps` runs on, in the generated order,
/// each with its disarm level. Requires `entry_hf_bps ≥ MIN_LADDER_ENTRY_HF_BPS` (the caller falls back below it).
pub fn ladder_for(entry_hf_bps: u64) -> [Rung; 4] {
    let buffer = (entry_hf_bps - 10_000) as u128;
    let h = hysteresis_bps_for(entry_hf_bps);
    let mut hf = [0u64; 4];
    for i in 0..4 {
        hf[i] = round_to_100_bps(1_000_000 + buffer * (LADDER_RUNG_FACTORS_PCT[i] as u128));
    }
    hf[3] = hf[3].max(EMERGENCY_HF_MIN_BPS);
    for i in (0..3).rev() {
        hf[i] = hf[i].max(hf[i + 1] + 100);
    }
    let mut out = LADDER;
    for i in 0..4 {
        out[i].hf_bps = hf[i];
        out[i].disarm_hf_bps = hf[i] + h;
    }
    out
}

/// The ladder for a recorded entry, or the floor's when there is no usable record — shared `ladderForRecorded`:
/// 0 (no record), under the minimum, or a warn rung that would not sit below the entry → `LADDER`.
pub fn ladder_for_recorded(entry_hf_bps: u64) -> [Rung; 4] {
    if entry_hf_bps < MIN_LADDER_ENTRY_HF_BPS || entry_hf_bps == HF_NO_DEBT {
        return LADDER;
    }
    let l = ladder_for(entry_hf_bps);
    if l[0].hf_bps >= entry_hf_bps {
        return LADDER;
    }
    l
}

/// The cross-chain reserve (§14.3): the USDC that lifts HF from the repay rung to its disarm level with no
/// collateral change — ceil(D × (disarm₂ − rung₂) ÷ disarm₂) — for a debt in base units, on the recorded ladder.
pub fn reserve_units_for(debt_units: u64, entry_hf_bps: u64) -> Result<u64> {
    let repay = ladder_for_recorded(entry_hf_bps)[1];
    let num = (debt_units as u128)
        .checked_mul((repay.disarm_hf_bps - repay.hf_bps) as u128)
        .ok_or(OilskinError::HealthOverflow)?;
    let den = repay.disarm_hf_bps as u128;
    Ok(u64::try_from((num + den - 1) / den).map_err(|_| OilskinError::HealthOverflow)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(deposited_usd: u128, debt_usd: u128, lt_pct: u128, usdc_units: u128) -> ObligationView {
        let sf = |x: u128| x * SF_ONE;
        ObligationView {
            slot: 0,
            stale: false,
            price_status: 63,
            owner: Pubkey::default(),
            lending_market: Pubkey::default(),
            deposit_reserves: vec![],
            borrow_reserves: vec![],
            has_zec_deposit: deposited_usd > 0,
            zec_deposited_ctokens: 0,
            usdc_borrowed_amount_sf: sf(usdc_units),
            deposited_value_sf: sf(deposited_usd),
            borrow_factor_adjusted_debt_value_sf: sf(debt_usd),
            borrowed_assets_market_value_sf: sf(debt_usd),
            allowed_borrow_value_sf: sf(deposited_usd * 40 / 100),
            unhealthy_borrow_value_sf: sf(deposited_usd * lt_pct / 100),
            has_debt: debt_usd > 0,
            ownership_transfer_state: 0,
            pending_owner: Pubkey::default(),
        }
    }

    #[test]
    fn hf_at_kaminos_top_ltv_is_1_625_and_clears_the_floor() {
        // 10 ZEC at $1,000 = $10,000 collateral, $4,000 debt, LT 65 %: HF = 6,500 / 4,000 = 1.625
        let v = view(10_000, 4_000, 65, 4_000_000_000);
        assert_eq!(hf_bps(&v).unwrap(), 16_250);
        assert_eq!(ltv_bps(&v).unwrap(), 4_000);
        assert_eq!(require_entry_floor(&v, OilskinError::EntryHfTooLow).unwrap(), 16_250);
    }

    #[test]
    fn the_floor_binds_when_the_venue_is_looser_than_the_floor_allows() {
        // Same collateral, 55 % LTV: HF = 6,500 / 5,500 = 1.1818 < 1.25 → refused by OUR floor even if the venue allowed it.
        // (LT 65 % ÷ the 1.25 floor = 52 % LTV is where the floor starts to bind.)
        let v = view(10_000, 5_500, 65, 5_500_000_000);
        assert_eq!(hf_bps(&v).unwrap(), 11_818);
        assert!(require_entry_floor(&v, OilskinError::EntryHfTooLow).is_err());
    }

    #[test]
    fn no_product_cap_sits_under_the_floor() {
        // 50 % LTV: HF = 6,500 / 5,000 = 1.30 ≥ 1.25 → the floor clears it. The 50 % product cap that once refused
        // this regardless of HF was removed 2026-09-12; a venue that allowed 50 % would now be offered 50 %.
        let v = view(10_000, 5_000, 65, 5_000_000_000);
        assert_eq!(hf_bps(&v).unwrap(), 13_000);
        assert_eq!(require_entry_floor(&v, OilskinError::EntryHfTooLow).unwrap(), 13_000);
        assert!(ltv_bps(&v).unwrap() <= offered_ltv_cap_bps(50));
    }

    #[test]
    fn no_debt_and_dust_read_as_healthy() {
        assert_eq!(hf_bps(&view(10_000, 0, 65, 0)).unwrap(), HF_NO_DEBT);
        // 100 base units of USDC is dust by the shared LOAN_DUST_UNITS; 101 is not
        let dust = view(10_000, 1, 65, LOAN_DUST_UNITS as u128);
        assert!(debt_is_dust(&dust));
        assert_eq!(hf_bps(&dust).unwrap(), HF_NO_DEBT);
        let not_dust = view(10_000, 1, 65, LOAN_DUST_UNITS as u128 + 1);
        assert!(!debt_is_dust(&not_dust));
    }

    #[test]
    fn the_ladder_derives_from_the_entry_as_shared_does() {
        // shared health.test.ts: 1.625 → 1.57 / 1.40 / 1.23 / 1.06, hysteresis 0.06
        let l = ladder_for(16_250);
        assert_eq!(l.iter().map(|r| (r.hf_bps, r.disarm_hf_bps)).collect::<Vec<_>>(), vec![(15_700, 16_300), (14_000, 14_600), (12_300, 12_900), (10_600, 11_200)]);
        assert_eq!(hysteresis_bps_for(16_250), 600);
        // the floor: 1.23 / 1.16 / 1.09 / 1.05, hysteresis 0.02 — equal to the generated floor ladder
        assert_eq!(ladder_for(12_500).iter().map(|r| r.hf_bps).collect::<Vec<_>>(), LADDER.iter().map(|r| r.hf_bps).collect::<Vec<_>>());
        assert_eq!(ladder_for(12_500).iter().map(|r| r.disarm_hf_bps).collect::<Vec<_>>(), LADDER.iter().map(|r| r.disarm_hf_bps).collect::<Vec<_>>());
        // BUILD-PLAN §2b's worked row: 1.30 → 1.27 / 1.19 / 1.11 / 1.05, hysteresis 0.03
        assert_eq!(ladder_for(13_000).iter().map(|r| r.hf_bps).collect::<Vec<_>>(), vec![12_700, 11_900, 11_100, 10_500]);
        assert_eq!(hysteresis_bps_for(13_000), 300);
        // a generous entry: 2.60 → 2.46 / 2.02 / 1.58 / 1.14, hysteresis 0.15
        assert_eq!(ladder_for(26_000).iter().map(|r| r.hf_bps).collect::<Vec<_>>(), vec![24_600, 20_200, 15_800, 11_400]);
        assert_eq!(hysteresis_bps_for(26_000), 1_500);
        // near the bottom the clamp lifts the rungs 0.01 apart: 1.10 → 1.09 / 1.07 / 1.06 / 1.05
        assert_eq!(ladder_for(11_000).iter().map(|r| r.hf_bps).collect::<Vec<_>>(), vec![10_900, 10_700, 10_600, 10_500]);
        // ids and severities travel with the rungs
        assert_eq!(ladder_for(16_250).iter().map(|r| r.id).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        // shape, every entry from the minimum to 5.00: strictly descending, disarm above the trigger, warn under the entry
        let mut e = MIN_LADDER_ENTRY_HF_BPS;
        while e <= 50_000 {
            let l = ladder_for(e);
            assert!(l[0].hf_bps < e, "{e}");
            for i in 0..4 {
                assert!(l[i].disarm_hf_bps > l[i].hf_bps);
                if i > 0 {
                    assert!(l[i].hf_bps < l[i - 1].hf_bps, "{e}");
                }
            }
            assert!(l[3].hf_bps >= EMERGENCY_HF_MIN_BPS);
            e += 100;
        }
    }

    #[test]
    fn no_record_or_an_unusable_one_runs_the_floors_ladder() {
        assert_eq!(ladder_for_recorded(0), LADDER);
        assert_eq!(ladder_for_recorded(10_900), LADDER);
        assert_eq!(ladder_for_recorded(HF_NO_DEBT), LADDER);
        assert_eq!(ladder_for_recorded(16_250), ladder_for(16_250));
        assert_ne!(ladder_for_recorded(16_250), LADDER);
    }

    #[test]
    fn the_reserve_is_the_rung_two_requirement_rounded_up() {
        // shared health.test.ts: 4,000 USDC of debt at entry 1.625 → ceil(4_000e6 × 600 / 14_600) = 164,383,562
        assert_eq!(reserve_units_for(4_000_000_000, 16_250).unwrap(), 164_383_562);
        assert_eq!(reserve_units_for(0, 16_250).unwrap(), 0);
        assert_eq!(reserve_units_for(1, 16_250).unwrap(), 1);
        // no record: the floor ladder's (1.18 − 1.16) / 1.18 = 1.69 %
        assert_eq!(reserve_units_for(4_000_000_000, 0).unwrap(), 67_796_611);
    }

    #[test]
    fn the_offered_ltv_is_the_venues_own() {
        assert_eq!(offered_ltv_cap_bps(40), 4_000);
        assert_eq!(offered_ltv_cap_bps(60), 6_000);
    }

    #[test]
    fn ladder_rungs_in_bps_match_the_drops_the_facts_file_records() {
        // At 40 % LTV against LT 65 % (entry HF 1.625): warn (HF 1.23) fires after a 24.3 % fall
        // (1 − 1.23 ÷ 1.625), emergency (1.05) after 35.4 % — the generated rungs, not typed here.
        use crate::generated::ladder::{RUNG_EMERGENCY, RUNG_WARN};
        let hf_after_drop = |drop_pct: u128| {
            let coll = 10_000 * (100 - drop_pct) / 100;
            hf_bps(&view(coll, 4_000, 65, 4_000_000_000)).unwrap()
        };
        assert!(hf_after_drop(24) > RUNG_WARN.hf_bps && hf_after_drop(25) < RUNG_WARN.hf_bps);
        assert!(hf_after_drop(35) > RUNG_EMERGENCY.hf_bps && hf_after_drop(36) < RUNG_EMERGENCY.hf_bps);
    }
}
