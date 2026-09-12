//! `repay`: USDC from the Account's USDC ATA to the Kamino reserve. `u64::MAX` repays everything.

use crate::errors::OilskinError;
use crate::events::Repaid;
use crate::health;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct Repay<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    /// CHECK: the Account's obligation; klend owns it.
    #[account(mut, owner = kamino::KLEND_PROGRAM, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = kamino::USDC_MINT, associated_token::authority = account)]
    pub account_usdc: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
}

pub fn handler(ctx: Context<Repay>, amount_usdc: u64) -> Result<()> {
    require!(amount_usdc > 0, OilskinError::ZeroAmount);
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    let k = &ctx.accounts.kamino;

    kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
    kamino::repay(k, &ctx.accounts.account.to_account_info(), &ctx.accounts.obligation, &ctx.accounts.account_usdc.to_account_info(), amount_usdc, seeds)?;
    let hf = if kamino::refresh_after(k, &ctx.accounts.obligation)? {
        health::hf_bps(&kamino::read_obligation(&ctx.accounts.obligation, Clock::get()?.slot)?)?
    } else {
        health::HF_NO_DEBT
    };

    emit!(Repaid { account: ctx.accounts.account.key(), amount_usdc, hf_after_bps: hf });
    Ok(())
}
