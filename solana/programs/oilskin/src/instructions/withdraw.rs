//! `withdraw`: collateral (in cToken units; `u64::MAX` = all) from Kamino to the Account's ZEC ATA, with the
//! exit floor enforced HERE — after the withdraw the refreshed HF must be ≥ ENTRY_HF_FLOOR unless the debt is
//! dust (the shared LOAN_DUST_UNITS threshold), in which case everything may leave.

use crate::errors::OilskinError;
use crate::events::Withdrawn;
use crate::health;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    /// CHECK: the Account's obligation; klend owns it.
    #[account(mut, owner = kamino::KLEND_PROGRAM, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = kamino::ZEC_MINT, associated_token::authority = account)]
    pub account_zec: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
}

pub fn handler(ctx: Context<Withdraw>, collateral_amount: u64) -> Result<()> {
    require!(collateral_amount > 0, OilskinError::ZeroAmount);
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    let k = &ctx.accounts.kamino;

    kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
    kamino::withdraw(k, &ctx.accounts.account.to_account_info(), &ctx.accounts.obligation, &ctx.accounts.account_zec.to_account_info(), collateral_amount, seeds)?;
    // klend closes an obligation that a full withdraw empties: nothing is left, so nothing to check.
    let hf = if kamino::refresh_after(k, &ctx.accounts.obligation)? {
        let view = kamino::read_obligation(&ctx.accounts.obligation, Clock::get()?.slot)?;
        if health::debt_is_dust(&view) {
            health::HF_NO_DEBT
        } else {
            health::require_entry_floor(&view, OilskinError::ExitHfTooLow)?
        }
    } else {
        health::HF_NO_DEBT
    };

    emit!(Withdrawn { account: ctx.accounts.account.key(), collateral_amount, hf_after_bps: hf });
    Ok(())
}
