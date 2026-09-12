//! `grant`, `revoke`, `revoke_all`: the owner's delegation to a keeper, with Base's rules — a re-grant inside a
//! live period carries spend forward; revoking nothing is refused so a watcher can tell a kill switch from a
//! no-op; `revoke_all` is an epoch bump that kills every grant in one transaction.

use crate::errors::OilskinError;
use crate::events::{AllGrantsRevoked, Granted, Revoked};
use crate::generated::ladder::LADDER;
use crate::state::{Grant, UserAccount, ACCOUNT_SEED, GRANT_SEED, GRANT_VERSION, MAX_SELL_SLIPPAGE_BPS};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct GrantParams {
    pub expiry_ts: i64,
    pub period_secs: u64,
    pub repay_usdc_per_period: u64,
    pub sell_zec_per_period: u64,
    pub max_sell_slippage_bps: u16,
    pub allowed_rungs: u8,
}

#[derive(Accounts)]
#[instruction(keeper: Pubkey)]
pub struct GrantIx<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Grant::INIT_SPACE,
        seeds = [GRANT_SEED, account.key().as_ref(), keeper.as_ref()],
        bump,
    )]
    pub grant: Account<'info, Grant>,
    pub system_program: Program<'info, System>,
}

pub fn grant_handler(ctx: Context<GrantIx>, keeper: Pubkey, p: GrantParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let all_rungs_mask: u8 = (1u8 << LADDER.len()) - 1;
    require!(
        keeper != Pubkey::default()
            && keeper != ctx.accounts.owner.key()
            && p.expiry_ts > now
            && p.period_secs > 0
            && p.repay_usdc_per_period > 0
            && p.allowed_rungs != 0
            && p.allowed_rungs & !all_rungs_mask == 0
            && p.max_sell_slippage_bps <= MAX_SELL_SLIPPAGE_BPS,
        OilskinError::InvalidGrant
    );

    let account = &ctx.accounts.account;
    let g = &mut ctx.accounts.grant;
    // Carry spend forward when the existing grant is live and inside its period; otherwise start fresh.
    let carry = g.version != 0 && g.is_live(account.grant_epoch, now) && !g.period_rolled(now);
    let (repay_spent, sell_spent, period_start) = if carry {
        (g.repay_usdc_spent, g.sell_zec_spent, g.period_start_ts)
    } else {
        (0, 0, now)
    };
    g.account = account.key();
    g.keeper = keeper;
    g.bump = ctx.bumps.grant;
    g.version = GRANT_VERSION;
    g.epoch = account.grant_epoch;
    g.expiry_ts = p.expiry_ts;
    g.period_secs = p.period_secs;
    g.period_start_ts = period_start;
    g.repay_usdc_per_period = p.repay_usdc_per_period;
    g.repay_usdc_spent = repay_spent;
    g.sell_zec_per_period = p.sell_zec_per_period;
    g.sell_zec_spent = sell_spent;
    g.max_sell_slippage_bps = p.max_sell_slippage_bps;
    g.allowed_rungs = p.allowed_rungs;

    emit!(Granted {
        account: account.key(),
        keeper,
        expiry_ts: p.expiry_ts,
        period_secs: p.period_secs,
        repay_usdc_per_period: p.repay_usdc_per_period,
        sell_zec_per_period: p.sell_zec_per_period,
        allowed_rungs: p.allowed_rungs,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(keeper: Pubkey)]
pub struct RevokeIx<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
    #[account(mut, seeds = [GRANT_SEED, account.key().as_ref(), keeper.as_ref()], bump = grant.bump)]
    pub grant: Account<'info, Grant>,
}

pub fn revoke_handler(ctx: Context<RevokeIx>, keeper: Pubkey) -> Result<()> {
    let g = &mut ctx.accounts.grant;
    require!(g.expiry_ts != 0, OilskinError::NotRevocable);
    g.expiry_ts = 0;
    emit!(Revoked { account: ctx.accounts.account.key(), keeper });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeAllIx<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
}

pub fn revoke_all_handler(ctx: Context<RevokeAllIx>) -> Result<()> {
    let account = &mut ctx.accounts.account;
    account.grant_epoch = account.grant_epoch.checked_add(1).ok_or(OilskinError::HealthOverflow)?;
    emit!(AllGrantsRevoked { account: account.key(), epoch: account.grant_epoch });
    Ok(())
}
