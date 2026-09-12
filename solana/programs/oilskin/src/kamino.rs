//! Kamino Lend (klend) from the Oilskin program's side.
//!
//! Three things live here and nothing else: (1) instruction builders whose discriminators are klend IDL 1.25.0's
//! (`sha256("global:<name>")[..8]`, cross-checked against klend-sdk 12.0.0's generated code), (2) CPI helpers
//! signed with the Account PDA's seeds, and (3) byte-level readers for the `Obligation` and `Reserve` accounts,
//! whose offsets were computed from klend-sdk 12.0.0's layouts and verified against a live mainnet obligation and
//! reserve on 2026-09-12 (`solana/readers`). Nothing here is typed from memory; a layout change in klend fails
//! the length and discriminator checks below rather than misreading a field.
//!
//! Optional accounts in klend's V2 instruction lists are encoded the way the SDK encodes them: the klend
//! program id in the slot, read-only.

use crate::errors::OilskinError;
pub use crate::generated::addresses::*;
use crate::instructions::kamino_ctx::KaminoCtx;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::sysvar::SysvarId;

// ---------------------------------------------------------------- discriminators (klend IDL 1.25.0)

pub const DISC_INIT_USER_METADATA: [u8; 8] = [117, 169, 176, 69, 197, 23, 15, 162];
pub const DISC_INIT_OBLIGATION: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];
pub const DISC_REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
pub const DISC_REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];
pub const DISC_DEPOSIT_V2: [u8; 8] = [216, 224, 191, 27, 204, 151, 102, 175];
pub const DISC_BORROW_V2: [u8; 8] = [161, 128, 143, 245, 171, 199, 194, 6];
pub const DISC_REPAY_V2: [u8; 8] = [116, 174, 213, 76, 180, 53, 210, 144];
pub const DISC_WITHDRAW_V2: [u8; 8] = [235, 52, 119, 152, 149, 197, 20, 7];
pub const DISC_INITIATE_OWNERSHIP_TRANSFER: [u8; 8] = [127, 42, 81, 218, 147, 171, 76, 153];

/// Anchor account discriminators (`sha256("account:<Name>")[..8]`), from klend-sdk 12.0.0.
pub const DISC_ACCOUNT_OBLIGATION: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];
pub const DISC_ACCOUNT_RESERVE: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];

/// klend `PriceStatusFlags::ALL_CHECKS` (six bits: loaded, age, TWAP, TWAP age, heuristic, usage allowed).
pub const PRICE_STATUS_ALL_CHECKS: u8 = 0b0011_1111;

// ---------------------------------------------------------------- Obligation layout (klend-sdk 12.0.0)

pub const OBLIGATION_LEN: usize = 3344;
const OB_LAST_UPDATE_SLOT: usize = 16;
const OB_STALE: usize = 24;
const OB_PRICE_STATUS: usize = 25;
const OB_LENDING_MARKET: usize = 32;
const OB_OWNER: usize = 64;
const OB_DEPOSITS: usize = 96;
const OB_DEPOSIT_LEN: usize = 136;
const OB_DEPOSITS_N: usize = 8;
const OB_DEPOSITED_VALUE_SF: usize = 1192;
const OB_BORROWS: usize = 1208;
const OB_BORROW_LEN: usize = 200;
const OB_BORROWS_N: usize = 5;
const OB_BF_ADJUSTED_DEBT_SF: usize = 2208;
const OB_BORROWED_MARKET_VALUE_SF: usize = 2224;
const OB_ALLOWED_BORROW_VALUE_SF: usize = 2240;
const OB_UNHEALTHY_BORROW_VALUE_SF: usize = 2256;
const OB_HAS_DEBT: usize = 2287;
const OB_OWNERSHIP_TRANSFER_STATE: usize = 2324;
const OB_PENDING_OWNER: usize = 2760;
// deposit element: reserve @0 · deposited_amount u64 @32 · market_value_sf u128 @40
const DEP_RESERVE: usize = 0;
const DEP_AMOUNT: usize = 32;
// borrow element: reserve @0 · cumulative_borrow_rate_bsf @32 (48 B) · padding @80 · borrowed_amount_sf u128 @88 · market_value_sf @104
const BOR_RESERVE: usize = 0;
const BOR_AMOUNT_SF: usize = 88;

// ---------------------------------------------------------------- Reserve layout (klend-sdk 12.0.0)

