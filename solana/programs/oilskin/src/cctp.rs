//! Circle's CCTP V2 `deposit_for_burn` as one hand-built instruction (docs/VERIFIED-SOLANA-FACTS.md Addendum 3:
//! the account list and the params, read from Circle's source; the PDAs read live). No Circle crate: the
//! discriminator is Anchor's `sha256("global:deposit_for_burn")[..8]` (computed here, pinned by the localnet
//! run), the params are Borsh in Circle's field order. The `#[event_cpi]` pair (event authority, program) is
//! appended last, as Anchor lays it out.

use crate::generated::addresses::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

/// Circle's `DepositForBurnParams`, Borsh in this order (Addendum 3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepositForBurnParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

/// The keys `deposit_for_burn` takes, named as Circle names them.
pub struct DepositForBurnKeys {
    /// The burn token account's owner — the Account PDA, signing by `invoke_signed`.
    pub owner: Pubkey,
    pub event_rent_payer: Pubkey,
    pub burn_token_account: Pubkey,
    pub denylist_account: Pubkey,
    pub message_sent_event_data: Pubkey,
    pub event_authority: Pubkey,
}

/// `sha256("global:deposit_for_burn")[..8]`, precomputed by the generator from the preimage shared records and
/// pinned by `solana/test/addresses-seam.test.mjs` (the same route klend's discriminators take in `kamino.rs`).
pub fn discriminator() -> [u8; 8] {
    CCTP_DEPOSIT_FOR_BURN_DISCRIMINATOR
}

pub fn ix_deposit_for_burn(k: &DepositForBurnKeys, params: &DepositForBurnParams) -> Result<Instruction> {
    let mut data = discriminator().to_vec();
    params.serialize(&mut data)?;
    Ok(Instruction {
        program_id: CCTP_TOKEN_MESSENGER_MINTER_V2,
        accounts: vec![
            AccountMeta::new_readonly(k.owner, true),
            AccountMeta::new(k.event_rent_payer, true),
            AccountMeta::new_readonly(CCTP_SENDER_AUTHORITY, false),
            AccountMeta::new(k.burn_token_account, false),
            AccountMeta::new_readonly(k.denylist_account, false),
            AccountMeta::new(CCTP_MESSAGE_TRANSMITTER, false),
            AccountMeta::new_readonly(CCTP_TOKEN_MESSENGER, false),
            AccountMeta::new_readonly(CCTP_REMOTE_TOKEN_MESSENGER_BASE, false),
            AccountMeta::new_readonly(CCTP_TOKEN_MINTER, false),
            AccountMeta::new(CCTP_LOCAL_TOKEN_USDC, false),
            AccountMeta::new(USDC_MINT, false),
            AccountMeta::new(k.message_sent_event_data, true),
            AccountMeta::new_readonly(CCTP_MESSAGE_TRANSMITTER_V2, false),
            AccountMeta::new_readonly(CCTP_TOKEN_MESSENGER_MINTER_V2, false),
            AccountMeta::new_readonly(SPL_TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(k.event_authority, false),
            AccountMeta::new_readonly(CCTP_TOKEN_MESSENGER_MINTER_V2, false),
        ],
        data,
    })
}

/// Circle's denylist entry PDA for `owner` — absent unless Circle denylisted that owner; passed so the program can
/// refuse a burn for a denylisted Account by Circle's own rule rather than ours.
pub fn denylist_pda(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CCTP_SEED_DENYLIST, owner.as_ref()], &CCTP_TOKEN_MESSENGER_MINTER_V2).0
}

/// Anchor's `#[event_cpi]` event authority of the messenger program.
pub fn event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[CCTP_SEED_EVENT_AUTHORITY], &CCTP_TOKEN_MESSENGER_MINTER_V2).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_params_serialise_in_circles_order_and_the_discriminator_is_anchors() {
        let p = DepositForBurnParams {
            amount: 1_000_000,
            destination_domain: 6,
            mint_recipient: Pubkey::new_from_array([7u8; 32]),
            destination_caller: Pubkey::default(),
            max_fee: 100,
            min_finality_threshold: 1000,
        };
        let mut v = Vec::new();
        p.serialize(&mut v).unwrap();
        assert_eq!(v.len(), 8 + 4 + 32 + 32 + 8 + 4);
        assert_eq!(&v[0..8], &1_000_000u64.to_le_bytes());
        assert_eq!(&v[8..12], &6u32.to_le_bytes());
        assert_eq!(&v[12..44], &[7u8; 32]);
        assert_eq!(&v[44..76], &[0u8; 32]);
        assert_eq!(&v[76..84], &100u64.to_le_bytes());
        assert_eq!(&v[84..88], &1000u32.to_le_bytes());
        let d = discriminator();
        assert_eq!(d, CCTP_DEPOSIT_FOR_BURN_DISCRIMINATOR);
        let k = DepositForBurnKeys {
            owner: Pubkey::new_unique(),
            event_rent_payer: Pubkey::new_unique(),
            burn_token_account: Pubkey::new_unique(),
            denylist_account: Pubkey::new_unique(),
            message_sent_event_data: Pubkey::new_unique(),
            event_authority: Pubkey::new_unique(),
        };
        let ix = ix_deposit_for_burn(&k, &p).unwrap();
        assert_eq!(ix.accounts.len(), 18);
        assert!(ix.accounts[0].is_signer && !ix.accounts[0].is_writable, "owner signs, read-only");
        assert!(ix.accounts[1].is_signer && ix.accounts[1].is_writable, "rent payer signs, writable");
        assert!(ix.accounts[11].is_signer && ix.accounts[11].is_writable, "event data account signs, writable");
        assert_eq!(ix.data.len(), 8 + 88);
        assert_eq!(&ix.data[..8], &d);
    }
}
