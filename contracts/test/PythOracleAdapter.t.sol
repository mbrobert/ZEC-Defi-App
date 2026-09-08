// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PythOracleAdapter} from "../src/oracle/PythOracleAdapter.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {IAerodromeCLPool} from "../src/interfaces/IAerodromeCLPool.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockB20} from "./mocks/MockB20.sol";

contract TickMathTest is Test {
    function test_canonicalValues() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(0), 2 ** 96);
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_RATIO);
    }

    /// FACT 5: WETH/USDC pool tick −198319 ≈ 2,441 USDC per WETH; VERIFIED-BASE-FACTS: cbZEC/USDC
    /// tick −23228 ≈ 1,020 USDC per cbZEC (token0 USDC, token1 cbZEC).
    function test_livePoolTicksReproduceVerifiedPrices() public pure {
        uint256 sqrtW = TickMath.getSqrtRatioAtTick(-198319);
        // token1 (USDC, 6) per token0 (WETH, 18), whole units: (sqrt/2^96)^2 × 1e18 / 1e6
        uint256 usdcPerWeth = ((((sqrtW * sqrtW) >> 96) * 1e18) / 1e6) >> 96;
        assertApproxEqRel(usdcPerWeth, 2441, 0.002e18);

        uint256 sqrtZ = TickMath.getSqrtRatioAtTick(-23228);
        // token1 (cbZEC, 8) per token0 (USDC, 6) raw, Q96 → invert, whole units: 1e2 / raw
        uint256 raw1per0X96 = (sqrtZ * sqrtZ) >> 96;
        uint256 usdcPerCbzec = (100 * (2 ** 96)) / raw1per0X96;
        assertApproxEqRel(usdcPerCbzec, 1020, 0.005e18);
    }

    function test_outOfRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TickMath.TickOutOfRange.selector, TickMath.MAX_TICK + 1));
        this.callGet(TickMath.MAX_TICK + 1);
    }

    function callGet(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }
}

/// @dev The production shape: one top-level call that posts the update and reads the price — a
///      borrower's or liquidator's bundle. Green under Foundry's default isolation (each top-level
///      test call is its own transaction) because nothing in the adapter depends on sharing one.
contract PythBundle {
    function refreshAndPrice(PythOracleAdapter adapter, bytes[] calldata data) external payable returns (uint256) {
        adapter.refresh{value: msg.value}(data);
        return adapter.price();
    }

    receive() external payable {}
}

