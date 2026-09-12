//! Program-owned state: the user's Account (the Solana twin of `OilskinAccount`) and a keeper Grant.
//! Both are PDAs; both carry a version byte and reserved bytes so a later layout can be migrated
//! explicitly rather than reinterpreted.

use anchor_lang::prelude::*;

/// Seed for the Account PDA: `["account", wallet]`.
pub const ACCOUNT_SEED: &[u8] = b"account";
/// Seed for the Grant PDA: `["grant", account, keeper]`.
pub const GRANT_SEED: &[u8] = b"grant";

pub const ACCOUNT_VERSION: u8 = 1;
pub const GRANT_VERSION: u8 = 1;

/// The all-zero pubkey, as a const (klend's "no seed" placeholder in the obligation PDA).
pub const DEFAULT_PUBKEY: Pubkey = Pubkey::new_from_array([0u8; 32]);
/// klend obligation tag / id for a vanilla obligation.
pub const OBLIGATION_TAG: [u8; 1] = [0];
pub const OBLIGATION_ID: [u8; 1] = [0];

/// Hard cap on a grant's slippage floor, in basis points (Base: the swap adapter's 500 cap).
pub const MAX_SELL_SLIPPAGE_BPS: u16 = 500;

/// The user's account. `owner` is set once by `init_account` and never changes.
#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    /// The wallet that owns this account. Immutable.
    pub owner: Pubkey,
    pub bump: u8,
    pub version: u8,
    /// Bumped by `revoke_all`; a Grant is live only while its `epoch` equals this.
    pub grant_epoch: u64,
    /// The Kamino obligation this account owns (PDA of klend, owner = this account).
    pub obligation: Pubkey,
    pub created_slot: u64,
    pub _reserved: [u8; 64],
}

/// A keeper's delegation. The keeper may call `keeper_protect` and nothing else, inside these bounds.
#[account]
#[derive(InitSpace)]
pub struct Grant {
    pub account: Pubkey,
    pub keeper: Pubkey,
    pub bump: u8,
    pub version: u8,
    /// Must equal `UserAccount.grant_epoch` to be live.
    pub epoch: u64,
    /// Unix seconds; 0 after `revoke`.
    pub expiry_ts: i64,
    pub period_secs: u64,
    pub period_start_ts: i64,
    /// USDC base units the keeper may repay from the account's idle USDC per period.
    pub repay_usdc_per_period: u64,
    pub repay_usdc_spent: u64,
    /// ZEC base units the keeper may sell per period to repay (0 = never sell collateral).
    pub sell_zec_per_period: u64,
    pub sell_zec_spent: u64,
    /// Floor on a sale: proceeds ≥ Scope price × amount × (1 − this).
    pub max_sell_slippage_bps: u16,
    /// Bitmask over ladder rung ids (bit i = rung id i may be acted on).
    pub allowed_rungs: u8,
    pub _reserved: [u8; 32],
}

impl Grant {
    /// Whether this grant can act right now (epoch matches, not expired, not revoked).
    pub fn is_live(&self, account_epoch: u64, now_ts: i64) -> bool {
        self.expiry_ts != 0 && self.epoch == account_epoch && now_ts < self.expiry_ts
    }

    /// Whether the period window has rolled over at `now_ts` (spend counters would reset).
    pub fn period_rolled(&self, now_ts: i64) -> bool {
        now_ts >= self.period_start_ts.saturating_add(self.period_secs as i64)
    }

    /// Apply the period roll if due. The view a client renders must apply the same rule.
    pub fn roll_period(&mut self, now_ts: i64) {
        if self.period_rolled(now_ts) {
            self.period_start_ts = now_ts;
            self.repay_usdc_spent = 0;
            self.sell_zec_spent = 0;
        }
    }
}
