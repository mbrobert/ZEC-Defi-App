//! `set_base_account`: the owner records the user's Base `OilskinAccount` — an EVM address left-padded to 32
//! bytes — as the ONLY `mint_recipient` a `deposit_for_burn` may name (SOLANA-ARCHITECTURE §14.1, §14.5). The Base
//! router records the mirror (`setSolanaRecipient`); the keeper pairs the two. Owner-only; zero is refused
//! (unlinking is not a product flow — a wrong link is corrected by setting the right one).

use crate::errors::OilskinError;
use crate::events::BaseAccountSet;
use crate::state::{UserAccount, ACCOUNT_SEED};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetBaseAccount<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ACCOUNT_SEED, owner.key().as_ref()], bump = account.bump, has_one = owner @ OilskinError::NotOwner)]
    pub account: Account<'info, UserAccount>,
}

pub fn handler(ctx: Context<SetBaseAccount>, base_account: [u8; 32]) -> Result<()> {
    require!(base_account != [0u8; 32], OilskinError::InvalidBaseAccount);
    // An EVM address is 20 bytes: the first 12 must be zero, or this is not a Base account.
    require!(base_account[..12] == [0u8; 12], OilskinError::InvalidBaseAccount);
    let account = &mut ctx.accounts.account;
    account.base_account = base_account;
    emit!(BaseAccountSet { account: account.key(), base_account });
    Ok(())
}
