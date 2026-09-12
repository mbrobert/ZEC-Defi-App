//! LOCALNET ONLY — a mock of Kamino's Scope oracle program, loaded by `scripts/localnet.sh` AT SCOPE'S OWN
//! PROGRAM ID (`--bpf-program HFn8… mock_scope.so`) so the cloned `OraclePrices` account, whose owner is that
//! id, becomes writable by tests. Kamino's `refresh_reserve` never CPIs into Scope; it only reads the account,
//! so a mock that owns and rewrites it is all the harness needs to (a) keep prices fresh (klend refuses a price
//! older than the reserve's `max_age_price_seconds`, 180 s on the ZCASH reserves, and overflows on a future
//! timestamp — `last_update.rs:96`), and (b) move the ZEC price to walk the ladder.
//!
//! Never deployed to any real cluster. Not part of the audited surface. The layout written here is the one
//! byte-verified in docs/VERIFIED-SOLANA-FACTS.md: 8 | 32 | 512 × DatedPrice { value u64, exp u64,
//! last_updated_slot u64, unix_timestamp u64, generic 24 }.

use anchor_lang::prelude::*;

declare_id!("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

const HEADER: usize = 40;
const ENTRY: usize = 56;
const ENTRIES: usize = 512;

#[program]
pub mod mock_scope {
    use super::*;

    /// Set `prices[index]` to (value, exp) and stamp it with the current slot and unix time.
    pub fn set_price(ctx: Context<Mutate>, index: u16, value: u64, exp: u64) -> Result<()> {
        let clock = Clock::get()?;
        write(&ctx.accounts.oracle_prices, index, Some((value, exp)), clock.slot, clock.unix_timestamp as u64)
    }

    /// Re-stamp `indices` with the current slot and unix time, prices unchanged.
    pub fn stamp_fresh(ctx: Context<Mutate>, indices: Vec<u16>) -> Result<()> {
        let clock = Clock::get()?;
        for i in indices {
            write(&ctx.accounts.oracle_prices, i, None, clock.slot, clock.unix_timestamp as u64)?;
        }
        Ok(())
    }
}

fn write(info: &UncheckedAccount, index: u16, price: Option<(u64, u64)>, slot: u64, ts: u64) -> Result<()> {
    require!((index as usize) < ENTRIES, MockScopeError::IndexOutOfRange);
    let mut d = info.try_borrow_mut_data()?;
    require!(d.len() == HEADER + ENTRIES * ENTRY, MockScopeError::UnexpectedLayout);
    let o = HEADER + (index as usize) * ENTRY;
    if let Some((value, exp)) = price {
        d[o..o + 8].copy_from_slice(&value.to_le_bytes());
        d[o + 8..o + 16].copy_from_slice(&exp.to_le_bytes());
    }
    d[o + 16..o + 24].copy_from_slice(&slot.to_le_bytes());
    d[o + 24..o + 32].copy_from_slice(&ts.to_le_bytes());
    Ok(())
}

#[derive(Accounts)]
pub struct Mutate<'info> {
    /// CHECK: the cloned Scope OraclePrices account; owned by this program id on localnet by construction.
    #[account(mut, owner = crate::ID)]
    pub oracle_prices: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

#[error_code]
pub enum MockScopeError {
    #[msg("index out of range")]
    IndexOutOfRange,
    #[msg("account is not a 512-entry OraclePrices")]
    UnexpectedLayout,
}