pub const RESERVE_LEN: usize = 8624;
const RS_LAST_UPDATE_SLOT: usize = 16;
const RS_STALE: usize = 24;
const RS_PRICE_STATUS: usize = 25;
const RS_LENDING_MARKET: usize = 32;
const RS_LIQ_MINT: usize = 128;
const RS_LIQ_SUPPLY_VAULT: usize = 160;
const RS_LIQ_FEE_VAULT: usize = 192;
const RS_LIQ_AVAILABLE: usize = 224;
const RS_LIQ_BORROWED_SF: usize = 232;
const RS_LIQ_MARKET_PRICE_SF: usize = 248;
const RS_LIQ_DECIMALS: usize = 272;
const RS_COLL_MINT: usize = 2560;
const RS_COLL_TOTAL_SUPPLY: usize = 2592;
const RS_COLL_SUPPLY_VAULT: usize = 2600;
const RS_CFG_STATUS: usize = 4856;
const RS_CFG_LTV_PCT: usize = 4872;
const RS_CFG_LT_PCT: usize = 4873;
const RS_CFG_BORROW_FACTOR_PCT: usize = 5008;
const RS_TI_MAX_AGE_PRICE_S: usize = 5096;
const RS_SCOPE_PRICE_FEED: usize = 5112;
const RS_SCOPE_PRICE_CHAIN: usize = 5144;

// ---------------------------------------------------------------- Scope OraclePrices layout (byte-verified 2026-09-12)

const SCOPE_PRICES_HEADER: usize = 40; // disc 8 + oracle_mappings 32
const SCOPE_DATED_PRICE_LEN: usize = 56; // value u64 · exp u64 · last_updated_slot u64 · unix_timestamp u64 · generic 24

