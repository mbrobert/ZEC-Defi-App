//! Oilskin — Solana module.
//!
//! The Solana twin of `OilskinAccount` + its keeper grant: an Account PDA (program-derived address) the user's
//! wallet owns, which owns a Kamino obligation on the ZCASH market; typed owner instructions with the entry and
//! exit floors enforced in the program; a keeper delegation limited to the health ladder's rungs and revocable
//! by the owner. Design: docs/SOLANA-ARCHITECTURE.md. Facts every constant comes from: docs/VERIFIED-SOLANA-FACTS.md.
//!
//! Nothing here types a threshold, an address or a rate of its own: `generated/ladder.rs` and
//! `generated/addresses.rs` are written from `packages/shared` and pinned by seam tests; LTV and the
//! liquidation threshold are read from the Kamino reserve at call time.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod generated;
pub mod health;
pub mod instructions;
pub mod kamino;
pub mod state;

use instructions::*;

declare_id!("Gw2UE3MixYgA8c7nLZC9UF2z3z5dWfzrFW7ESmi5Scog");

#[program]
pub mod oilskin {
    use super::*;

    /// Create the Account PDA, its ZEC and USDC token accounts, and the Kamino user metadata + obligation it owns.
    pub fn init_account(ctx: Context<InitAccount>) -> Result<()> {
        instructions::init_account::handler(ctx)
    }

    /// Wallet ZEC → Account → Kamino collateral.
    pub fn deposit(ctx: Context<Deposit>, amount_zec: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount_zec)
    }

    /// Borrow USDC into the Account; refused unless HF ≥ the entry floor and LTV ≤ the offer afterwards.
    pub fn borrow(ctx: Context<Borrow>, amount_usdc: u64) -> Result<()> {
        instructions::borrow::handler(ctx, amount_usdc)
    }

    /// Repay USDC from the Account (`u64::MAX` = all).
    pub fn repay(ctx: Context<Repay>, amount_usdc: u64) -> Result<()> {
        instructions::repay::handler(ctx, amount_usdc)
    }

    /// Withdraw collateral (cToken units; `u64::MAX` = all) to the Account; refused below the exit floor unless the debt is dust.
    pub fn withdraw(ctx: Context<Withdraw>, collateral_amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, collateral_amount)
    }

    /// Any token from the Account's ATA to the wallet. Owner-only, no other gate.
    pub fn transfer_out(ctx: Context<TransferOut>, amount: u64) -> Result<()> {
        instructions::transfer_out::handler(ctx, amount)
    }

    /// Repay everything then withdraw everything.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::close_position::handler(ctx)
    }

    /// Create or overwrite a keeper's grant.
    pub fn grant(ctx: Context<GrantIx>, keeper: Pubkey, params: GrantParams) -> Result<()> {
        instructions::grant::grant_handler(ctx, keeper, params)
    }

    /// Kill one keeper's grant.
    pub fn revoke(ctx: Context<RevokeIx>, keeper: Pubkey) -> Result<()> {
        instructions::grant::revoke_handler(ctx, keeper)
    }

    /// Kill every grant at once (epoch bump).
    pub fn revoke_all(ctx: Context<RevokeAllIx>) -> Result<()> {
        instructions::grant::revoke_all_handler(ctx)
    }
}
