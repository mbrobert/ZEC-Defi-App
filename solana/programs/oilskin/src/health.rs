//! Health on chain, from Kamino's own refreshed obligation fields (docs/SOLANA-ARCHITECTURE.md §4).
//!
//! HF = unhealthy_borrow_value / borrow_factor_adjusted_debt_value — the ratio Kamino liquidates at 1.0 —
//! expressed in basis points of 1.0 so it compares directly with the generated ladder constants. No debt (or
//! dust) is `u64::MAX`, the "healthy" sentinel, never a division by zero.

use crate::generated::ladder::{ENTRY_HF_FLOOR_BPS, LOAN_DUST_UNITS, MAX_OFFERED_LTV_CAP_BPS};
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

/// The LTV Oilskin offers against this reserve: min(shared cap, the venue's own LTV), in bps.
/// Mirrors `packages/shared` `maxOfferedLtvStopBps` ∧ the reserve's `loanToValuePct` (§6).
pub fn offered_ltv_cap_bps(reserve_ltv_pct: u8) -> u64 {
    let venue = (reserve_ltv_pct as u64) * 100;
    MAX_OFFERED_LTV_CAP_BPS.min(venue)
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
    fn the_floor_binds_when_the_venue_is_looser_than_1_55() {
        // Same collateral, 45 % LTV: HF = 6,500 / 4,500 = 1.444 < 1.55 → refused by OUR floor even if the venue allowed it.
        let v = view(10_000, 4_500, 65, 4_500_000_000);
        assert_eq!(hf_bps(&v).unwrap(), 14_444);
        assert!(require_entry_floor(&v, OilskinError::EntryHfTooLow).is_err());
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
    fn offered_cap_is_the_smaller_of_shared_50_and_the_venue() {
        assert_eq!(offered_ltv_cap_bps(40), 4_000);
        assert_eq!(offered_ltv_cap_bps(60), MAX_OFFERED_LTV_CAP_BPS);
    }

    #[test]
    fn ladder_rungs_in_bps_match_the_drops_the_facts_file_records() {
        // At 40 % LTV against LT 65 %: warn (HF 1.50) after a 7.7 % drop, emergency (1.05) after 35.4 %.
        let hf_after_drop = |drop_pct: u128| {
            let coll = 10_000 * (100 - drop_pct) / 100;
            hf_bps(&view(coll, 4_000, 65, 4_000_000_000)).unwrap()
        };
        assert!(hf_after_drop(7) > 15_000 && hf_after_drop(8) < 15_000);
        assert!(hf_after_drop(35) > 10_500 && hf_after_drop(36) < 10_500);
    }
}