// ---------------------------------------------------------------- readers

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn u128_at(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn pubkey_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

#[derive(Debug, Clone)]
pub struct ObligationView {
    pub slot: u64,
    pub stale: bool,
    pub price_status: u8,
    pub owner: Pubkey,
    pub lending_market: Pubkey,
    /// Reserves with an active deposit entry, in slot order (what refresh_obligation expects).
    pub deposit_reserves: Vec<Pubkey>,
    /// Reserves with an active borrow entry, in slot order.
    pub borrow_reserves: Vec<Pubkey>,
    pub has_zec_deposit: bool,
    /// cToken units of ZEC collateral deposited.
    pub zec_deposited_ctokens: u64,
    /// USDC debt in base units × 2^60 (0 when no USDC borrow entry).
    pub usdc_borrowed_amount_sf: u128,
    pub deposited_value_sf: u128,
    pub borrow_factor_adjusted_debt_value_sf: u128,
    pub borrowed_assets_market_value_sf: u128,
    pub allowed_borrow_value_sf: u128,
    pub unhealthy_borrow_value_sf: u128,
    pub has_debt: bool,
    pub ownership_transfer_state: u8,
    pub pending_owner: Pubkey,
}

/// True while klend still owns the obligation with its full layout. klend CLOSES an obligation that a full
/// withdraw empties (refunding rent to its owner, the Account PDA), so after `withdraw(MAX)` with no debt this
/// is false until the next `deposit` re-creates it.
pub fn obligation_is_open(info: &AccountInfo) -> bool {
    info.owner == &KLEND_PROGRAM && info.data_len() == OBLIGATION_LEN
}

/// Decode the obligation without any freshness requirement (used to learn which reserves to refresh with).
pub fn peek_obligation(info: &AccountInfo) -> Result<ObligationView> {
    let d = info.try_borrow_data()?;
    require!(d.len() == OBLIGATION_LEN && d[0..8] == DISC_ACCOUNT_OBLIGATION, OilskinError::UnexpectedKaminoLayout);
    require!(pubkey_at(&d, OB_LENDING_MARKET) == ZCASH_LENDING_MARKET, OilskinError::WrongKaminoAccount);
    let mut deposit_reserves = Vec::with_capacity(2);
    let mut has_zec_deposit = false;
    let mut zec_deposited_ctokens = 0u64;
    for i in 0..OB_DEPOSITS_N {
        let base = OB_DEPOSITS + i * OB_DEPOSIT_LEN;
        let reserve = pubkey_at(&d, base + DEP_RESERVE);
        if reserve == Pubkey::default() {
            continue;
        }
        require!(reserve == ZEC_RESERVE, OilskinError::WrongKaminoAccount);
        deposit_reserves.push(reserve);
        has_zec_deposit = true;
        zec_deposited_ctokens = u64_at(&d, base + DEP_AMOUNT);
    }
    let mut borrow_reserves = Vec::with_capacity(2);
    let mut usdc_borrowed_amount_sf = 0u128;
    for i in 0..OB_BORROWS_N {
        let base = OB_BORROWS + i * OB_BORROW_LEN;
        let reserve = pubkey_at(&d, base + BOR_RESERVE);
        if reserve == Pubkey::default() {
            continue;
        }
        require!(reserve == USDC_RESERVE, OilskinError::WrongKaminoAccount);
        borrow_reserves.push(reserve);
        usdc_borrowed_amount_sf = u128_at(&d, base + BOR_AMOUNT_SF);
    }
    Ok(ObligationView {
        slot: u64_at(&d, OB_LAST_UPDATE_SLOT),
        stale: d[OB_STALE] != 0,
        price_status: d[OB_PRICE_STATUS],
        owner: pubkey_at(&d, OB_OWNER),
        lending_market: pubkey_at(&d, OB_LENDING_MARKET),
        deposit_reserves,
        borrow_reserves,
        has_zec_deposit,
        zec_deposited_ctokens,
        usdc_borrowed_amount_sf,
        deposited_value_sf: u128_at(&d, OB_DEPOSITED_VALUE_SF),
        borrow_factor_adjusted_debt_value_sf: u128_at(&d, OB_BF_ADJUSTED_DEBT_SF),
        borrowed_assets_market_value_sf: u128_at(&d, OB_BORROWED_MARKET_VALUE_SF),
        allowed_borrow_value_sf: u128_at(&d, OB_ALLOWED_BORROW_VALUE_SF),
        unhealthy_borrow_value_sf: u128_at(&d, OB_UNHEALTHY_BORROW_VALUE_SF),
        has_debt: d[OB_HAS_DEBT] != 0,
        ownership_transfer_state: d[OB_OWNERSHIP_TRANSFER_STATE],
        pending_owner: pubkey_at(&d, OB_PENDING_OWNER),
    })
}

/// Decode the obligation and REQUIRE it refreshed in this slot (fail closed: a stale view is never used
/// for a health decision).
pub fn read_obligation(info: &AccountInfo, current_slot: u64) -> Result<ObligationView> {
    let v = peek_obligation(info)?;
    require!(v.slot == current_slot && !v.stale, OilskinError::ObligationStale);
    Ok(v)
}

#[derive(Debug, Clone)]
pub struct ReserveView {
    pub slot: u64,
    pub stale: bool,
    pub price_status: u8,
    pub status: u8,
    pub loan_to_value_pct: u8,
    pub liquidation_threshold_pct: u8,
    pub borrow_factor_pct: u64,
    pub liquidity_mint: Pubkey,
    pub liquidity_supply_vault: Pubkey,
    pub liquidity_fee_vault: Pubkey,
    pub liquidity_available: u64,
    pub liquidity_borrowed_sf: u128,
    pub market_price_sf: u128,
    pub mint_decimals: u8,
    pub collateral_mint: Pubkey,
    pub collateral_total_supply: u64,
    pub collateral_supply_vault: Pubkey,
    pub max_age_price_seconds: u64,
    pub scope_price_feed: Pubkey,
    pub scope_price_chain0: u16,
}

pub fn read_reserve(info: &AccountInfo) -> Result<ReserveView> {
    let d = info.try_borrow_data()?;
    require!(d.len() == RESERVE_LEN && d[0..8] == DISC_ACCOUNT_RESERVE, OilskinError::UnexpectedKaminoLayout);
    require!(pubkey_at(&d, RS_LENDING_MARKET) == ZCASH_LENDING_MARKET, OilskinError::WrongKaminoAccount);
    Ok(ReserveView {
        slot: u64_at(&d, RS_LAST_UPDATE_SLOT),
        stale: d[RS_STALE] != 0,
        price_status: d[RS_PRICE_STATUS],
        status: d[RS_CFG_STATUS],
        loan_to_value_pct: d[RS_CFG_LTV_PCT],
        liquidation_threshold_pct: d[RS_CFG_LT_PCT],
        borrow_factor_pct: u64_at(&d, RS_CFG_BORROW_FACTOR_PCT),
        liquidity_mint: pubkey_at(&d, RS_LIQ_MINT),
        liquidity_supply_vault: pubkey_at(&d, RS_LIQ_SUPPLY_VAULT),
        liquidity_fee_vault: pubkey_at(&d, RS_LIQ_FEE_VAULT),
        liquidity_available: u64_at(&d, RS_LIQ_AVAILABLE),
        liquidity_borrowed_sf: u128_at(&d, RS_LIQ_BORROWED_SF),
        market_price_sf: u128_at(&d, RS_LIQ_MARKET_PRICE_SF),
        mint_decimals: u64_at(&d, RS_LIQ_DECIMALS) as u8,
        collateral_mint: pubkey_at(&d, RS_COLL_MINT),
        collateral_total_supply: u64_at(&d, RS_COLL_TOTAL_SUPPLY),
        collateral_supply_vault: pubkey_at(&d, RS_COLL_SUPPLY_VAULT),
        max_age_price_seconds: u64_at(&d, RS_TI_MAX_AGE_PRICE_S),
        scope_price_feed: pubkey_at(&d, RS_SCOPE_PRICE_FEED),
        scope_price_chain0: u16::from_le_bytes([d[RS_SCOPE_PRICE_CHAIN], d[RS_SCOPE_PRICE_CHAIN + 1]]),
    })
}

/// A Scope `DatedPrice` at `index`: (value, exp, last_updated_slot, unix_timestamp). USD = value / 10^exp.
pub fn read_scope_price(scope_prices: &AccountInfo, index: u16) -> Result<(u64, u64, u64, u64)> {
    let d = scope_prices.try_borrow_data()?;
    require!(scope_prices.owner == &SCOPE_PROGRAM, OilskinError::WrongKaminoAccount);
    let o = SCOPE_PRICES_HEADER + (index as usize) * SCOPE_DATED_PRICE_LEN;
    require!(d.len() >= o + SCOPE_DATED_PRICE_LEN, OilskinError::UnexpectedKaminoLayout);
    Ok((u64_at(&d, o), u64_at(&d, o + 8), u64_at(&d, o + 16), u64_at(&d, o + 24)))
}

// ---------------------------------------------------------------- PDAs

pub fn lending_market_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[KLEND_SEED_LENDING_MARKET_AUTHORITY, ZCASH_LENDING_MARKET.as_ref()], &KLEND_PROGRAM)
}

