// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPyth} from "../interfaces/IPyth.sol";
import {IMorphoOracle} from "../interfaces/IMorphoBlue.sol";
import {IAerodromeCLPool} from "../interfaces/IAerodromeCLPool.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title PythOracleAdapter — Morpho `IOracle.price()` for a cbZEC/USDC market. v1.1: BUILT, UNUSED.
///
/// @notice Two hard rules, each failing closed:
///   1. MAX AGE. The Pyth price is read with `getPriceNoOlderThan(id, maxAge)`; a stale feed reverts.
///      `refresh(updateData)` is the permissionless way to make it fresh — post a Pyth update (fee
///      from msg.value, rest refunded) in the same transaction as a Morpho call, or let anyone post
///      one before. Nothing requires the refresh and the read to share a transaction.
///   2. PEG BREAKER. The Aerodrome cbZEC/USDC pool TWAP (quote per base, over `twapWindow`) is compared
///      with Pyth ZEC/USD; beyond `maxDeviationBps` the adapter reverts `PegBreak`, because a ZEC/USD
///      feed prices ZEC while the market holds cbZEC.
///   `price()` returns 1 base unit in quote units scaled by 1e36 (Morpho convention). Everything is
///   immutable; there is no admin. `peek()` is a diagnostic read with no gates for off-chain callers.
///
/// @dev The first version also carried a SAME-TRANSACTION flag: `price()` reverted unless `refresh`
///      had run earlier in the same transaction. It added nothing to safety — `price()` re-reads
///      `getPriceNoOlderThan(maxAge)` regardless, which already fails closed on a stale feed — and
///      it cost liveness everywhere: every `eth_call` of a venue view for an account with collateral
///      in such a market reverted, and a third-party liquidator calling `Morpho.liquidate` from an
///      EOA could never clear the market (audit wave 2, P-MED-1).
contract PythOracleAdapter is IMorphoOracle {
    IPyth public immutable PYTH;
    bytes32 public immutable PRICE_ID;
    IAerodromeCLPool public immutable POOL;
    address public immutable BASE_TOKEN;
    address public immutable QUOTE_TOKEN;
    uint8 public immutable BASE_DECIMALS;
    uint8 public immutable QUOTE_DECIMALS;
    bool public immutable BASE_IS_TOKEN0;
    uint256 public immutable maxAge;
    uint256 public immutable maxDeviationBps;
    uint32 public immutable twapWindow;

    uint256 private constant Q96 = 2 ** 96;
    uint256 private constant E8 = 1e8;
    uint256 private constant BPS = 10_000;

    event Refreshed(uint256 fee, uint256 pythPriceE8, uint256 publishTime);

    error ZeroAddress();
    error InvalidConfig();
    error PoolTokensMismatch(address token0, address token1);
    error NonPositivePrice(int64 price);
    error InsufficientFee(uint256 sent, uint256 required);
    error PegBreak(uint256 pythPriceE8, uint256 twapPriceE8, uint256 deviationBps);
    error RefundFailed();

    constructor(
        IPyth pyth,
        bytes32 priceId,
        IAerodromeCLPool pool,
        address baseToken,
        address quoteToken,
        uint256 maxAge_,
        uint256 maxDeviationBps_,
        uint32 twapWindow_
    ) {
        if (
            address(pyth) == address(0) || address(pool) == address(0) || baseToken == address(0)
                || quoteToken == address(0)
        ) revert ZeroAddress();
        if (priceId == bytes32(0) || maxAge_ == 0 || twapWindow_ == 0 || maxDeviationBps_ >= BPS) {
            revert InvalidConfig();
        }
        // Aderyn `reentrancy-state-change` on the four reads below (constructor: nothing can re-enter a
        // contract that has no code yet), triaged 2026-09-12 (AUDIT-2026-09-12.md).
        // aderyn-ignore-next-line(reentrancy-state-change)
        address t0 = pool.token0();
        // aderyn-ignore-next-line(reentrancy-state-change)
        address t1 = pool.token1();
        bool baseIs0 = t0 == baseToken && t1 == quoteToken;
        bool baseIs1 = t1 == baseToken && t0 == quoteToken;
        if (!baseIs0 && !baseIs1) revert PoolTokensMismatch(t0, t1);
        PYTH = pyth;
        PRICE_ID = priceId;
        POOL = pool;
        BASE_TOKEN = baseToken;
        QUOTE_TOKEN = quoteToken;
        // aderyn-ignore-next-line(reentrancy-state-change)
        BASE_DECIMALS = IERC20Metadata(baseToken).decimals();
        // aderyn-ignore-next-line(reentrancy-state-change)
        QUOTE_DECIMALS = IERC20Metadata(quoteToken).decimals();
        BASE_IS_TOKEN0 = baseIs0;
        maxAge = maxAge_;
        maxDeviationBps = maxDeviationBps_;
        twapWindow = twapWindow_;
    }

    /// @notice Post a Pyth update (paying its fee from msg.value, refunding the rest). Permissionless:
    ///         a borrower's bundle, a liquidator's bundle, or anyone at all may post it.
    /// @dev Invariant: on return the on-chain price for `PRICE_ID` is no older than `maxAge` (the
    ///      read below reverts otherwise, so a refresh that leaves the feed stale fails).
    ///      Aderyn `eth-send-unchecked-address` (it anchors on this function), triaged 2026-09-12
    ///      (AUDIT-2026-09-12.md): the refund goes to whoever paid the fee (msg.sender), by design;
    ///      there is no other recipient to check against.
    // aderyn-ignore-next-line(eth-send-unchecked-address)
    function refresh(bytes[] calldata updateData) external payable {
        uint256 fee = PYTH.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
        PYTH.updatePriceFeeds{value: fee}(updateData);
        (uint256 p, uint256 t) = _pythE8();
        emit Refreshed(fee, p, t);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @inheritdoc IMorphoOracle
    /// @dev Invariant: reverts unless Pyth is within maxAge, and unless the pool TWAP is within
    ///      maxDeviationBps of Pyth. Never returns a stale or de-pegged price. A plain view: any
    ///      `eth_call`, any Morpho `liquidate`, answers as long as someone kept the feed fresh.
    function price() external view override returns (uint256) {
        (uint256 pythE8,) = _pythE8();
        uint256 twapE8 = twapPriceE8();
        uint256 dev = _deviationBps(pythE8, twapE8);
        if (dev > maxDeviationBps) revert PegBreak(pythE8, twapE8, dev);
        // 1 base unit in quote units, scaled 1e36: pythE8 / 1e8 × 10^quote / 10^base × 1e36.
        return Math.mulDiv(pythE8, 1e36 * (10 ** QUOTE_DECIMALS), E8 * (10 ** BASE_DECIMALS));
    }

    /// @notice Diagnostic read without the max-age or peg gates: (Pyth price E8, publish time, TWAP
    ///         E8, deviation bps). Uses `getPriceUnsafe` — may be stale; never use for pricing.
    function peek()
        external
        view
        returns (uint256 pythPriceE8, uint256 publishTime, uint256 twapE8, uint256 deviationBps)
    {
        IPyth.Price memory p = PYTH.getPriceUnsafe(PRICE_ID);
        pythPriceE8 = p.price > 0 ? _toE8(p) : 0;
        publishTime = p.publishTime;
        twapE8 = twapPriceE8();
        deviationBps = pythPriceE8 == 0 ? BPS : _deviationBps(pythPriceE8, twapE8);
    }

    /// @notice Pool TWAP over `twapWindow`, as quote-per-base with 8 decimals.
    function twapPriceE8() public view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = POOL.observe(ago);
        int56 delta = cum[1] - cum[0];
        int56 window = int56(uint56(twapWindow));
        int24 avgTick = int24(delta / window);
        if (delta < 0 && delta % window != 0) avgTick--; // floor toward -inf like Uniswap
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(avgTick);
        uint256 unitsBase = E8 * (10 ** BASE_DECIMALS);
        uint256 raw; // quote raw per base raw, scaled by unitsBase
        if (BASE_IS_TOKEN0) {
            // token1 per token0 = sqrtP^2 / 2^192
            raw = Math.mulDiv(Math.mulDiv(unitsBase, sqrtP, Q96), sqrtP, Q96);
        } else {
            // token0 per token1 = 2^192 / sqrtP^2
            raw = Math.mulDiv(Math.mulDiv(unitsBase, Q96, sqrtP), Q96, sqrtP);
        }
        return raw / (10 ** QUOTE_DECIMALS);
    }

    // -------------------------------------------------------------- internal

    function _pythE8() internal view returns (uint256 priceE8, uint256 publishTime) {
        IPyth.Price memory p = PYTH.getPriceNoOlderThan(PRICE_ID, maxAge);
        if (p.price <= 0) revert NonPositivePrice(p.price);
        return (_toE8(p), p.publishTime);
    }

    function _toE8(IPyth.Price memory p) internal pure returns (uint256) {
        uint256 raw = uint256(uint64(p.price));
        int256 shift = int256(p.expo) + 8; // expo -8 → 0
        if (shift >= 0) return raw * (10 ** uint256(shift));
        return raw / (10 ** uint256(-shift));
    }

    function _deviationBps(uint256 ref, uint256 other) internal pure returns (uint256) {
        if (ref == 0) return BPS;
        uint256 diff = ref > other ? ref - other : other - ref;
        return Math.mulDiv(diff, BPS, ref);
    }
}
