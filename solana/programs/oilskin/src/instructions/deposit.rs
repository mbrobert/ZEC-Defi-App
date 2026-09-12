//! `deposit`: wallet ZEC → the Account's ZEC ATA → Kamino collateral on the obligation the Account owns.

use crate::errors::OilskinError;
use crate::events::Deposited;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    /// CHECK: the Account's obligation by address. klend owns it while open; a full withdraw closes it, and
    /// this instruction re-creates it (same PDA) before depositing.
    #[account(mut, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: klend's user metadata PDA for the Account (needed only when the obligation is re-created).
    #[account(seeds = [kamino::KLEND_SEED_USER_METADATA, account.key().as_ref()], bump, seeds::program = kamino::KLEND_PROGRAM)]
    pub user_metadata: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    #[account(mut, token::mint = kamino::ZEC_MINT, token::authority = owner)]
    pub owner_zec: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = kamino::ZEC_MINT, associated_token::authority = account)]
    pub account_zec: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Deposit>, amount_zec: u64) -> Result<()> {
    require!(amount_zec > 0, OilskinError::ZeroAmount);

    // wallet → account ATA (owner signs)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_zec.to_account_info(),
                to: ctx.accounts.account_zec.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount_zec,
    )?;

    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];

    let k = &ctx.accounts.kamino;
    if !kamino::obligation_is_open(&ctx.accounts.obligation) {
        // klend closed it after the last full withdraw: create it again, owned by the Account.
        let ix = kamino::ix_init_obligation(&ctx.accounts.account.key(), &owner_key, &ctx.accounts.obligation.key(), &ctx.accounts.user_metadata.key());
        invoke_signed(
            &ix,
            &[
                ctx.accounts.account.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.obligation.to_account_info(),
                k.lending_market.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.user_metadata.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[seeds],
        )?;
    }
    kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
    kamino::deposit(k, &ctx.accounts.account.to_account_info(), &ctx.accounts.obligation, &ctx.accounts.account_zec.to_account_info(), amount_zec, seeds)?;

    emit!(Deposited { account: ctx.accounts.account.key(), amount_zec });
    Ok(())
}