// ---------------------------------------------------------------- instruction builders

fn data(disc: [u8; 8], args: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + args.len());
    v.extend_from_slice(&disc);
    v.extend_from_slice(args);
    v
}
fn ro(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn none() -> AccountMeta {
    AccountMeta::new_readonly(KLEND_PROGRAM, false)
}

pub fn ix_init_user_metadata(owner: &Pubkey, fee_payer: &Pubkey, user_metadata: &Pubkey) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*fee_payer, true),
            w(*user_metadata),
            none(), // referrer user metadata
            ro(Rent::id()),
            ro(anchor_lang::solana_program::system_program::ID),
        ],
        data: data(DISC_INIT_USER_METADATA, Pubkey::default().as_ref()), // user_lookup_table = none
    }
}

pub fn ix_init_obligation(owner: &Pubkey, fee_payer: &Pubkey, obligation: &Pubkey, user_metadata: &Pubkey) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*fee_payer, true),
            w(*obligation),
            ro(ZCASH_LENDING_MARKET),
            ro(Pubkey::default()), // seed1
            ro(Pubkey::default()), // seed2
            ro(*user_metadata),
            ro(Rent::id()),
            ro(anchor_lang::solana_program::system_program::ID),
        ],
        data: data(DISC_INIT_OBLIGATION, &[0u8, 0u8]), // InitObligationArgs { tag: 0, id: 0 }
    }
}

pub fn ix_refresh_reserve(reserve: &Pubkey) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![w(*reserve), ro(ZCASH_LENDING_MARKET), none(), none(), none(), ro(SCOPE_ORACLE_PRICES)],
        data: data(DISC_REFRESH_RESERVE, &[]),
    }
}

pub fn ix_refresh_obligation(obligation: &Pubkey, reserves: &[Pubkey]) -> Instruction {
    let mut accounts = vec![ro(ZCASH_LENDING_MARKET), w(*obligation)];
    accounts.extend(reserves.iter().map(|r| w(*r)));
    Instruction { program_id: KLEND_PROGRAM, accounts, data: data(DISC_REFRESH_OBLIGATION, &[]) }
}

fn ix_sysvar() -> AccountMeta {
    ro(Instructions::id())
}

