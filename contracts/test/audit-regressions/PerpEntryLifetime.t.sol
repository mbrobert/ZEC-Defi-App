// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../../src/account/OilskinAccountFactory.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {HyperCorePerpAssetInfo, HyperCorePrecompiles} from "../../src/interfaces/IHyperCore.sol";
import {HyperCoreLib} from "../../src/libraries/HyperCoreLib.sol";
import {PerpHealthLib} from "../../src/libraries/PerpHealthLib.sol";
import {HyperliquidPerpVenue} from "../../src/venues/HyperliquidPerpVenue.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockCoreWriter, MockHyperCorePrecompile, MockUsdcAdapter} from "../mocks/MockHyperCore.sol";

/// @dev The scripted HyperCore every perps regression runs on: the precompiles are `vm.etch`ed doubles whose answers
///      the test sets, and `MockCoreWriter` only logs the actions sent. An order "fills" when the test scripts the
///      position that would follow it, and does not fill when the test leaves the position as it was.
abstract contract PerpVenueRig is Test {
    MockERC20 usdc;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    MockCoreWriter coreWriter;
    MockUsdcAdapter adapter;
    HyperliquidPerpVenue venue;
    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");

    uint32 constant ZEC = 214;
    uint8 constant SZ_DEC = 2;
    uint8 constant MAX_LEV = 10;
    uint256 constant MMR = 500;

    function setUp() public virtual {
        usdc = new MockERC20("USDC", "USDC", 6);
        factory = new OilskinAccountFactory(address(new MockPermit2()));
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
        c.maxLeverage = MAX_LEV;
        c.usdcWeiDecimals = 8;
        c.usdcEvmDecimals = 6;
        c.baseDomain = 6;
        c.minEntryMarginBps = 5_000;
        c.maxNotionalE6 = 25_000e6;
        c.maxMarkOracleDeviationBps = 100;
        c.defaultReserveMultipleBps = 10_000;
        venue = new HyperliquidPerpVenue(c);
        HyperCorePerpAssetInfo memory info = HyperCorePerpAssetInfo({coin: "ZEC", marginTableId: 52, szDecimals: SZ_DEC, maxLeverage: MAX_LEV, onlyIsolated: false});
        _pre(HyperCorePrecompiles.PERP_ASSET_INFO).script(abi.encode(ZEC), abi.encode(info));
        _spot(50_000e6);
    }

    function _pre(address a) internal pure returns (MockHyperCorePrecompile) {
        return MockHyperCorePrecompile(a);
    }

    /// HyperCore as the venue reads it: a short of `-szi` (0 = none) at `mark`, `a` of account value, the summary agreeing.
    function _scene(uint64 mark, int64 szi, int64 a) internal {
        _pre(HyperCorePrecompiles.MARK_PX).script(abi.encode(ZEC), abi.encode(mark));
        _pre(HyperCorePrecompiles.ORACLE_PX).script(abi.encode(ZEC), abi.encode(mark));
        _pre(HyperCorePrecompiles.POSITION).script(abi.encode(address(acct), uint16(ZEC)), abi.encode(szi, uint64(0), int64(0), uint32(MAX_LEV), false));
        uint64 ntl = szi < 0 ? uint64(-szi) * mark : 0;
        _pre(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY).script(abi.encode(uint32(0), address(acct)), abi.encode(a, uint64(0), ntl, a));
    }

    function _spot(uint256 e6) internal {
        _pre(HyperCorePrecompiles.SPOT_BALANCE).script(abi.encode(address(acct), uint64(0)), abi.encode(uint64(e6 * 100), uint64(0), uint64(0)));
    }

    function _owner(bytes memory data) internal returns (bytes memory) {
        vm.prank(alice);
        return acct.execWithCallback(address(venue), 0, data);
    }

    function _open(uint64 sz) internal returns (uint32 d, uint32 hf) {
        bytes memory ret = _owner(abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: sz, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)}))));
        return abi.decode(ret, (uint32, uint32));
    }

    function _reduce(uint64 sz) internal {
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (sz, 50, uint40(block.timestamp + 600))));
    }

    function _grantKeeper(uint8 rungs, uint64 topUp, uint64 reduceSz) internal {
        vm.prank(alice);
        acct.grant(
            keeper,
            Permission({target: address(venue), selector: HyperliquidPerpVenue.protect.selector, maxValuePerPeriod: 0, tokenLimits: new TokenLimit[](0), period: 1 days, expiry: uint40(block.timestamp + 30 days), allowCallback: true})
        );
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 30 days), 1 days, rungs, topUp, reduceSz, 50)));
    }

    function _protect(uint8 rung, uint64 topUp, uint64 reduceSz) internal {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(venue), value: 0, data: abi.encodeCall(HyperliquidPerpVenue.protect, (rung, topUp, reduceSz)), callback: false});
        vm.prank(keeper);
        acct.execAsKeeper(calls);
    }

    function _protectCall(uint8 rung, uint64 topUp, uint64 reduceSz) internal view returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: address(venue), value: 0, data: abi.encodeCall(HyperliquidPerpVenue.protect, (rung, topUp, reduceSz)), callback: false});
    }

    function _entry() internal view returns (HyperliquidPerpVenue.Entry memory e) {
        (e.distanceBps, e.hfBps, e.sz, e.reserveE6, e.at) = venue.entryOf(address(acct));
    }
}

