// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainlinkOracleAdapter} from "../src/oracle/ChainlinkOracleAdapter.sol";
import {IChainlinkAggregator} from "../src/interfaces/IChainlinkAggregator.sol";
import {IAerodromeCLPool} from "../src/interfaces/IAerodromeCLPool.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockChainlinkFeed} from "./mocks/MockChainlinkFeed.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockB20} from "./mocks/MockB20.sol";

/// Founder's decision 2026-09-13: cbZEC is priced from Chainlink's Base `ZEC / USD` feed
/// exclusively, until a cbZEC/USD source exists. Pyth is not read by this adapter at all — its
/// on-chain ZEC price was 8.88 days stale when this was written. The peg breaker survives the
/// switch because the feed prices ZEC and the market holds cbZEC.
contract ChainlinkOracleAdapterTest is Test {
    MockChainlinkFeed feed; // 18 decimals, like the live Base ZEC/USD proxy
    MockCLPool pool;
    MockERC20 usdc;
    MockB20 cbzec;
    ChainlinkOracleAdapter oracle;

    int24 constant TICK = -23956; // ≈ 1,097.35 USDC per cbZEC, next to the live feed answer
    uint256 constant MAX_AGE = 6180; // the keeper's buildFeedPolicies rule over the measured max gap
    uint256 constant MAX_DEV_BPS = 300; // 3 %
    uint32 constant WINDOW = 1800;
    /// The live answer read on 2026-09-13 at block 51,260,504: $1,097.340468259499400000, 18 dp.
    int256 constant LIVE_18DP = 1_097_340_468_259_499_400_000;
    /// The same price with 8 decimals, which is what every OTHER Chainlink feed here reports.
    int256 constant LIVE_8DP = 109_734_046_825;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cbzec = new MockB20();
        feed = new MockChainlinkFeed(18, "ZEC / USD");
        pool = new MockCLPool(address(usdc), address(cbzec), 200, 2000, TickMath.getSqrtRatioAtTick(TICK));
        pool.setTwapTick(TICK);
        vm.warp(1_789_310_355); // the tip timestamp of the verifying read
        oracle = _deploy(feed);
        feed.setAnswer(LIVE_18DP, block.timestamp);
    }

    function _deploy(MockChainlinkFeed f) internal returns (ChainlinkOracleAdapter) {
        return new ChainlinkOracleAdapter(
            IChainlinkAggregator(address(f)),
            IAerodromeCLPool(address(pool)),
            address(cbzec),
            address(usdc),
            MAX_AGE,
            MAX_DEV_BPS,
            WINDOW
        );
    }

    // --------------------------------------------------------------- config

    function test_constructorReadsFeedDecimalsAndNeverAssumesEight() public view {
        assertEq(oracle.FEED_DECIMALS(), 18, "the live ZEC/USD feed reports 18, not 8");
        assertFalse(oracle.BASE_IS_TOKEN0(), "cbZEC is token1 on the live pool");
        assertEq(oracle.BASE_DECIMALS(), 8);
        assertEq(oracle.QUOTE_DECIMALS(), 6);
    }

    function test_constructorValidation() public {
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.PoolTokensMismatch.selector, address(usdc), address(cbzec))
        );
        new ChainlinkOracleAdapter(
            IChainlinkAggregator(address(feed)),
            IAerodromeCLPool(address(pool)),
            address(usdc),
            address(usdc),
            MAX_AGE,
            MAX_DEV_BPS,
            WINDOW
        );
        vm.expectRevert(ChainlinkOracleAdapter.ZeroAddress.selector);
        new ChainlinkOracleAdapter(
            IChainlinkAggregator(address(0)),
            IAerodromeCLPool(address(pool)),
            address(cbzec),
            address(usdc),
            MAX_AGE,
            MAX_DEV_BPS,
            WINDOW
        );
        vm.expectRevert(ChainlinkOracleAdapter.InvalidConfig.selector); // maxAge 0
        new ChainlinkOracleAdapter(
            IChainlinkAggregator(address(feed)),
            IAerodromeCLPool(address(pool)),
            address(cbzec),
            address(usdc),
            0,
            MAX_DEV_BPS,
            WINDOW
        );
        vm.expectRevert(ChainlinkOracleAdapter.InvalidConfig.selector); // deviation at/over 100 %
        new ChainlinkOracleAdapter(
            IChainlinkAggregator(address(feed)),
            IAerodromeCLPool(address(pool)),
            address(cbzec),
            address(usdc),
            MAX_AGE,
            10_000,
            WINDOW
        );
    }

    /// A feed whose decimals the E8 normalisation could not represent is refused at construction,
    /// rather than silently pricing at 0 or overflowing.
    function test_constructorRefusesUnusableFeedDecimals() public {
        MockChainlinkFeed zero = new MockChainlinkFeed(0, "ZEC / USD");
        vm.expectRevert(ChainlinkOracleAdapter.InvalidConfig.selector);
        _deploy(zero);
        MockChainlinkFeed huge = new MockChainlinkFeed(19, "ZEC / USD");
        vm.expectRevert(ChainlinkOracleAdapter.InvalidConfig.selector);
        _deploy(huge);
    }

    // ---------------------------------------------------------- the 10^10 hazard

    /// THE test this adapter exists for. An 18-decimal feed and an 8-decimal feed carrying the SAME
    /// dollar price must produce the SAME oracle price. Assuming 8 against the live 18-decimal feed
    /// is wrong by 10^10 — the Moonwell cbETH failure class (docs/research/CAPITAL-AND-VENUES).
    function test_eighteenAndEightDecimalFeedsAgreeOnTheSamePrice() public {
        MockChainlinkFeed eight = new MockChainlinkFeed(8, "ZEC / USD");
        ChainlinkOracleAdapter o8 = _deploy(eight);
        eight.setAnswer(LIVE_8DP, block.timestamp);
        assertEq(o8.FEED_DECIMALS(), 8);
        assertEq(oracle.price(), o8.price(), "18-dp and 8-dp feeds must price identically");
    }

    /// The scaling itself, pinned: price() is the E8 answer times 1e26 for an 8-dp base and 6-dp quote.
    function test_priceScalingIsPinnedToTheLiveAnswer() public view {
        assertEq(oracle.price(), uint256(LIVE_8DP) * 1e26);
    }

    // ------------------------------------------------------------- freshness

    function test_priceAnswersOnAFreshCompleteRound() public view {
        assertGt(oracle.price(), 0);
    }

    function test_staleRoundReverts() public {
        feed.setAnswer(LIVE_18DP, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkOracleAdapter.StalePrice.selector, block.timestamp - MAX_AGE - 1, block.timestamp, MAX_AGE
            )
        );
        oracle.price();
    }

    /// Exactly at maxAge is still good; one second past it is not.
    function test_maxAgeBoundaryIsInclusive() public {
        feed.setAnswer(LIVE_18DP, block.timestamp - MAX_AGE);
        assertGt(oracle.price(), 0);
    }

    function test_incompleteRoundReverts() public {
        feed.setRound(9, 8); // answeredInRound behind roundId: the classic carried-over answer
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracleAdapter.RoundNotComplete.selector, uint80(9), uint80(8)));
        oracle.price();
    }

    function test_zeroUpdatedAtReverts() public {
        feed.setAnswer(LIVE_18DP, 0);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracleAdapter.RoundNotComplete.selector, uint80(1), uint80(1)));
        oracle.price();
    }

    function test_futureTimestampReverts() public {
        feed.setAnswer(LIVE_18DP, block.timestamp + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.FutureTimestamp.selector, block.timestamp + 1, block.timestamp)
        );
        oracle.price();
    }

    function test_nonPositiveAnswerReverts() public {
        feed.setAnswer(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracleAdapter.NonPositivePrice.selector, int256(0)));
        oracle.price();
        feed.setAnswer(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracleAdapter.NonPositivePrice.selector, int256(-1)));
        oracle.price();
    }

    /// An aggregator that reverts outright fails closed, it does not price at 0.
    function test_feedDownFailsClosed() public {
        feed.setReverting(true);
        vm.expectRevert(MockChainlinkFeed.FeedDown.selector);
        oracle.price();
    }

    // ------------------------------------------------------------ peg breaker

    function test_twapReproducesThePoolPrice() public view {
        assertApproxEqRel(oracle.twapPriceE8(), uint256(LIVE_8DP), 0.001e18);
    }

    /// The reason the breaker survives the move to Chainlink: the feed prices ZEC, the market holds
    /// cbZEC, and this pool is the only on-chain read of what cbZEC itself trades at.
    function test_pegBreakWhenThePoolDivergesFromTheFeed() public {
        pool.setTwapTick(TICK + 2000); // cbZEC trades far below ZEC: a depeg
        uint256 twap = oracle.twapPriceE8();
        uint256 dev = ((uint256(LIVE_8DP) - twap) * 10_000) / uint256(LIVE_8DP);
        assertGt(dev, MAX_DEV_BPS, "the setup must actually break the band");
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracleAdapter.PegBreak.selector, uint256(LIVE_8DP), twap, dev)
        );
        oracle.price();
    }

    /// Spot can be pushed anywhere in a block; the breaker reads the window, so it is unmoved.
    function test_pegBreakUsesTwapNotSpot() public {
        pool.setSqrtPrice(TickMath.getSqrtRatioAtTick(TICK + 4000));
        assertGt(oracle.price(), 0, "spot moved, the TWAP did not, so the price still answers");
    }

    function test_poolUnreadableFailsClosed() public {
        pool.setMode(MockCLPool.Mode.Revert);
        vm.expectRevert();
        oracle.price();
    }

    // ------------------------------------------------------------------ peek

    function test_peekNeverGatesButNeverPrices() public {
        feed.setAnswer(LIVE_18DP, block.timestamp - MAX_AGE - 1_000_000); // hopelessly stale
        (uint256 px, uint256 upd, uint256 twap, uint256 dev) = oracle.peek();
        assertEq(px, uint256(LIVE_8DP), "peek reports the answer whatever its age");
        assertEq(upd, block.timestamp - MAX_AGE - 1_000_000);
        assertGt(twap, 0);
        assertLt(dev, MAX_DEV_BPS);
        vm.expectRevert(); // …while price() still refuses it
        oracle.price();
    }

    // ----------------------------------------------------------------- fuzz

    /// Whatever the feed says, either price() reverts or it equals the E8 answer scaled by 1e26 —
    /// the adapter never invents a number between those two outcomes.
    function testFuzz_priceIsEitherRefusedOrExactlyTheScaledAnswer(int256 answer, uint256 age) public {
        answer = int256(bound(answer, 1, 1e30));
        age = bound(age, 0, MAX_AGE);
        feed.setAnswer(answer, block.timestamp - age);
        uint256 e8 = uint256(answer) / 1e10;
        try oracle.price() returns (uint256 p) {
            assertEq(p, e8 * 1e26);
        } catch {
            // Refused by the peg breaker (or a zero E8 answer): both are fail-closed outcomes.
            assertTrue(true);
        }
    }
}
