// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHyperCore — Hyperliquid's HyperCore as HyperEVM (chain 999) sees it: the CoreWriter actions a
///        contract may send and the read precompiles that answer, with the shapes that answered.
///
/// @notice SOURCE OF TRUTH: `docs/VERIFIED-PERPS-FACTS-2026-09-14.md` §4/§6 and the reads of 2026-09-25 in
///         `docs/research/hyperevm-reads-2026-09-25.json`. Every struct below was DECODED FROM CHAIN against
///         the venue's API at the same second (a live ZEC short, block 46,887,687) — except where a comment
///         says [doc]. `packages/shared/src/perps.ts` carries the same shapes for the keeper and the tests.
/// @dev CoreWriter actions are processed by HyperCore a few seconds after the EVM transaction and CANNOT
///      revert it: an order that is refused, a transfer that finds no balance, simply does not happen. The
///      keeper judges every action by a later read, never by the sending receipt (design §5).
interface ICoreWriter {
    /// @notice `0x3333333333333333333333333333333333333333`, selector 0x17938e13 (facts §4).
    function sendRawAction(bytes calldata data) external;
}

/// @notice The contract HyperCore names as USDC (token 0)'s `evmContract`: a Circle-style proxy holding Circle's
///         USDC that pulls the caller's USDC, emits the linked `Transfer` to the system address, and delivers
///         the wei to the CALLER on the chosen dex through CoreWriter action 13 (live tx 0xeaf2…acb9,
///         block 46,887,881). Its `balanceOf` / `decimals` REVERT — it is not an ERC-20 to read.
interface IHyperCoreUsdcAdapter {
    /// @param amount In the ERC-20's 6 decimals (`evm_extra_wei_decimals` −2 against `weiDecimals` 8).
    /// @param destinationDex 0 = the perp dex the ZEC market is on (the live call), `type(uint32).max` = spot
    ///        [inferred from action 13's own convention; D0b proves it].
    function deposit(uint256 amount, uint32 destinationDex) external;
    function token() external view returns (address);
    function paused() external view returns (bool);
}

/// @notice The read precompiles (facts §4; 2026-09-25 decodes). Inputs are raw ABI words, no selector.
library HyperCorePrecompiles {
    /// (address user, uint16 perp) → Position
    address internal constant POSITION = 0x0000000000000000000000000000000000000800;
    /// (address user, uint64 token) → SpotBalance
    address internal constant SPOT_BALANCE = 0x0000000000000000000000000000000000000801;
    /// (address user) → uint64 withdrawable, 10^6 USDC
    address internal constant WITHDRAWABLE = 0x0000000000000000000000000000000000000803;
    /// (uint32 perp) → uint64 mark, 10^(6 − szDecimals)
    address internal constant MARK_PX = 0x0000000000000000000000000000000000000806;
    /// (uint32 perp) → uint64 oracle, 10^(6 − szDecimals)
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    /// () → uint64 HyperCore block number
    address internal constant L1_BLOCK_NUMBER = 0x0000000000000000000000000000000000000809;
    /// (uint32 perp) → PerpAssetInfo
    address internal constant PERP_ASSET_INFO = 0x000000000000000000000000000000000000080a;
    /// (uint32 token) → TokenInfo
    address internal constant TOKEN_INFO = 0x000000000000000000000000000000000000080C;
    /// (uint32 perpDex, address user) → AccountMarginSummary
    address internal constant ACCOUNT_MARGIN_SUMMARY = 0x000000000000000000000000000000000000080F;
    /// (address user) → bool
    address internal constant CORE_USER_EXISTS = 0x0000000000000000000000000000000000000810;
}

/// @notice `position(address, uint16)`: five words, decoded 2026-09-25 against the API (szi −5176 = −51.76 ZEC).
struct HyperCorePosition {
    /// Signed size in 10^szDecimals; NEGATIVE for a short.
    int64 szi;
    /// Entry notional, 10^6 USDC.
    uint64 entryNtl;
    int64 isolatedRawUsd;
    uint32 leverage;
    bool isIsolated;
}

/// @notice `spotBalance(address, uint64)`: in the token's `weiDecimals` (USDC: 10^8; 154,956,382 = 1.54956382).
struct HyperCoreSpotBalance {
    uint64 total;
    uint64 hold;
    uint64 entryNtl;
}

/// @notice `accountMarginSummary(uint32, address)`: 10^6 USDC. `marginUsed` is INITIAL margin in use, not maintenance.
struct HyperCoreAccountMarginSummary {
    int64 accountValue;
    uint64 marginUsed;
    uint64 ntlPos;
    int64 rawUsd;
}

/// @notice `perpAssetInfo(uint32)`: ZEC (214) read as ("ZEC", 52, 2, 10, false) on 2026-09-25.
struct HyperCorePerpAssetInfo {
    string coin;
    uint32 marginTableId;
    uint8 szDecimals;
    uint8 maxLeverage;
    bool onlyIsolated;
}

/// @notice `tokenInfo(uint32)`: USDC (0) read as ("USDC", [], 0, 0x0, 0x6b9e…0a24, 8, 8, −2) on 2026-09-25.
struct HyperCoreTokenInfo {
    string name;
    uint64[] spots;
    uint64 deployerTradingFeeShare;
    address deployer;
    address evmContract;
    uint8 szDecimals;
    uint8 weiDecimals;
    int8 evmExtraWeiDecimals;
}
