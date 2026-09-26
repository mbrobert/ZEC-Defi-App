// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../../src/account/OilskinAccountFactory.sol";
import {HyperCorePerpAssetInfo, HyperCorePrecompiles} from "../../src/interfaces/IHyperCore.sol";
import {HyperCoreLib} from "../../src/libraries/HyperCoreLib.sol";
import {HyperliquidPerpVenue} from "../../src/venues/HyperliquidPerpVenue.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockCoreWriter, MockHyperCorePrecompile, MockUsdcAdapter} from "../mocks/MockHyperCore.sol";

contract RoundHarness {
    function round(uint64 px, uint8 szDec, bool up) external pure returns (uint64) {
        return HyperCoreLib.roundOrderPxE8(px, szDec, up);
    }
}

/// @notice AUDIT-2026-09-26 P-1 (High) and P-2 (Low). The venue shaded the precompile's mark by the band and sent
///         THAT as the limit price: 1538.9417 x 0.995 = 1531.24699150, ten significant figures, where Hyperliquid
///         accepts at most five and at most 6 - szDecimals decimals ("1234.5 is valid but 1234.56 is not" - the
///         tick-and-lot-size page, read 2026-09-26). HyperCore REJECTS such an order, and a rejected CoreWriter
///         order is silent: every open, every reduce and every keeper reduce would have moved nothing. Prices are
///         now rounded to the rule INSIDE the band (a sell's floor up, a buy's ceiling down). And the venue's
///         engine refuses an order under $10 ("Order must have minimum value of $10.", the exchange-endpoint page):
///         the venue now refuses one by name instead of sending it into silence.
contract PerpOrderPriceRegressionTest is Test {
    RoundHarness h;
    MockERC20 usdc;
    MockPermit2 permit2;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    MockCoreWriter coreWriter;
    MockUsdcAdapter adapter;
    HyperliquidPerpVenue venue;
    address alice = makeAddr("alice");

    uint32 constant ZEC = 214;
    uint8 constant SZ_DEC = 2;
    uint64 constant MARK = 15_389_417; // 1538.9417, the 2026-09-25 read
    uint64 constant SZ = 500;
    int64 constant A0 = 3_900_000_000;
    uint64 constant RESERVE0 = 348_979_462;

    function setUp() public {
        h = new RoundHarness();
        usdc = new MockERC20("USDC", "USDC", 6);
        permit2 = new MockPermit2();
        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(alice)));
        coreWriter = new MockCoreWriter();
        adapter = new MockUsdcAdapter(usdc);
        bytes memory code = type(MockHyperCorePrecompile).runtimeCode;
        vm.etch(HyperCorePrecompiles.POSITION, code);
        vm.etch(HyperCorePrecompiles.SPOT_BALANCE, code);
        vm.etch(HyperCorePrecompiles.MARK_PX, code);
        vm.etch(HyperCorePrecompiles.ORACLE_PX, code);
        vm.etch(HyperCorePrecompiles.PERP_ASSET_INFO, code);
        vm.etch(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY, code);
        HyperliquidPerpVenue.Config memory c;
        c.coreWriter = address(coreWriter);
        c.usdc = address(usdc);
        c.usdcAdapter = address(adapter);
        c.perpAsset = ZEC;
        c.szDecimals = SZ_DEC;
        c.maxLeverage = 10;
        c.usdcWeiDecimals = 8;
        c.usdcEvmDecimals = 6;
        c.baseDomain = 6;
        c.minEntryMarginBps = 5_000;
        c.maxNotionalE6 = 25_000e6;
        c.maxMarkOracleDeviationBps = 100;
        c.defaultReserveMultipleBps = 10_000;
        venue = new HyperliquidPerpVenue(c);
        HyperCorePerpAssetInfo memory info = HyperCorePerpAssetInfo({coin: "ZEC", marginTableId: 52, szDecimals: SZ_DEC, maxLeverage: 10, onlyIsolated: false});
        _pre(HyperCorePrecompiles.PERP_ASSET_INFO).script(abi.encode(ZEC), abi.encode(info));
        _pre(HyperCorePrecompiles.SPOT_BALANCE).script(abi.encode(address(acct), uint64(0)), abi.encode(RESERVE0 * 100 + 100e8, uint64(0), uint64(0)));
    }

    function _pre(address a) internal pure returns (MockHyperCorePrecompile) {
        return MockHyperCorePrecompile(a);
    }

    function _scene(uint64 mark, int64 szi, int64 a) internal {
        _pre(HyperCorePrecompiles.MARK_PX).script(abi.encode(ZEC), abi.encode(mark));
        _pre(HyperCorePrecompiles.ORACLE_PX).script(abi.encode(ZEC), abi.encode(mark));
        _pre(HyperCorePrecompiles.POSITION).script(abi.encode(address(acct), uint16(ZEC)), abi.encode(szi, uint64(0), int64(0), uint32(10), false));
        uint64 ntl = szi < 0 ? uint64(-szi) * mark : 0;
        _pre(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY).script(abi.encode(uint32(0), address(acct)), abi.encode(a, uint64(0), ntl, a));
    }

    function _owner(bytes memory data) internal returns (bytes memory) {
        vm.prank(alice);
        return acct.execWithCallback(address(venue), 0, data);
    }

    /// The rule, as a predicate: a valid price is unchanged by rounding down.
    function _valid(uint64 px, uint8 szDec) internal view returns (bool) {
        return h.round(px, szDec, false) == px;
    }

    /// The price word of an encoded action 1: the third ABI word after the 4-byte prefix.
    function _pxOf(bytes memory action) internal pure returns (uint64 px) {
        assembly ("memory-safe") {
            px := mload(add(action, add(32, add(4, 64))))
        }
    }

    // ---------------------------------------------------------- the rule, from the venue's own page

    function test_rule_theDocumentationsOwnExamples() public view {
        // "1234.5 is valid but 1234.56 is not (too many significant figures)"
        assertTrue(_valid(123_450_000_000, SZ_DEC));
        assertFalse(_valid(123_456_000_000, SZ_DEC));
        assertEq(h.round(123_456_000_000, SZ_DEC, false), 123_450_000_000);
        assertEq(h.round(123_456_000_000, SZ_DEC, true), 123_460_000_000);
        // "0.001234 is valid, but 0.0012345 is not (more than 6 decimal places)" - a szDecimals-0 market
        assertTrue(_valid(123_400, 0));
        assertFalse(_valid(123_450, 0));
        assertEq(h.round(123_450, 0, false), 123_400);
        assertEq(h.round(123_450, 0, true), 123_500);
        // "If szDecimals = 1, 0.01234 is valid but 0.012345 is not (more than 6 - szDecimals decimal places)"
        assertTrue(_valid(1_234_000, 1));
        assertFalse(_valid(1_234_500, 1));
        assertEq(h.round(1_234_500, 1, true), 1_235_000);
        // "123456 is a valid price even though 12345.6 is not" - integers are always allowed
        assertTrue(_valid(123_456 * 1e8, SZ_DEC));
        assertFalse(_valid(1_234_560_000_000, SZ_DEC));
        assertEq(h.round(1_234_560_000_000, SZ_DEC, false), 12_345 * 1e8);
        assertEq(h.round(1_234_560_000_000, SZ_DEC, true), 12_346 * 1e8);
        // the mark itself, as the precompile gives it, is NOT a valid order price
        assertFalse(_valid(uint64(MARK) * 1e4, SZ_DEC), "1538.9417 has eight significant figures");
        assertEq(h.round(0, SZ_DEC, true), 0);
    }

    function test_defect_thePricesTheVenueSentBeforeTheFixWereAllInvalid() public view {
        // the four prices the D2 suite pinned on 2026-09-25: the open's sell, the reduce's buy, the two protect buys
        assertFalse(_valid(153_124_699_150, SZ_DEC), "open: 1531.24699150");
        assertFalse(_valid(154_663_640_850, SZ_DEC), "reduce: 1546.63640850");
        assertFalse(_valid(185_596_365_000, SZ_DEC), "protect derisk: 1855.96365");
        assertFalse(_valid(216_529_099_200, SZ_DEC), "protect close: 2165.290992");
        // and what they are now: inside the band, five figures
        assertEq(h.round(153_124_699_150, SZ_DEC, true), 153_130_000_000, "a sell's floor rounds UP");
        assertEq(h.round(154_663_640_850, SZ_DEC, false), 154_660_000_000, "a buy's ceiling rounds DOWN");
        assertEq(h.round(185_596_365_000, SZ_DEC, false), 185_590_000_000);
        assertEq(h.round(216_529_099_200, SZ_DEC, false), 216_520_000_000);
    }

    function testFuzz_rule_roundedPricesAreValidWithinOneQuantumAndInTheAskedDirection(uint64 px, uint8 szDec) public view {
        px = uint64(bound(px, 1, 1e17));
        szDec = uint8(bound(szDec, 0, 6));
        uint64 down = h.round(px, szDec, false);
        uint64 up = h.round(px, szDec, true);
        assertTrue(down <= px && px <= up, "the price sits between the two roundings");
        assertTrue(_valid(down, szDec) && _valid(up, szDec), "both roundings are valid prices");
        if (down != up) {
            uint256 q = up - down;
            assertTrue(q == 10 ** _exp(px, szDec), "one quantum apart");
        }
        // idempotent
        assertEq(h.round(down, szDec, false), down);
        assertEq(h.round(up, szDec, true), up);
    }

    function _exp(uint64 px, uint8 szDec) internal pure returns (uint256 exp) {
        uint256 digits;
        for (uint256 v = px; v != 0; v /= 10) digits++;
        exp = 2 + szDec;
        if (digits > 5 && digits - 5 > exp) exp = digits - 5;
        if (exp > 8) exp = 8;
    }

    // ---------------------------------------------------------- the venue, end to end

    function test_venue_everyOrderItSendsCarriesAValidPriceInsideTheBand() public {
        usdc.mint(address(acct), 10_000e6);
        _scene(MARK, 0, A0);
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: SZ, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)}))));
        uint64 sellPx = _pxOf(coreWriter.actions(0));
        uint256 sellEdge = (uint256(MARK) * 1e4 * 9_950) / 10_000; // the band's floor, unrounded
        assertTrue(_valid(sellPx, SZ_DEC), "the open's sell price is one HyperCore accepts");
        assertTrue(sellPx >= sellEdge && sellPx - sellEdge < 1e7, "rounded UP, inside the band, within one quantum (0.1)");
        assertEq(sellPx, 153_130_000_000);
        // a reduce: the buy's ceiling rounded DOWN
        _scene(MARK, -int64(SZ), A0);
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (100, 50, uint40(block.timestamp + 600))));
        uint64 buyPx = _pxOf(coreWriter.actions(1));
        uint256 buyEdge = (uint256(MARK) * 1e4 * 10_050) / 10_000;
        assertTrue(_valid(buyPx, SZ_DEC));
        assertTrue(buyPx <= buyEdge && buyEdge - buyPx < 1e7, "rounded DOWN, inside the band");
        assertEq(buyPx, 154_660_000_000);
        // a band narrower than one quantum: the rounding cannot stay inside it and the sell's floor lands above the mark
        _scene(MARK, 0, A0);
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: SZ, maxSlippageBps: 0, deadline: uint40(block.timestamp + 600)}))));
        uint64 tight = _pxOf(coreWriter.actions(2));
        assertTrue(_valid(tight, SZ_DEC));
        assertTrue(tight > uint64(MARK) * 1e4, "a zero band rounds the sell's floor above the mark: a price no bid meets");
    }

    function test_venue_refusesAnOrderUnderTheTenDollarMinimumByName() public {
        usdc.mint(address(acct), 10_000e6);
        // 0.01 ZEC at $800.0000 is $8: under the venue's minimum
        _scene(8_000_000, 0, A0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.OrderBelowMinimum.selector, 8_000_000, 10_000_000));
        acct.execWithCallback(address(venue), 0, abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: 1, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)}))));
        // 0.02 ZEC is $16: accepted
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: 2, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)}))));
        assertEq(coreWriter.count(), 1);
        // a reduce of 0.01 ZEC on an open 5.00 ZEC short at that mark is $8 too; 0.02 is fine (protect shares the check)
        _scene(8_000_000, -int64(SZ), A0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.OrderBelowMinimum.selector, 8_000_000, 10_000_000));
        acct.execWithCallback(address(venue), 0, abi.encodeCall(HyperliquidPerpVenue.reduce, (1, 50, uint40(block.timestamp + 600))));
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (2, 50, uint40(block.timestamp + 600))));
        assertEq(coreWriter.count(), 2);
    }
}
