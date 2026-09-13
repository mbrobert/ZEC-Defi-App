//! `close_position`: repay everything, then withdraw everything, in one instruction — the Solana "unwind".
//! Refuses up front if the Account's USDC cannot cover the debt (the user tops up with `deposit`-side USDC or
//! a wallet transfer first), so the instruction never half-completes.

use crate::errors::OilskinError;
use crate::events::PositionClosed;
use crate::health;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    /// CHECK: the Account's obligation by address; klend owns it while it is open (a full withdraw closes it).
    #[account(mut, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = kamino::ZEC_MINT, associated_token::authority = account)]
    pub account_zec: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = kamino::USDC_MINT, associated_token::authority = account)]
    pub account_usdc: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
}

pub fn handler(ctx: Context<ClosePosition>) -> Result<()> {
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    let k = &ctx.accounts.kamino;

    if !kamino::obligation_is_open(&ctx.accounts.obligation) {
        // Already emptied and closed by klend: nothing to repay or withdraw — but the stale entry
        // record must still go, or the next borrow would be judged against a ladder from a position
        // that no longer exists (D9).
        ctx.accounts.account.entry_hf_bps = 0;
        emit!(PositionClosed { account: ctx.accounts.account.key() });
        return Ok(());
    }
    kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
    let view = kamino::read_obligation(&ctx.accounts.obligation, Clock::get()?.slot)?;
    if !health::debt_is_dust(&view) {
        // Debt in base units, rounded up: the account must hold at least this much USDC.
        let owed = (view.usdc_borrowed_amount_sf + health::SF_ONE - 1) / health::SF_ONE;
        require!((ctx.accounts.account_usdc.amount as u128) >= owed, OilskinError::InsufficientUsdcToClose);
        kamino::repay(k, &ctx.accounts.account.to_account_info(), &ctx.accounts.obligation, &ctx.accounts.account_usdc.to_account_info(), u64::MAX, seeds)?;
        kamino::refresh_after(k, &ctx.accounts.obligation)?;
    }
    if view.has_zec_deposit {
        kamino::withdraw(k, &ctx.accounts.account.to_account_info(), &ctx.accounts.obligation, &ctx.accounts.account_zec.to_account_info(), u64::MAX, seeds)?;
    }
    // D9: the position is gone, so there is no entry to derive a ladder from. The next borrow
    // writes a fresh one; until then `ladder_for_recorded(0)` is the registry floor's ladder.
    ctx.accounts.account.entry_hf_bps = 0;
    emit!(PositionClosed { account: ctx.accounts.account.key() });
    Ok(())
}
