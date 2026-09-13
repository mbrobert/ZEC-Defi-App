// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";
import {IMorphoOracle} from "../interfaces/IMorphoBlue.sol";
import {IAerodromeCLPool} from "../interfaces/IAerodromeCLPool.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// @title ChainlinkOracleAdapter — Morpho `IOracle.price()` for a cbZEC/USDC market, priced from
///        Chainlink. v1.1: BUILT, UNUSED (cbZEC stays registered-disabled; no market is created, D3).
///
/// @notice Replaces `PythOracleAdapter` as the intended cbZEC oracle (founder's decision 2026-09-13:
///         "use chainlink zec/usd exclusively until a cbZEC/USD source is available"). Chainlink's
///         Base `ZEC / USD` proxy is the ONLY price source here; Pyth is not read at all. Pyth's
///         on-chain ZEC price was 8.88 days stale when this was written, because nobody pushes it.
///
/// Two hard rules, each failing closed:
///   1. FRESH AND COMPLETE. `latestRoundData()` must carry a positive answer from a completed round
///      (`answeredInRound >= roundId`, `updatedAt != 0`), not stamped in the future, and no older
///      than `maxAge`. A push feed goes stale only if the reporting network stalls, but when it does
///      this reverts rather than quoting a frozen price.
///   2. PEG BREAKER. The feed prices **ZEC**; this market holds **cbZEC**. The Aerodrome cbZEC/USDC
///      pool TWAP over `twapWindow` is compared against it and beyond `maxDeviationBps` the adapter
///      reverts `PegBreak`. This is the only on-chain read of what cbZEC itself trades at, so it is
///      not optional: without it a depegged wrapper would be valued at ZEC par. It also stands in for
///      the aggregator's own circuit breaker, which is absent — the verified feed's `minAnswer` is 1
///      and its `maxAnswer` is effectively unbounded (Addendum 16).
///
/// `price()` returns 1 base unit in quote units scaled by 1e36 (Morpho convention). Everything is
/// immutable; there is no admin. `peek()` is an ungated diagnostic for off-chain callers.
///
/// @dev There is no `refresh()` and no fee path: Chainlink is push-based, so nothing has to be posted
///      before a read. That removes the Pyth adapter's whole update-and-refund surface.
///      FEED_DECIMALS is read from the feed in the constructor, never assumed — the Base ZEC/USD feed
///      reports 18 while every other Chainlink feed this repo uses reports 8 (Addendum 16).
contract ChainlinkOracleAdapter is IMorphoOracle {
    IChainlinkAggregator public immutable FEED;
    uint8 public immutable FEED_DECIMALS;
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

    error ZeroAddress();
    error InvalidConfig();
    error PoolTokensMismatch(address token0, address token1);
    error NonPositivePrice(int256 answer);
    error RoundNotComplete(uint80 roundId, uint80 answeredInRound);
    error StalePrice(uint256 updatedAt, uint256 nowS, uint256 maxAgeS);
    error FutureTimestamp(uint256 updatedAt, uint256 nowS);
    error PegBreak(uint256 feedPriceE8, uint256 twapPriceE8, uint256 deviationBps);

    constructor(
        IChainlinkAggregator feed,
        IAerodromeCLPool pool,
        address baseToken,
        address quoteToken,
        uint256 maxAge_,
        uint256 maxDeviationBps_,
        uint32 twapWindow_
    ) {
        if (
            address(feed) == address(0) || address(pool) == address(0) || baseToken == address(0)
                || quoteToken == address(0)
        ) revert ZeroAddress();
        if (maxAge_ == 0 || twapWindow_ == 0 || maxDeviationBps_ >= BPS) revert InvalidConfig();
        // Aderyn `reentrancy-state-change` on the constructor reads below: nothing can re-enter a
        // contract that has no code yet (AUDIT-2026-09-12.md).
        // aderyn-ignore-next-line(reentrancy-state-change)
        address t0 = pool.token0();
        // aderyn-ignore-next-line(reentrancy-state-change)
        address t1 = pool.token1();
        bool baseIs0 = t0 == baseToken && t1 == quoteToken;
        bool baseIs1 = t1 == baseToken && t0 == quoteToken;
        if (!baseIs0 && !baseIs1) revert PoolTokensMismatch(t0, t1);
        // aderyn-ignore-next-line(reentrancy-state-change)
        uint8 feedDecimals = feed.decimals();
        // Read, never assumed. Above 18 the E8 normalisation below would divide away the whole answer.
        if (feedDecimals == 0 || feedDecimals > 18) revert InvalidConfig();
        FEED = feed;
        FEED_DECIMALS = feedDecimals;
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

    /// @inheritdoc IMorphoOracle
    /// @dev Invariant: reverts unless the feed's latest round is complete, positive, not future-dated
    ///      and within `maxAge`, AND the pool TWAP is within `maxDeviationBps` of it. Never returns a
    ///      stale or de-pegged price. A plain view: any `eth_call`, any Morpho `liquidate`, answers.
    function price() external view override returns (uint256) {
        (uint256 feedE8,) = _feedE8();
        uint256 twapE8 = twapPriceE8();
        uint256 dev = _deviationBps(feedE8, twapE8);
        if (dev > maxDeviationBps) revert PegBreak(feedE8, twapE8, dev);
        // 1 base unit in quote units, scaled 1e36: feedE8 / 1e8 × 10^quote / 10^base × 1e36.
        return Math.mulDiv(feedE8, 1e36 * (10 ** QUOTE_DECIMALS), E8 * (10 ** BASE_DECIMALS));
    }

    /// @notice Diagnostic read with no freshness or peg gate: (feed price E8, updatedAt, TWAP E8,
    ///         deviation bps). May be stale or de-pegged; never use it for pricing.
    function peek()
        external
        view
        returns (uint256 feedPriceE8, uint256 updatedAt, uint256 twapE8, uint256 deviationBps)
    {
        (, int256 answer,, uint256 upd,) = FEED.latestRoundData();
        feedPriceE8 = answer > 0 ? _toE8(uint256(answer)) : 0;
        updatedAt = upd;
        twapE8 = twapPriceE8();
        deviationBps = feedPriceE8 == 0 ? BPS : _deviationBps(feedPriceE8, twapE8);
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
            raw = Math.mulDiv(Math.mulDiv(unitsBase, sqrtP, Q96), sqrtP, Q96);
        } else {
            raw = Math.mulDiv(Math.mulDiv(unitsBase, Q96, sqrtP), Q96, sqrtP);
        }
        return raw / (10 ** QUOTE_DECIMALS);
    }

    // -------------------------------------------------------------- internal

    function _feedE8() internal view returns (uint256 priceE8, uint256 updatedAt) {
        (uint80 roundId, int256 answer,, uint256 upd, uint80 answeredInRound) = FEED.latestRoundData();
        if (answer <= 0) revert NonPositivePrice(answer);
        if (upd == 0 || answeredInRound < roundId) revert RoundNotComplete(roundId, answeredInRound);
        if (upd > block.timestamp) revert FutureTimestamp(upd, block.timestamp);
        if (block.timestamp - upd > maxAge) revert StalePrice(upd, block.timestamp, maxAge);
        return (_toE8(uint256(answer)), upd);
    }

    /// @dev Feed answer in its own decimals → 8 decimals. FEED_DECIMALS is bounded to [1, 18] in the
    ///      constructor, so neither branch can shift by more than 10 places.
    function _toE8(uint256 raw) internal view returns (uint256) {
        if (FEED_DECIMALS >= 8) return raw / (10 ** uint256(FEED_DECIMALS - 8));
        return raw * (10 ** uint256(8 - FEED_DECIMALS));
    }

    function _deviationBps(uint256 ref, uint256 other) internal pure returns (uint256) {
        if (ref == 0) return BPS;
        uint256 diff = ref > other ? ref - other : other - ref;
        return Math.mulDiv(diff, BPS, ref);
    }
}