/// @notice AUDIT PV-1 (Medium). A full `reduce` deleted the entry record in the same transaction that merely SENT the
///         reduce-only IOC buy to CoreWriter. HyperCore acts seconds later and the order may fill partly or not at all:
///         the short stayed open with no record, every keeper `protect` reverted `NoEntry` (which the keeper classes
///         as a permanent refusal) and the short silently lost its protection. The record now outlives the intent: a
///         full reduce keeps it, `protect` refuses a closed account by the LIVE read (`NoPosition`), and the next
///         `open` (which requires a flat position) overwrites it from live reads.
contract PerpEntryLifetimeRegressionTest is PerpVenueRig {
    // the D2 scene: 5.00 ZEC short against $3,900 of perp balance at 1538.9417; +20 %: past the derisk rung
    uint64 constant MARK = 15_389_417;
    uint64 constant SZ = 500;
    int64 constant A0 = 3_900_000_000;
    uint64 constant MARK_20 = 18_467_300;
    int64 constant A_20 = 2_361_058_500;

    function setUp() public override {
        super.setUp();
        _scene(MARK, 0, A0);
        _open(SZ);
        _scene(MARK, -int64(SZ), A0); // the open filled
        _grantKeeper(0x0E, 1_000e6, 200);
    }

    function test_unfilledFullReduce_keepsTheEntry_andTheKeeperStillProtects() public {
        HyperliquidPerpVenue.Entry memory before = _entry();
        assertGt(before.at, 0);
        _reduce(SZ); // the whole short: an IOC the book does not fill
        assertEq(coreWriter.count(), 2, "the reduce-only buy was sent");
        HyperliquidPerpVenue.Entry memory afterReduce = _entry();
        assertEq(afterReduce.at, before.at, "a full reduce does not clear the record on intent");
        assertEq(afterReduce.distanceBps, before.distanceBps);
        assertEq(afterReduce.hfBps, before.hfBps);
        // the position is still -5.00 ZEC; the mark rises 20 %: the keeper's derisk must still go through
        _scene(MARK_20, -int64(SZ), A_20);
        _protect(PerpHealthLib.RUNG_DERISK, 0, 104);
        assertEq(coreWriter.count(), 3, "protect acted on the still-open short");
    }

    function test_partFilledFullReduce_theKeeperProtectsWhatIsLeft() public {
        _reduce(SZ);
        // 2.00 of the 5.00 filled: 3.00 ZEC short, now under the derisk rung of the recorded ladder
        _scene(MARK_20, -300, 1_200_000_000);
        (,,,,,, uint256 hf,) = venue.health(address(acct));
        assertLt(hf, venue.ladderOf(address(acct)).hf[PerpHealthLib.RUNG_DERISK], "the remainder sits past the derisk rung");
        _protect(PerpHealthLib.RUNG_DERISK, 0, 50);
        assertEq(coreWriter.count(), 3);
    }

    function test_filledFullReduce_noKeeperActionOnAFlatAccount_andAFreshOpenSizesFromLiveReads() public {
        HyperliquidPerpVenue.Entry memory old = _entry();
        _reduce(SZ);
        _scene(MARK, 0, 3_880_000_000); // the buy filled: flat
        // the keeper cannot act on an account with no position: refused by the live read, a superseding refusal
        vm.prank(keeper);
        vm.expectRevert(HyperliquidPerpVenue.NoPosition.selector);
        acct.execAsKeeper(_protectCall(PerpHealthLib.RUNG_EMERGENCY, 0, 1));
        vm.prank(keeper);
        vm.expectRevert(HyperliquidPerpVenue.NoPosition.selector);
        acct.execAsKeeper(_protectCall(PerpHealthLib.RUNG_REPAY, 1e6, 0));
        // nor can an owner action that needs a short
        vm.prank(alice);
        vm.expectRevert(HyperliquidPerpVenue.NoPosition.selector);
        acct.execWithCallback(address(venue), 0, abi.encodeCall(HyperliquidPerpVenue.addMargin, (1e6)));
        (bool has,,,,,,,) = venue.health(address(acct));
        assertFalse(has);
        // a new open works and its record is the live one, not the stale one
        _scene(MARK, 0, 5_000_000_000);
        (uint32 d, uint32 hf) = _open(SZ);
        uint256 wantD = PerpHealthLib.distanceBps(5_000_000_000, uint256(SZ) * MARK, MMR);
        assertEq(d, wantD, "the open's distance is computed from the live balance");
        assertEq(hf, PerpHealthLib.equivalentHfBps(wantD));
        HyperliquidPerpVenue.Entry memory fresh = _entry();
        assertEq(fresh.distanceBps, d, "the record is overwritten by the open");
        assertEq(fresh.hfBps, hf);
        assertTrue(fresh.distanceBps != old.distanceBps, "nothing stale survives the new open");
    }
}
