//! `init_account`: create the user's Account PDA, its ZEC and USDC associated token accounts, and — by CPI
//! signed with the Account's seeds — the Kamino user metadata and the obligation the Account owns.

use crate::events::AccountInitialized;
use crate::generated::addresses::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED, ACCOUNT_VERSION, DEFAULT_PUBKEY, OBLIGATION_ID, OBLIGATION_TAG};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [ACCOUNT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub account: Account<'info, UserAccount>,
    #[account(address = ZEC_MINT)]
    pub zec_mint: Account<'info, Mint>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = zec_mint,
        associated_token::authority = account,
    )]
    pub account_zec: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = account,
    )]
    pub account_usdc: Account<'info, TokenAccount>,
    /// CHECK: klend's user metadata PDA for the Account, derived here; created by CPI.
    #[account(
        mut,
        seeds = [KLEND_SEED_USER_METADATA, account.key().as_ref()],
        bump,
        seeds::program = KLEND_PROGRAM,
    )]
    pub user_metadata: UncheckedAccount<'info>,
    /// CHECK: klend's obligation PDA (tag 0, id 0, owner = Account, seeds default), derived here; created by CPI.
    #[account(
        mut,
        seeds = [OBLIGATION_TAG.as_ref(), OBLIGATION_ID.as_ref(), account.key().as_ref(), ZCASH_LENDING_MARKET.as_ref(), DEFAULT_PUBKEY.as_ref(), DEFAULT_PUBKEY.as_ref()],
        bump,
        seeds::program = KLEND_PROGRAM,
    )]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = ZCASH_LENDING_MARKET)]
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = KLEND_PROGRAM, executable)]
    pub klend_program: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(ctx: Context<InitAccount>) -> Result<()> {
    let account = &mut ctx.accounts.account;
    account.owner = ctx.accounts.owner.key();
    account.bump = ctx.bumps.account;
    account.version = ACCOUNT_VERSION;
    account.grant_epoch = 0;
    account.obligation = ctx.accounts.obligation.key();
    account.created_slot = Clock::get()?.slot;

    let owner_key = ctx.accounts.owner.key();
    let bump = [account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];
    let account_key = account.key();

    // 1. klend user metadata for the Account (no lookup table: the default pubkey, as integrators pass).
    let ix = kamino::ix_init_user_metadata(&account_key, &owner_key, &ctx.accounts.user_metadata.key());
    invoke_signed(
        &ix,
        &[
            ctx.accounts.account.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.user_metadata.to_account_info(),
            ctx.accounts.klend_program.to_account_info(), // referrer user metadata = None placeholder
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    // 2. the obligation, owned by the Account.
    let ix = kamino::ix_init_obligation(
        &account_key,
        &owner_key,
        &ctx.accounts.obligation.key(),
        &ctx.accounts.user_metadata.key(),
    );
    invoke_signed(
        &ix,
        &[
            ctx.accounts.account.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.obligation.to_account_info(),
            ctx.accounts.lending_market.to_account_info(),
            ctx.accounts.system_program.to_account_info(), // seed1 = default pubkey (the system program id)
            ctx.accounts.system_program.to_account_info(), // seed2 = default pubkey
            ctx.accounts.user_metadata.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    emit!(AccountInitialized { account: account_key, owner: owner_key, obligation: ctx.accounts.obligation.key() });
    Ok(())
}
