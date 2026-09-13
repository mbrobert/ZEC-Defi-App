//! `deposit_for_burn`: USDC from the Account's USDC ATA burned through Circle's CCTP V2 for a mint to the user's
//! recorded Base `OilskinAccount` (BUILD-PLAN D6; SOLANA-ARCHITECTURE §14.4). Owner-only — the deploy direction.
//!
//! What the chain checks: a Base account is recorded; the amount is positive; the obligation is refreshed in
//! this instruction and the RESERVE the live debt requires on this account's ladder (§14.3,
//! `health::reserve_units_for`) stays in the Account after the burn — the USDC that makes rung 2 atomic on
//! Solana; then one CPI with the Account PDA as the burn authority (`cctp.rs`). `max_fee` and the finality
//! threshold are the caller's: the web reads Circle's fee API at send time, the program carries no fee number.
//! Every CCTP account is checked by address against the generated constants (facts file); the two PDAs that
//! depend on the Account (Circle's denylist entry) or on Anchor's convention (the event authority) are derived
//! here and compared, never taken on trust.

use crate::cctp::{self, DepositForBurnKeys, DepositForBurnParams};
use crate::errors::OilskinError;
use crate::events::BurnedToBase;
use crate::generated::addresses::*;
use crate::health;
use crate::instructions::kamino_ctx::*;
use crate::kamino;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct CctpCtx<'info> {
    /// CHECK: by address, executable.
    #[account(address = CCTP_TOKEN_MESSENGER_MINTER_V2 @ OilskinError::WrongCctpAccount, executable)]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    /// CHECK: by address, executable.
    #[account(address = CCTP_MESSAGE_TRANSMITTER_V2 @ OilskinError::WrongCctpAccount, executable)]
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: by address (a signing PDA of the messenger program; no account lives at it).
    #[account(address = CCTP_SENDER_AUTHORITY @ OilskinError::WrongCctpAccount)]
    pub sender_authority_pda: UncheckedAccount<'info>,
    /// CHECK: Circle's denylist entry for the Account — derived in the handler and compared.
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = CCTP_MESSAGE_TRANSMITTER @ OilskinError::WrongCctpAccount)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = CCTP_TOKEN_MESSENGER @ OilskinError::WrongCctpAccount)]
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: by address — the domain-6 (Base) remote messenger.
    #[account(address = CCTP_REMOTE_TOKEN_MESSENGER_BASE @ OilskinError::WrongCctpAccount)]
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = CCTP_TOKEN_MINTER @ OilskinError::WrongCctpAccount)]
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: by address — carries Circle's 10 M USDC per-message cap.
    #[account(mut, address = CCTP_LOCAL_TOKEN_USDC @ OilskinError::WrongCctpAccount)]
    pub local_token: UncheckedAccount<'info>,
    /// CHECK: the USDC mint, writable for the burn (the Kamino context lists it read-only).
    #[account(mut, address = USDC_MINT @ OilskinError::WrongCctpAccount)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: Anchor's event authority of the messenger program — derived in the handler and compared.
    pub event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositForBurn<'info> {
    /// Also the rent payer of the message account Circle writes.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    /// CHECK: the Account's obligation by key; klend owns it while a position exists, and an emptied one is
    ///        closed by klend — then no debt, no reserve, and the refresh is skipped.
    #[account(mut, constraint = obligation.key() == account.obligation @ OilskinError::WrongKaminoAccount)]
    pub obligation: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = kamino::USDC_MINT, associated_token::authority = account)]
    pub account_usdc: Account<'info, TokenAccount>,
    pub kamino: KaminoCtx<'info>,
    pub cctp: CctpCtx<'info>,
    /// A fresh keypair per burn: Circle writes the message into it; rent from the owner.
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositForBurn>, amount: u64, max_fee: u64, min_finality_threshold: u32) -> Result<()> {
    require!(amount > 0, OilskinError::ZeroAmount);
    let account_key = ctx.accounts.account.key();
    let base_account = ctx.accounts.account.base_account;
    require!(base_account != [0u8; 32], OilskinError::NoBaseAccount);
    require!(ctx.accounts.cctp.denylist_account.key() == cctp::denylist_pda(&account_key), OilskinError::WrongCctpAccount);
    require!(ctx.accounts.cctp.event_authority.key() == cctp::event_authority_pda(), OilskinError::WrongCctpAccount);

    let owner_key = ctx.accounts.owner.key();
    let bump = [ctx.accounts.account.bump];
    let seeds: &[&[u8]] = &[ACCOUNT_SEED, owner_key.as_ref(), &bump];

    // 1. The reserve, on the live debt and this account's ladder.
    let mut reserve_required = 0u64;
    if kamino::obligation_is_open(&ctx.accounts.obligation) {
        let k = &ctx.accounts.kamino;
        kamino::refresh_all(k, &ctx.accounts.obligation, seeds)?;
        let view = kamino::read_obligation(&ctx.accounts.obligation, Clock::get()?.slot)?;
        if !health::debt_is_dust(&view) {
            let debt_units = u64::try_from((view.usdc_borrowed_amount_sf + health::SF_ONE - 1) / health::SF_ONE)
                .map_err(|_| OilskinError::HealthOverflow)?;
            reserve_required = health::reserve_units_for(debt_units, ctx.accounts.account.entry_hf_bps)?;
        }
    }
    let held = ctx.accounts.account_usdc.amount;
    require!(held >= amount, OilskinError::InsufficientUsdcToClose);
    require!(held - amount >= reserve_required, OilskinError::ReserveShort);

    // 2. The burn, with the Account PDA as the token account's owner.
    let keys = DepositForBurnKeys {
        owner: account_key,
        event_rent_payer: owner_key,
        burn_token_account: ctx.accounts.account_usdc.key(),
        denylist_account: ctx.accounts.cctp.denylist_account.key(),
        message_sent_event_data: ctx.accounts.message_sent_event_data.key(),
        event_authority: ctx.accounts.cctp.event_authority.key(),
    };
    let params = DepositForBurnParams {
        amount,
        destination_domain: CCTP_DOMAIN_BASE,
        mint_recipient: Pubkey::new_from_array(base_account),
        destination_caller: Pubkey::default(),
        max_fee,
        min_finality_threshold,
    };
    let ix = cctp::ix_deposit_for_burn(&keys, &params)?;
    let c = &ctx.accounts.cctp;
    let infos = [
        ctx.accounts.account.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        c.sender_authority_pda.to_account_info(),
        ctx.accounts.account_usdc.to_account_info(),
        c.denylist_account.to_account_info(),
        c.message_transmitter.to_account_info(),
        c.token_messenger.to_account_info(),
        c.remote_token_messenger.to_account_info(),
        c.token_minter.to_account_info(),
        c.local_token.to_account_info(),
        c.usdc_mint.to_account_info(),
        ctx.accounts.message_sent_event_data.to_account_info(),
        c.message_transmitter_program.to_account_info(),
        c.token_messenger_minter_program.to_account_info(),
        ctx.accounts.kamino.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        c.event_authority.to_account_info(),
        c.token_messenger_minter_program.to_account_info(),
    ];
    invoke_signed(&ix, &infos, &[seeds])?;

    ctx.accounts.account_usdc.reload()?;
    emit!(BurnedToBase {
        account: account_key,
        amount,
        base_account,
        max_fee,
        min_finality_threshold,
        reserve_required,
        usdc_after: ctx.accounts.account_usdc.amount,
    });
    Ok(())
}
