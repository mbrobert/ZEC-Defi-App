//! `keeper_protect` — the keeper's whole surface, one instruction (docs/SOLANA-ARCHITECTURE.md §3, decision 1).
//!
//! Why it is shaped this way. Kamino refuses to release collateral while the obligation's LTV is above the
//! reserve's cap (`WithdrawTooLarge`), which is exactly the state the ladder acts in — so "withdraw, sell,
//! repay" is impossible on this venue. The order is therefore **repay first, then withdraw what the repayment
//! earned**: the keeper puts `repay_usdc` into the Account's USDC token account beforehand (its own capital or
//! a flash loan), this instruction repays it to Kamino, withdraws `sell_zec` of collateral into the Account's
//! ZEC token account, and approves the keeper as SPL delegate for exactly what was withdrawn — never more —
//! provided the USDC repaid covers that ZEC at the Scope price less the grant's slippage allowance. The
//! keeper pulls the ZEC with a later instruction and sells it wherever it likes; the program never swaps and
//! never touches a venue it has not been built against. With `sell_zec = 0` the same instruction is a plain
//! repay from the Account's idle USDC.
//!
//! What the chain checks that Base decides off-chain: the grant is live and the rung is allowed; the budgets
//! are charged from the ARGUMENTS before any CPI; the refreshed health factor is actually below the named
//! rung, and the named rung is the most severe crossed rung the grant allows; and afterwards the health
//! factor reached the rung's disarm level or a budget is exhausted — an action that changed nothing cannot
//! succeed. Collateral leaves Kamino only into the Account's own token account, and leaves that account only
//! under a delegation sized by a payment already received.

use crate::errors::OilskinError;
use crate::events::KeeperProtected;
use crate::generated::ladder::{Rung, RUNG_ID_WARN};
use crate::health;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{Grant, UserAccount, ACCOUNT_SEED, GRANT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Token, TokenAccount};

#[derive(Accounts)]
pub struct KeeperProtect<'info> {
    pub keeper: Signer<'info>,
    /// Writable because klend's V2 deposit/withdraw list the obligation owner as writable.
    #[account(mut, seeds = [ACCOUNT_SEED, account.owner.as_ref()], bump = account.bump)]
    pub account: Account<'info, UserAccount>,
    #[account(
        mut,
        seeds = [GRANT_SEED, account.key().as_ref(), keeper.key().as_ref()],
        bump = grant.bump,
        constraint = grant.keeper == keeper.key() @ OilskinError::GrantNotLive,
        constraint = grant.account == account.key() @ OilskinError::GrantNotLive,
    )]
    pub grant: Account<'info, Grant>,
    /// CHECK: the Account's obligation; klend owns it while a position exists.
    #[account(mut, owner = kamino::KLEND_PROGRAM, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = kamino::ZEC_MINT, associated_token::authority = account)]
    pub account_zec: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = kamino::USDC_MINT, associated_token::authority = account)]
    pub account_usdc: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
    pub token_program: Program<'info, Token>,
}

/// The most severe rung of `ladder` the grant allows whose threshold `hf_bps` is below. `None` when no allowed
/// rung is crossed. The ladder is the ACCOUNT's (`health::ladder_for_recorded(entry_hf_bps)`, §14.2) — the
/// floor's only for an account with no record.
fn expected_rung(hf_bps: u64, allowed_rungs: u8, ladder: &[Rung; 4]) -> Option<u8> {
    for i in (0..ladder.len()).rev() {
        let r = ladder[i];
        if allowed_rungs & (1u8 << i) != 0 && hf_bps < r.hf_bps {
            return Some(i as u8);
        }
    }
    None
}

/// USDC base units that `zec_amount` (base units) is worth at the Scope price, less `slippage_bps`.
/// exact integer arithmetic: zec × value × 10^6 × (10000 − s) / (10^8 × 10^exp × 10000).
fn sale_floor_usdc(zec_amount: u64, price_value: u64, price_exp: u64, slippage_bps: u16) -> Result<u64> {
    let num = (zec_amount as u128)
        .checked_mul(price_value as u128)
        .and_then(|x| x.checked_mul(1_000_000))
        .and_then(|x| x.checked_mul(10_000u128 - slippage_bps as u128))
        .ok_or(OilskinError::HealthOverflow)?;
    let den = 100_000_000u128
        .checked_mul(10u128.pow(price_exp as u32))
        .and_then(|x| x.checked_mul(10_000))
        .ok_or(OilskinError::HealthOverflow)?;
    Ok(u64::try_from(num / den).map_err(|_| OilskinError::HealthOverflow)?)
}