pub fn ix_deposit_v2(owner: &Pubkey, obligation: &Pubkey, lma: &Pubkey, user_source_zec: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![
            AccountMeta::new(*owner, true),
            w(*obligation),
            ro(ZCASH_LENDING_MARKET),
            ro(*lma),
            w(ZEC_RESERVE),
            ro(ZEC_MINT),
            w(ZEC_LIQUIDITY_SUPPLY),
            w(ZEC_COLLATERAL_MINT),
            w(ZEC_COLLATERAL_SUPPLY),
            w(*user_source_zec),
            none(), // placeholder_user_destination_collateral
            ro(SPL_TOKEN_PROGRAM),
            ro(SPL_TOKEN_PROGRAM),
            ix_sysvar(),
            none(), // obligation farm user state
            none(), // reserve farm state
            ro(FARMS_PROGRAM),
        ],
        data: data(DISC_DEPOSIT_V2, &amount.to_le_bytes()),
    }
}

pub fn ix_borrow_v2(owner: &Pubkey, obligation: &Pubkey, lma: &Pubkey, user_destination_usdc: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        // The obligation's deposit reserves follow as remaining accounts (writable), as Kamino's SDK passes them.
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            w(*obligation),
            ro(ZCASH_LENDING_MARKET),
            ro(*lma),
            w(USDC_RESERVE),
            ro(USDC_MINT),
            w(USDC_LIQUIDITY_SUPPLY),
            w(USDC_FEE_VAULT),
            w(*user_destination_usdc),
            none(), // referrer token state
            ro(SPL_TOKEN_PROGRAM),
            ix_sysvar(),
            none(),
            none(),
            ro(FARMS_PROGRAM),
            w(ZEC_RESERVE),
        ],
        data: data(DISC_BORROW_V2, &amount.to_le_bytes()),
    }
}

pub fn ix_repay_v2(owner: &Pubkey, obligation: &Pubkey, lma: &Pubkey, user_source_usdc: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            w(*obligation),
            ro(ZCASH_LENDING_MARKET),
            w(USDC_RESERVE),
            ro(USDC_MINT),
            w(USDC_LIQUIDITY_SUPPLY),
            w(*user_source_usdc),
            ro(SPL_TOKEN_PROGRAM),
            ix_sysvar(),
            none(),
            none(),
            ro(*lma),
            ro(FARMS_PROGRAM),
        ],
        data: data(DISC_REPAY_V2, &amount.to_le_bytes()),
    }
}

pub fn ix_withdraw_v2(owner: &Pubkey, obligation: &Pubkey, lma: &Pubkey, user_destination_zec: &Pubkey, collateral_amount: u64) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![
            AccountMeta::new(*owner, true),
            w(*obligation),
            ro(ZCASH_LENDING_MARKET),
            ro(*lma),
            w(ZEC_RESERVE),
            ro(ZEC_MINT),
            w(ZEC_COLLATERAL_SUPPLY),
            w(ZEC_COLLATERAL_MINT),
            w(ZEC_LIQUIDITY_SUPPLY),
            w(*user_destination_zec),
            none(),
            ro(SPL_TOKEN_PROGRAM),
            ro(SPL_TOKEN_PROGRAM),
            ix_sysvar(),
            none(),
            none(),
            ro(FARMS_PROGRAM),
        ],
        data: data(DISC_WITHDRAW_V2, &collateral_amount.to_le_bytes()),
    }
}

pub fn ix_initiate_ownership_transfer(owner: &Pubkey, obligation: &Pubkey, new_owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: KLEND_PROGRAM,
        accounts: vec![AccountMeta::new_readonly(*owner, true), w(*obligation), ix_sysvar()],
        data: data(DISC_INITIATE_OWNERSHIP_TRANSFER, new_owner.as_ref()),
    }
}

// ---------------------------------------------------------------- CPI helpers

/// Refresh both reserves, then the obligation with exactly the reserves it references (klend requires
/// `deposit_count + borrow_count` remaining accounts, deposits first).
pub fn refresh_all<'info>(k: &KaminoCtx<'info>, obligation: &AccountInfo<'info>, _seeds: &[&[u8]]) -> Result<()> {
    for reserve in [&k.zec_reserve, &k.usdc_reserve] {
        invoke(
            &ix_refresh_reserve(&reserve.key()),
            &[
                reserve.to_account_info(),
                k.lending_market.to_account_info(),
                k.klend_program.to_account_info(),
                k.scope_prices.to_account_info(),
            ],
        )?;
    }
    refresh_obligation_only(k, obligation)
}