contract PythOracleAdapterTest is Test {
    MockPyth pyth;
    MockCLPool pool;
    MockERC20 usdc;
    MockB20 cbzec;
    PythOracleAdapter oracle;

    bytes32 constant ZEC_USD = 0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24;
    int24 constant TICK = -23228; // ≈ 1,020 USDC per cbZEC
    uint256 constant MAX_AGE = 60;
    uint256 constant MAX_DEV_BPS = 300; // 3 %
    uint32 constant WINDOW = 1800;
    int64 constant PYTH_1035_20 = 103_520_000_000; // $1,035.20, expo −8 (the live read)

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        cbzec = new MockB20();
        pyth = new MockPyth();
        pool = new MockCLPool(address(usdc), address(cbzec), 200, 2000, TickMath.getSqrtRatioAtTick(TICK));
        pool.setTwapTick(TICK);
        vm.warp(1_760_000_000);
        oracle = new PythOracleAdapter(
            IPyth(address(pyth)),
            ZEC_USD,
            IAerodromeCLPool(address(pool)),
            address(cbzec),
            address(usdc),
            MAX_AGE,
            MAX_DEV_BPS,
            WINDOW
        );
        vm.deal(address(this), 1 ether);
    }

    function _update(int64 price, uint256 publishTime) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.encodeUpdate(ZEC_USD, price, 16_000_000, -8, publishTime);
    }

    // ------------------------------------------------------------- config

    function test_constructorValidation() public {
        assertFalse(oracle.BASE_IS_TOKEN0(), "cbZEC is token1 on the live pool");
        assertEq(oracle.BASE_DECIMALS(), 8);
        assertEq(oracle.QUOTE_DECIMALS(), 6);
        vm.expectRevert(
            abi.encodeWithSelector(PythOracleAdapter.PoolTokensMismatch.selector, address(usdc), address(cbzec))
        );
        new PythOracleAdapter(
            IPyth(address(pyth)), ZEC_USD, IAerodromeCLPool(address(pool)), address(usdc), address(usdc), 60, 300, 60
        );
        vm.expectRevert(PythOracleAdapter.InvalidConfig.selector);
        new PythOracleAdapter(
            IPyth(address(pyth)), ZEC_USD, IAerodromeCLPool(address(pool)), address(cbzec), address(usdc), 0, 300, 60
        );
        vm.expectRevert(PythOracleAdapter.InvalidConfig.selector);
        new PythOracleAdapter(
            IPyth(address(pyth)), ZEC_USD, IAerodromeCLPool(address(pool)), address(cbzec), address(usdc), 60, 10_000, 60
        );
        vm.expectRevert(PythOracleAdapter.ZeroAddress.selector);
        new PythOracleAdapter(
            IPyth(address(0)), ZEC_USD, IAerodromeCLPool(address(pool)), address(cbzec), address(usdc), 60, 300, 60
        );
    }

    // ---------------------------------------------------------- freshness (audit wave 2, P-MED-1)

    /// A fresh on-chain price answers without any refresh in this transaction: a third-party
    /// liquidator, a venue view, an `eth_call` — none of them needs to bundle anything.
    function test_priceAnswersWhenTheOnChainPriceIsFreshWithoutARefresh() public {
        pyth.setPrice(ZEC_USD, PYTH_1035_20, 16_000_000, -8, block.timestamp);
        assertEq(oracle.price(), 1035_20 * 1e32);
    }

    /// …and a stale on-chain price is refused by Pyth's own `StalePrice` — the max-age rule carries
    /// the safety the old same-transaction flag only duplicated.
    function test_priceRevertsWhenTheOnChainPriceIsStale() public {
        pyth.setPrice(ZEC_USD, PYTH_1035_20, 16_000_000, -8, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(MockPyth.StalePrice.selector);
        oracle.price();
    }

    function test_refreshThenPriceInSameTx() public {
        // On-chain price is 5.5 h stale (the live situation); a fresh update is pulled in-tx.
        pyth.setPrice(ZEC_USD, PYTH_1035_20, 16_000_000, -8, block.timestamp - 19_779);
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp - 5);
        uint256 fee = pyth.getUpdateFee(data);
        uint256 balBefore = address(this).balance;
        oracle.refresh{value: fee + 1000}(data);
        assertEq(address(this).balance, balBefore - fee, "excess refunded");
        uint256 p = oracle.price();
        // 1 cbZEC (1e8 raw) in USDC raw (1e6) scaled 1e36: 1035.20 x 1e6 / 1e8 x 1e36
        assertEq(p, uint256(uint64(PYTH_1035_20)) * 1e36 * 1e6 / (1e8 * 1e8));
        assertEq(p, 1035_20 * 1e32);
    }

    /// The production bundle: refresh + read inside ONE top-level call, from a contract that is
    /// not the test itself. Green whether or not Foundry isolates top-level calls.
    function test_refreshAndPriceInOneTopLevelCall() public {
        pyth.setPrice(ZEC_USD, PYTH_1035_20, 16_000_000, -8, block.timestamp - 19_779);
        PythBundle bundle = new PythBundle();
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp - 5);
        uint256 fee = pyth.getUpdateFee(data);
        uint256 p = bundle.refreshAndPrice{value: fee}(oracle, data);
        assertEq(p, 1035_20 * 1e32);
        // A separate top-level read afterwards still answers: the update stayed on chain.
        assertEq(oracle.price(), 1035_20 * 1e32);
    }

    function test_refreshRejectsStaleUpdateAndInsufficientFee() public {
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp - MAX_AGE - 1);
        uint256 fee = pyth.getUpdateFee(data);
        vm.expectRevert(MockPyth.StalePrice.selector);
        oracle.refresh{value: fee}(data);
        data = _update(PYTH_1035_20, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(PythOracleAdapter.InsufficientFee.selector, 0, fee));
        oracle.refresh{value: 0}(data);
        // exactly maxAge old is still accepted; one second more is not
        data = _update(PYTH_1035_20, block.timestamp - MAX_AGE);
        oracle.refresh{value: fee}(data);
        oracle.price();
    }

    function test_priceRevertsOnceTheRefreshedPriceAgesPastMaxAge() public {
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp);
        oracle.refresh{value: pyth.getUpdateFee(data)}(data);
        oracle.price();
        vm.warp(block.timestamp + MAX_AGE + 1); // max age is re-checked on every read
        vm.expectRevert(MockPyth.StalePrice.selector);
        oracle.price();
    }

    // ---------------------------------------------------------- peg breaker

    function test_twapReproducesThePoolPrice() public view {
        assertApproxEqRel(oracle.twapPriceE8(), 1_020e8, 0.005e18);
    }

    function test_pegBreakWhenPoolDivergesFromPyth() public {
        // Pool says ~1,020; Pyth says 1,035.20 → 1.5 % (within 3 %). Move the pool 5 % lower.
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp);
        oracle.refresh{value: pyth.getUpdateFee(data)}(data);
        oracle.price(); // fine at 1.5 %
        pool.setTwapTick(TICK - 500); // lower tick = fewer cbZEC per USDC = cbZEC ≈ +5 %
        uint256 twap = oracle.twapPriceE8();
        uint256 pythE8 = uint256(uint64(PYTH_1035_20));
        uint256 diff = twap > pythE8 ? twap - pythE8 : pythE8 - twap;
        uint256 dev = (diff * 10_000) / pythE8;
        assertGt(dev, MAX_DEV_BPS);
        vm.expectRevert(abi.encodeWithSelector(PythOracleAdapter.PegBreak.selector, pythE8, twap, dev));
        oracle.price();
        // Pyth moving up while the pool holds is also a break (cbZEC below ZEC).
        pool.setTwapTick(TICK);
        data = _update(PYTH_1035_20 * 110 / 100, block.timestamp);
        oracle.refresh{value: pyth.getUpdateFee(data)}(data);
        vm.expectRevert();
        oracle.price();
    }

    function test_pegBreakUsesTwapNotSpot() public {
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp);
        oracle.refresh{value: pyth.getUpdateFee(data)}(data);
        pool.setSqrtPrice(TickMath.getSqrtRatioAtTick(TICK - 3000)); // spot manipulated −26 %
        oracle.price(); // TWAP unchanged → still priced
        pool.setTwapTick(TICK - 3000);
        vm.expectRevert();
        oracle.price();
    }

    function test_poolUnreadableFailsClosed() public {
        bytes[] memory data = _update(PYTH_1035_20, block.timestamp);
        oracle.refresh{value: pyth.getUpdateFee(data)}(data);
        pool.setMode(MockCLPool.Mode.Revert);
        vm.expectRevert("observe unavailable");
        oracle.price();
    }

    function test_nonPositivePriceReverts() public {
        bytes[] memory data = _update(0, block.timestamp);
        uint256 fee = pyth.getUpdateFee(data);
        vm.expectRevert(abi.encodeWithSelector(PythOracleAdapter.NonPositivePrice.selector, int64(0)));
        oracle.refresh{value: fee}(data);
    }

    function test_peekNeverGatesButNeverPrices() public {
        pyth.setPrice(ZEC_USD, PYTH_1035_20, 16_000_000, -8, block.timestamp - 19_779);
        (uint256 p, uint256 t, uint256 twap, uint256 dev) = oracle.peek();
        assertEq(p, uint256(uint64(PYTH_1035_20)));
        assertEq(t, block.timestamp - 19_779);
        assertApproxEqRel(twap, 1_020e8, 0.005e18);
        assertLt(dev, 200);
        // peek() shows the stale price; price() refuses it by max age.
        vm.expectRevert(MockPyth.StalePrice.selector);
        oracle.price();
    }

    function testFuzz_priceScalingMonotonic(int64 a, int64 b) public {
        a = int64(bound(int256(a), 1e8, 1e14));
        b = int64(bound(int256(b), 1e8, 1e14));
        // Keep the pool near each price so the breaker does not fire: compare pure scaling via peek.
        pyth.setPrice(ZEC_USD, a, 0, -8, block.timestamp);
        (uint256 pa,,,) = oracle.peek();
        pyth.setPrice(ZEC_USD, b, 0, -8, block.timestamp);
        (uint256 pb,,,) = oracle.peek();
        if (a < b) assertLt(pa, pb);
        else if (a > b) assertGt(pa, pb);
        else assertEq(pa, pb);
    }

    receive() external payable {}
}
