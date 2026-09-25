// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    HyperCoreAccountMarginSummary,
    HyperCorePerpAssetInfo,
    HyperCorePosition,
    HyperCorePrecompiles,
    HyperCoreSpotBalance,
    HyperCoreTokenInfo
} from "../interfaces/IHyperCore.sol";

/// @title HyperCoreLib — the ONLY code in the tree that knows HyperCore's byte layouts: the CoreWriter action
///        encoding (version 1, three-byte id, ABI words) and the precompile reads, each refusing to return a
///        number it could not decode.
///
/// @notice Encoding rule and action 13's tuple: read from a live `RawAction` log (tx 0xeaf2…acb9, block
///         46,887,881, `docs/research/hyperevm-reads-2026-09-25.json`). Action 1's and action 7's tuples:
///         Hyperliquid's documentation, quoted in facts §6 — **[doc]**, proven by `scripts/perps-d0b-testnet.mjs`
///         before any deployment relies on them. `packages/shared/src/perps.ts` encodes identically and the
///         Foundry tests pin the two byte for byte.
library HyperCoreLib {
    uint8 internal constant ACTION_VERSION = 1;
    uint24 internal constant ACTION_LIMIT_ORDER = 1;
    uint24 internal constant ACTION_USD_CLASS_TRANSFER = 7;
    uint24 internal constant ACTION_SEND_ASSET = 13;
    /// @notice `encodedTif` for a limit order [doc]: 1 = add-liquidity-only, 2 = good-till-cancel, 3 = immediate-or-cancel.
    uint8 internal constant TIF_ALO = 1;
    uint8 internal constant TIF_GTC = 2;
    uint8 internal constant TIF_IOC = 3;
    /// @notice `source_dex` / `destination_dex` for spot in action 13 (docs, and the live log's 0xffffffff).
    uint32 internal constant SPOT_DEX = type(uint32).max;
    /// @notice The perp dex the ZEC market is on — `accountMarginSummary(0, user)` is this dex's summary.
    uint32 internal constant PERP_DEX = 0;

    /// @notice A precompile did not answer, or answered with a shape this code does not decode. Nothing is read.
    error PrecompileReadFailed(address precompile);

    // ------------------------------------------------------------------ encode

    function encodeAction(uint24 id, bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_VERSION, id, args);
    }

    /// @notice Action 1 [doc]: (uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 tif, uint128 cloid);
    ///         `limitPx` and `sz` are 10^8 × the human value — NOT the precompiles' 10^(6 − szDecimals).
    function encodeLimitOrder(uint32 asset, bool isBuy, uint64 limitPxE8, uint64 szE8, bool reduceOnly, uint8 tif)
        internal
        pure
        returns (bytes memory)
    {
        return encodeAction(ACTION_LIMIT_ORDER, abi.encode(asset, isBuy, limitPxE8, szE8, reduceOnly, tif, uint128(0)));
    }

    /// @notice Action 7 [doc]: (uint64 ntl, bool toPerp) — USDC between the account's spot and perp balances.
    function encodeUsdClassTransfer(uint64 ntl, bool toPerp) internal pure returns (bytes memory) {
        return encodeAction(ACTION_USD_CLASS_TRANSFER, abi.encode(ntl, toPerp));
    }

    /// @notice Action 13 (live log): (address destination, address subAccount, uint32 sourceDex, uint32 destinationDex,
    ///         uint64 token, uint64 wei); `wei` in the token's weiDecimals (USDC 10^8).
    function encodeSendAsset(
        address destination,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 token,
        uint64 weiAmount
    ) internal pure returns (bytes memory) {
        return encodeAction(ACTION_SEND_ASSET, abi.encode(destination, address(0), sourceDex, destinationDex, token, weiAmount));
    }

    // -------------------------------------------------------------------- read

    function _read(address precompile, bytes memory input, uint256 exactLength) private view returns (bytes memory out) {
        bool ok;
        (ok, out) = precompile.staticcall(input);
        if (!ok || (exactLength != 0 && out.length != exactLength)) revert PrecompileReadFailed(precompile);
    }

    function position(address user, uint16 perp) internal view returns (HyperCorePosition memory p) {
        bytes memory out = _read(HyperCorePrecompiles.POSITION, abi.encode(user, perp), 5 * 32);
        (p.szi, p.entryNtl, p.isolatedRawUsd, p.leverage, p.isIsolated) =
            abi.decode(out, (int64, uint64, int64, uint32, bool));
    }

    function spotBalance(address user, uint64 token) internal view returns (HyperCoreSpotBalance memory b) {
        bytes memory out = _read(HyperCorePrecompiles.SPOT_BALANCE, abi.encode(user, token), 3 * 32);
        (b.total, b.hold, b.entryNtl) = abi.decode(out, (uint64, uint64, uint64));
    }

    function withdrawable(address user) internal view returns (uint64) {
        return abi.decode(_read(HyperCorePrecompiles.WITHDRAWABLE, abi.encode(user), 32), (uint64));
    }

    function markPx(uint32 perp) internal view returns (uint64) {
        return abi.decode(_read(HyperCorePrecompiles.MARK_PX, abi.encode(perp), 32), (uint64));
    }

    function oraclePx(uint32 perp) internal view returns (uint64) {
        return abi.decode(_read(HyperCorePrecompiles.ORACLE_PX, abi.encode(perp), 32), (uint64));
    }

    function accountMarginSummary(uint32 perpDex, address user)
        internal
        view
        returns (HyperCoreAccountMarginSummary memory s)
    {
        bytes memory out = _read(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY, abi.encode(perpDex, user), 4 * 32);
        (s.accountValue, s.marginUsed, s.ntlPos, s.rawUsd) = abi.decode(out, (int64, uint64, uint64, int64));
    }

    function perpAssetInfo(uint32 perp) internal view returns (HyperCorePerpAssetInfo memory info) {
        bytes memory out = _read(HyperCorePrecompiles.PERP_ASSET_INFO, abi.encode(perp), 0);
        if (out.length < 6 * 32) revert PrecompileReadFailed(HyperCorePrecompiles.PERP_ASSET_INFO);
        info = abi.decode(out, (HyperCorePerpAssetInfo));
    }

    function tokenInfo(uint32 token) internal view returns (HyperCoreTokenInfo memory info) {
        bytes memory out = _read(HyperCorePrecompiles.TOKEN_INFO, abi.encode(token), 0);
        if (out.length < 9 * 32) revert PrecompileReadFailed(HyperCorePrecompiles.TOKEN_INFO);
        info = abi.decode(out, (HyperCoreTokenInfo));
    }

    function coreUserExists(address user) internal view returns (bool) {
        return abi.decode(_read(HyperCorePrecompiles.CORE_USER_EXISTS, abi.encode(user), 32), (bool));
    }
}
