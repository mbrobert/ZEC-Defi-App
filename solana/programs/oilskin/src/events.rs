use anchor_lang::prelude::*;

#[event]
pub struct AccountInitialized {
    pub account: Pubkey,
    pub owner: Pubkey,
    pub obligation: Pubkey,
}

#[event]
pub struct Deposited {
    pub account: Pubkey,
    pub amount_zec: u64,
}

#[event]
pub struct Borrowed {
    pub account: Pubkey,
    pub amount_usdc: u64,
    pub hf_after_bps: u64,
    pub ltv_after_bps: u64,
    /// The record the ladder now derives from (= hf_after_bps unless the borrow was dust).
    pub entry_hf_bps: u64,
}

#[event]
pub struct BaseAccountSet {
    pub account: Pubkey,
    pub base_account: [u8; 32],
}

#[event]
pub struct BurnedToBase {
    pub account: Pubkey,
    pub amount: u64,
    pub base_account: [u8; 32],
    pub max_fee: u64,
    pub min_finality_threshold: u32,
    /// The reserve the debt required at this burn (0 with no non-dust debt).
    pub reserve_required: u64,
    /// The Account's USDC after the burn.
    pub usdc_after: u64,
}

#[event]
pub struct Repaid {
    pub account: Pubkey,
    pub amount_usdc: u64,
    pub hf_after_bps: u64,
}

#[event]
pub struct Withdrawn {
    pub account: Pubkey,
    pub collateral_amount: u64,
    pub hf_after_bps: u64,
}

#[event]
pub struct TransferredOut {
    pub account: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PositionClosed {
    pub account: Pubkey,
}

#[event]
pub struct Granted {
    pub account: Pubkey,
    pub keeper: Pubkey,
    pub expiry_ts: i64,
    pub period_secs: u64,
    pub repay_usdc_per_period: u64,
    pub sell_zec_per_period: u64,
    pub allowed_rungs: u8,
}

#[event]
pub struct Revoked {
    pub account: Pubkey,
    pub keeper: Pubkey,
}

#[event]
pub struct AllGrantsRevoked {
    pub account: Pubkey,
    pub epoch: u64,
}

#[event]
pub struct KeeperProtected {
    pub account: Pubkey,
    pub keeper: Pubkey,
    pub rung: u8,
    pub repaid_usdc: u64,
    pub sold_zec: u64,
    pub hf_before_bps: u64,
    pub hf_after_bps: u64,
}

#[event]
pub struct ObligationReleased {
    pub account: Pubkey,
    pub new_owner: Pubkey,
}
