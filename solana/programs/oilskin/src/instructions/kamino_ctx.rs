//! The Kamino account set every position instruction needs, validated by address against the generated
//! constants (which shared pins to docs/VERIFIED-SOLANA-FACTS.md). One composite, reused by deposit, borrow,
//! repay, withdraw, close_position and keeper_protect, so a wrong vault cannot be passed to any of them.

use crate::generated::addresses::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::SysvarId;
use anchor_spl::token::Token;

#[derive(Accounts)]
pub struct KaminoCtx<'info> {
    /// CHECK: Kamino Lend, by address.
    #[account(address = KLEND_PROGRAM, executable)]
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: the ZCASH market, by address.
    #[account(address = ZCASH_LENDING_MARKET)]
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: klend's market authority PDA, derived here so a wrong one cannot be passed.
    #[account(
        seeds = [KLEND_SEED_LENDING_MARKET_AUTHORITY, ZCASH_LENDING_MARKET.as_ref()],
        bump,
        seeds::program = KLEND_PROGRAM,
    )]
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = ZEC_RESERVE)]
    pub zec_reserve: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = USDC_RESERVE)]
    pub usdc_reserve: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = ZEC_MINT)]
    pub zec_mint: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(address = USDC_MINT)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = ZEC_LIQUIDITY_SUPPLY)]
    pub zec_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = ZEC_COLLATERAL_MINT)]
    pub zec_collateral_mint: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = ZEC_COLLATERAL_SUPPLY)]
    pub zec_collateral_supply: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = USDC_LIQUIDITY_SUPPLY)]
    pub usdc_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: by address.
    #[account(mut, address = USDC_FEE_VAULT)]
    pub usdc_fee_vault: UncheckedAccount<'info>,
    /// CHECK: the Scope feed both reserves read, by address.
    #[account(address = SCOPE_ORACLE_PRICES)]
    pub scope_prices: UncheckedAccount<'info>,
    /// CHECK: Kamino Farms, by address (in every klend V2 account list).
    #[account(address = FARMS_PROGRAM, executable)]
    pub farms_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = Instructions::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
