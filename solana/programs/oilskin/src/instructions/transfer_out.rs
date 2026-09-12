//! `transfer_out`: any token the Account holds (ZEC or USDC) from the Account's ATA to the wallet's ATA.
//! Owner-only, no other gate: with `repay` and `withdraw` this is the always-exit path (FLOWS.md §8's twin).

use crate::errors::OilskinError;
use crate::events::TransferredOut;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct TransferOut<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = account)]
    pub account_token: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<TransferOut>, amount: u64) -> Result<()> {
    require!(amount > 0, OilskinError::ZeroAmount);
    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.account_token.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.account.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(TransferredOut { account: ctx.accounts.account.key(), mint: ctx.accounts.mint.key(), amount });
    Ok(())
}