/// After a state-changing klend operation (deposit, borrow, repay, withdraw) klend marks the touched reserve
/// stale again, so a post-action view needs the reserves refreshed once more before the obligation is.
/// Returns Ok(false) without touching anything when klend has closed the obligation (an emptied one).
pub fn refresh_after<'info>(k: &KaminoCtx<'info>, obligation: &AccountInfo<'info>) -> Result<bool> {
    if !obligation_is_open(obligation) {
        return Ok(false);
    }
    refresh_all(k, obligation, &[])?;
    Ok(true)
}

/// Refresh the obligation alone (the reserves must already be fresh in this slot).
pub fn refresh_obligation_only<'info>(k: &KaminoCtx<'info>, obligation: &AccountInfo<'info>) -> Result<()> {
    let view = peek_obligation(obligation)?;
    let mut reserves: Vec<Pubkey> = Vec::with_capacity(2);
    reserves.extend(view.deposit_reserves.iter());
    reserves.extend(view.borrow_reserves.iter());
    let mut infos = vec![k.lending_market.to_account_info(), obligation.clone()];
    for r in &reserves {
        if *r == ZEC_RESERVE {
            infos.push(k.zec_reserve.to_account_info());
        } else if *r == USDC_RESERVE {
            infos.push(k.usdc_reserve.to_account_info());
        } else {
            return err!(OilskinError::WrongKaminoAccount);
        }
    }
    invoke(&ix_refresh_obligation(&obligation.key(), &reserves), &infos)?;
    Ok(())
}

fn common_infos<'info>(k: &KaminoCtx<'info>) -> Vec<AccountInfo<'info>> {
    vec![
        k.klend_program.to_account_info(),
        k.lending_market.to_account_info(),
        k.lending_market_authority.to_account_info(),
        k.zec_reserve.to_account_info(),
        k.usdc_reserve.to_account_info(),
        k.zec_mint.to_account_info(),
        k.usdc_mint.to_account_info(),
        k.zec_liquidity_supply.to_account_info(),
        k.zec_collateral_mint.to_account_info(),
        k.zec_collateral_supply.to_account_info(),
        k.usdc_liquidity_supply.to_account_info(),
        k.usdc_fee_vault.to_account_info(),
        k.scope_prices.to_account_info(),
        k.farms_program.to_account_info(),
        k.instructions_sysvar.to_account_info(),
        k.token_program.to_account_info(),
    ]
}

pub fn deposit<'info>(k: &KaminoCtx<'info>, account: &AccountInfo<'info>, obligation: &AccountInfo<'info>, account_zec: &AccountInfo<'info>, amount: u64, seeds: &[&[u8]]) -> Result<()> {
    let ix = ix_deposit_v2(&account.key(), &obligation.key(), &k.lending_market_authority.key(), &account_zec.key(), amount);
    let mut infos = common_infos(k);
    infos.extend([account.clone(), obligation.clone(), account_zec.clone()]);
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

pub fn borrow<'info>(k: &KaminoCtx<'info>, account: &AccountInfo<'info>, obligation: &AccountInfo<'info>, account_usdc: &AccountInfo<'info>, amount: u64, seeds: &[&[u8]]) -> Result<()> {
    let ix = ix_borrow_v2(&account.key(), &obligation.key(), &k.lending_market_authority.key(), &account_usdc.key(), amount);
    let mut infos = common_infos(k);
    infos.extend([account.clone(), obligation.clone(), account_usdc.clone()]);
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

pub fn repay<'info>(k: &KaminoCtx<'info>, account: &AccountInfo<'info>, obligation: &AccountInfo<'info>, account_usdc: &AccountInfo<'info>, amount: u64, seeds: &[&[u8]]) -> Result<()> {
    let ix = ix_repay_v2(&account.key(), &obligation.key(), &k.lending_market_authority.key(), &account_usdc.key(), amount);
    let mut infos = common_infos(k);
    infos.extend([account.clone(), obligation.clone(), account_usdc.clone()]);
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

pub fn withdraw<'info>(k: &KaminoCtx<'info>, account: &AccountInfo<'info>, obligation: &AccountInfo<'info>, account_zec: &AccountInfo<'info>, collateral_amount: u64, seeds: &[&[u8]]) -> Result<()> {
    let ix = ix_withdraw_v2(&account.key(), &obligation.key(), &k.lending_market_authority.key(), &account_zec.key(), collateral_amount);
    let mut infos = common_infos(k);
    infos.extend([account.clone(), obligation.clone(), account_zec.clone()]);
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}