pub fn handler(ctx: Context<KeeperProtect>, rung_id: u8, repay_usdc: u64, sell_zec: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let account = &ctx.accounts.account;
    let grant = &mut ctx.accounts.grant;

    // 1. The grant is live and the rung is one it names — on THIS account's ladder (derived from the entry HF it
    //    recorded at its last borrow; the floor's when it has none).
    let ladder = health::ladder_for_recorded(account.entry_hf_bps);
    require!(grant.is_live(account.grant_epoch, now), OilskinError::GrantNotLive);
    require!((rung_id as usize) < ladder.len(), OilskinError::UnknownRung);
    require!(rung_id != RUNG_ID_WARN, OilskinError::RungIsNotifyOnly);
    require!(grant.allowed_rungs & (1u8 << rung_id) != 0, OilskinError::RungNotAllowed);
    require!(repay_usdc > 0 || sell_zec > 0, OilskinError::ZeroAmount);

    // 2. Period roll, then budgets charged from the ARGUMENTS before any CPI.
    grant.roll_period(now);
    let repay_left = grant.repay_usdc_per_period.saturating_sub(grant.repay_usdc_spent);
    require!(repay_usdc <= repay_left, OilskinError::RepayBudgetExceeded);
    let sell_left = grant.sell_zec_per_period.saturating_sub(grant.sell_zec_spent);
    require!(sell_zec <= sell_left, OilskinError::SellBudgetExceeded);
    grant.repay_usdc_spent += repay_usdc;
    grant.sell_zec_spent += sell_zec;
    let repay_exhausted = grant.repay_usdc_spent >= grant.repay_usdc_per_period;
    let sell_exhausted = grant.sell_zec_per_period > 0 && grant.sell_zec_spent >= grant.sell_zec_per_period;

    // 3. Refresh, then the rung must be real.
    let owner_key = account.owner;
    let bump = [account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    let k = &ctx.accounts.kamino;
    kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
    let zec_reserve = kamino::read_reserve(&k.zec_reserve)?;
    require!(
        zec_reserve.price_status & kamino::PRICE_STATUS_ALL_CHECKS == kamino::PRICE_STATUS_ALL_CHECKS,
        OilskinError::PriceNotChecked
    );
    let before = kamino::read_obligation(&ctx.accounts.obligation, clock.slot)?;
    let hf_before = health::hf_bps(&before)?;
    match expected_rung(hf_before, grant.allowed_rungs, &ladder) {
        None => return err!(OilskinError::RungNotCrossed),
        Some(expected) if expected == rung_id => {}
        Some(expected) if expected > rung_id => return err!(OilskinError::RungUnderstated),
        Some(_) => return err!(OilskinError::RungNotCrossed),
    }
    let rung = ladder[rung_id as usize];

    // 4. Repay first (from the Account's USDC: idle, or what the keeper put there for this action).
    let account_info = ctx.accounts.account.to_account_info();
    if repay_usdc > 0 {
        require!(ctx.accounts.account_usdc.amount >= repay_usdc, OilskinError::InsufficientUsdcToClose);
        kamino::repay(k, &account_info, &ctx.accounts.obligation, &ctx.accounts.account_usdc.to_account_info(), repay_usdc, seeds)?;
        kamino::refresh_after(k, &ctx.accounts.obligation)?;
    }

    // 5. Then withdraw what that payment earned, and delegate exactly that to the keeper.
    let mut sold_zec = 0u64;
    if sell_zec > 0 {
        // Collateral is denominated in cTokens; convert at the reserve's exchange rate, rounding up so the
        // keeper's delegation (sized by the ZEC actually received) never exceeds the budget it was charged.
        let liquidity_total = (zec_reserve.liquidity_available as u128) + zec_reserve.liquidity_borrowed_sf / health::SF_ONE;
        let ctokens: u64 = if liquidity_total == 0 || zec_reserve.collateral_total_supply == 0 {
            sell_zec
        } else {
            let n = (sell_zec as u128) * (zec_reserve.collateral_total_supply as u128);
            u64::try_from((n + liquidity_total - 1) / liquidity_total).map_err(|_| OilskinError::HealthOverflow)?
        };
        let zec_before = ctx.accounts.account_zec.amount;
        kamino::withdraw(k, &account_info, &ctx.accounts.obligation, &ctx.accounts.account_zec.to_account_info(), ctokens, seeds)?;
        ctx.accounts.account_zec.reload()?;
        sold_zec = ctx.accounts.account_zec.amount.saturating_sub(zec_before);
        require!(sold_zec <= sell_zec, OilskinError::SellBudgetExceeded);

        // The floor: the USDC just repaid must cover the ZEC released at Kamino's own price, less the allowance.
        let (value, exp, _slot, _ts) = kamino::read_scope_price(&k.scope_prices, kamino::ZEC_SCOPE_PRICE_INDEX)?;
        let floor = sale_floor_usdc(sold_zec, value, exp, grant.max_sell_slippage_bps)?;
        require!(repay_usdc >= floor, OilskinError::SaleBelowFloor);

        token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Approve {
                    to: ctx.accounts.account_zec.to_account_info(),
                    delegate: ctx.accounts.keeper.to_account_info(),
                    authority: account_info.clone(),
                },
                &[seeds],
            ),
            sold_zec,
        )?;
        kamino::refresh_after(k, &ctx.accounts.obligation)?;
    }

    // 6. The action must have worked: disarm level reached, or a budget exhausted, or nothing left to protect.
    let hf_after = if kamino::obligation_is_open(&ctx.accounts.obligation) {
        let after = kamino::read_obligation(&ctx.accounts.obligation, clock.slot)?;
        health::hf_bps(&after)?
    } else {
        health::HF_NO_DEBT
    };
    require!(
        hf_after >= rung.disarm_hf_bps || repay_exhausted || (sell_zec > 0 && sell_exhausted),
        OilskinError::ProtectionIneffective
    );

    emit!(KeeperProtected {
        account: account.key(),
        keeper: ctx.accounts.keeper.key(),
        rung: rung_id,
        repaid_usdc: repay_usdc,
        sold_zec,
        hf_before_bps: hf_before,
        hf_after_bps: hf_after,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_most_severe_allowed_crossed_rung_is_expected() {
        // ladder (generated from shared, the 1.25 floor's): warn 1.23, repay 1.16, derisk 1.09, emergency 1.05
        assert_eq!(expected_rung(16_000, 0b1111, &LADDER), None);
        assert_eq!(expected_rung(12_000, 0b1111, &LADDER), Some(0)); // warn crossed only
        assert_eq!(expected_rung(11_300, 0b1111, &LADDER), Some(1)); // repay
        assert_eq!(expected_rung(10_700, 0b1111, &LADDER), Some(2)); // derisk
        assert_eq!(expected_rung(10_000, 0b1111, &LADDER), Some(3)); // emergency
        assert_eq!(expected_rung(10_700, 0b0010, &LADDER), Some(1)); // only repay allowed: still "repay" while below it
        assert_eq!(expected_rung(10_700, 0b1000, &LADDER), None); // only emergency allowed, not crossed
        // the same HF on the ladder a 1.625 entry derives (1.57 / 1.40 / 1.23 / 1.06): 1.20 is DE-RISK there, not warn
        let derived = crate::health::ladder_for_recorded(16_250);
        assert_eq!(expected_rung(16_000, 0b1111, &derived), None);
        assert_eq!(expected_rung(15_000, 0b1111, &derived), Some(0));
        assert_eq!(expected_rung(13_000, 0b1111, &derived), Some(1));
        assert_eq!(expected_rung(12_000, 0b1111, &derived), Some(2));
        assert_eq!(expected_rung(10_500, 0b1111, &derived), Some(3));
        // the numbers above are inside the generated bands, whatever the exact rungs are
        assert!(LADDER[1].hf_bps < 12_000 && 12_000 < LADDER[0].hf_bps);
        assert!(LADDER[2].hf_bps < 11_300 && 11_300 < LADDER[1].hf_bps);
        assert!(LADDER[3].hf_bps < 10_700 && 10_700 < LADDER[2].hf_bps);
        assert!(10_000 < LADDER[3].hf_bps);
    }

    #[test]
    fn the_sale_floor_prices_zec_in_usdc_less_the_allowance() {
        // 1 ZEC at $1,157.125 (value 115_712_500_000, exp 8), 2 % allowance → 1,133.9825 USDC
        assert_eq!(sale_floor_usdc(100_000_000, 115_712_500_000, 8, 200).unwrap(), 1_133_982_500);
        // 0.5 ZEC at $800, no allowance → 400 USDC
        assert_eq!(sale_floor_usdc(50_000_000, 80_000_000_000, 8, 0).unwrap(), 400_000_000);
        // exp 6 works too
        assert_eq!(sale_floor_usdc(100_000_000, 800_000_000, 6, 0).unwrap(), 800_000_000);
    }
}
