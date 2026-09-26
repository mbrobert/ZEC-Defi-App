// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {OilskinAccountFactory} from "../src/account/OilskinAccountFactory.sol";
import {Call, Permission, TokenLimit} from "../src/interfaces/IOilskinAccount.sol";
import {ITokenMessengerV2} from "../src/interfaces/ICctpV2.sol";
import {HyperCorePerpAssetInfo, HyperCorePrecompiles} from "../src/interfaces/IHyperCore.sol";
import {HyperCoreLib} from "../src/libraries/HyperCoreLib.sol";
import {PerpHealthLib} from "../src/libraries/PerpHealthLib.sol";
import {HyperliquidPerpVenue} from "../src/venues/HyperliquidPerpVenue.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockCoreWriter, MockHyperCorePrecompile, MockUsdcAdapter} from "./mocks/MockHyperCore.sol";
import {CctpMessageV2, MockMessageTransmitterV2, MockTokenMessengerV2} from "./mocks/MockCctpV2.sol";

/// @dev Exposes the two libraries so their integers can be pinned to `packages/shared` (perps.test.ts) value for value.
contract PerpHealthHarness {
    function ladder(uint256 e) external pure returns (uint32[4] memory hf, uint32[4] memory disarm) {
        PerpHealthLib.Ladder memory l = PerpHealthLib.ladderFor(e);
        return (l.hf, l.disarm);
    }

    function hysteresis(uint256 e) external pure returns (uint256) {
        return PerpHealthLib.hysteresisBps(e);
    }

    function distance(int256 a, uint256 ntl_, uint256 mmr_) external pure returns (uint256) {
        return PerpHealthLib.distanceBps(a, ntl_, mmr_);
    }

    function hfEq(uint256 d) external pure returns (uint256) {
        return PerpHealthLib.equivalentHfBps(d);
    }

    function dForHf(uint256 hf) external pure returns (uint256) {
        return PerpHealthLib.distanceBpsForHf(hf);
    }

    function entryD(uint256 marginBps, uint256 mmr_) external pure returns (uint256) {
        return PerpHealthLib.entryDistanceBpsForMargin(marginBps, mmr_);
    }

    function aFor(uint256 ntl_, uint256 d, uint256 mmr_) external pure returns (uint256) {
        return PerpHealthLib.accountValueForDistanceE6(ntl_, d, mmr_);
    }

    function sizeFor(int256 a, uint256 unit, uint256 d, uint256 mmr_) external pure returns (uint256) {
        return PerpHealthLib.sizeForDistance(a, unit, d, mmr_);
    }

    function ntl(int64 szi, uint64 mark, uint8 szDec) external pure returns (uint256) {
        return PerpHealthLib.notionalE6(szi, mark, szDec);
    }

    function mmr(uint8 maxLev) external pure returns (uint256) {
        return PerpHealthLib.maintenanceMarginRateBps(maxLev);
    }

    function order(uint32 asset, bool isBuy, uint64 px, uint64 sz, bool ro, uint8 tif) external pure returns (bytes memory) {
        return HyperCoreLib.encodeLimitOrder(asset, isBuy, px, sz, ro, tif);
    }

    function classTransfer(uint64 n, bool toPerp) external pure returns (bytes memory) {
        return HyperCoreLib.encodeUsdClassTransfer(n, toPerp);
    }

    function sendAsset(address dest, uint32 s, uint32 d, uint64 token, uint64 w) external pure returns (bytes memory) {
        return HyperCoreLib.encodeSendAsset(dest, s, d, token, w);
    }
}

/// @notice BUILD-PLAN Stream D step D2: the perps venue against CoreWriter's and the precompiles' doubles. The
///         scenes are the ones `packages/shared/test/perps.test.ts` computes from the same inputs, so every
///         number asserted here was produced by the TypeScript twin first (design §9 items 1–2). Testnet, not a
///         fork, is where the real precompiles answer (design §9 item 3).
contract HyperliquidPerpVenueTest is Test {
    MockERC20 usdc;
    MockPermit2 permit2;
    OilskinAccountFactory factory;
    OilskinAccount acct;
    MockCoreWriter coreWriter;
    MockUsdcAdapter adapter;
    MockMessageTransmitterV2 transmitter;
    MockTokenMessengerV2 messenger;
    HyperliquidPerpVenue venue;
    PerpHealthHarness h;

    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");
    address otherKeeper = makeAddr("otherKeeper");
    address circleFees = makeAddr("circle-fee-recipient");

    // the venue as read (research JSON 2026-09-25)
    uint32 constant ZEC = 214;
    uint8 constant SZ_DEC = 2;
    uint8 constant MAX_LEV = 10;
    uint256 constant MMR = 500;
    uint64 constant MARK = 15_389_417; // 1538.9417
    uint64 constant ORACLE = 15_387_700;
    // the scene: 5.00 ZEC short against $3,900 of perp balance
    uint64 constant SZ = 500;
    uint256 constant NTL = 7_694_708_500;
    int64 constant A0 = 3_900_000_000;
    uint32 constant D0 = 4350;
    uint32 constant HF0 = 17699;
    uint64 constant RESERVE0 = 348_979_462;
    // +10 %: the repay rung; +20 %: derisk; +40 %: emergency
    uint64 constant MARK_10 = 16_928_359;
    int64 constant A_10 = 3_130_529_000;
    uint256 constant NTL_10 = 8_464_179_500;
    uint64 constant MARK_20 = 18_467_300;
    int64 constant A_20 = 2_361_058_500;
    uint256 constant NTL_20 = 9_233_650_000;
    uint64 constant MARK_40 = 21_545_184;
    int64 constant A_40 = 822_116_500;
    uint256 constant NTL_40 = 10_772_592_000;

    address constant SYSTEM_USDC = 0x2000000000000000000000000000000000000000;

    function setUp() public {
        usdc = new MockERC20("USDC", "USDC", 6);
        permit2 = new MockPermit2();
        factory = new OilskinAccountFactory(address(permit2));
        acct = OilskinAccount(payable(factory.createAccount(alice)));
        coreWriter = new MockCoreWriter();
        adapter = new MockUsdcAdapter(usdc);
        transmitter = new MockMessageTransmitterV2(19, 1);
        messenger = new MockTokenMessengerV2(usdc, transmitter, 1, circleFees, 10_000_000e6);
        transmitter.setMessenger(messenger);
        messenger.addRemoteTokenMessenger(6, bytes32(uint256(uint160(address(messenger)))));
        h = new PerpHealthHarness();

        bytes memory code = type(MockHyperCorePrecompile).runtimeCode;
        vm.etch(HyperCorePrecompiles.POSITION, code);
        vm.etch(HyperCorePrecompiles.SPOT_BALANCE, code);
        vm.etch(HyperCorePrecompiles.MARK_PX, code);
        vm.etch(HyperCorePrecompiles.ORACLE_PX, code);
        vm.etch(HyperCorePrecompiles.PERP_ASSET_INFO, code);
        vm.etch(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY, code);

        venue = new HyperliquidPerpVenue(_config(address(messenger), 5_000));

        _scriptAssetInfo(SZ_DEC, MAX_LEV);
        _scriptPx(MARK, ORACLE);
        _scriptPosition(0, 0, 0);
        _scriptSummary(A0, 0);
        _scriptSpot(uint64(RESERVE0) * 100 + 100e8); // the reserve plus 100 USDC, in 10^8 wei
        usdc.mint(address(acct), 10_000e6);
    }

    // ------------------------------------------------------------ helpers

    function _config(address cctp, uint256 floorMarginBps) internal view returns (HyperliquidPerpVenue.Config memory c) {
        c.coreWriter = address(coreWriter);
        c.usdc = address(usdc);
        c.usdcAdapter = address(adapter);
        c.cctpMessenger = cctp;
        c.perpAsset = ZEC;
        c.szDecimals = SZ_DEC;
        c.maxLeverage = MAX_LEV;
        c.usdcTokenIndex = 0;
        c.usdcWeiDecimals = 8;
        c.usdcEvmDecimals = 6;
        c.baseDomain = 6;
        c.minEntryMarginBps = floorMarginBps;
        c.maxNotionalE6 = 25_000e6;
        c.maxMarkOracleDeviationBps = 100;
        c.defaultReserveMultipleBps = 10_000;
    }

    function _pre(address a) internal pure returns (MockHyperCorePrecompile) {
        return MockHyperCorePrecompile(a);
    }

    function _scriptAssetInfo(uint8 szDec, uint8 maxLev) internal {
        HyperCorePerpAssetInfo memory info = HyperCorePerpAssetInfo({coin: "ZEC", marginTableId: 52, szDecimals: szDec, maxLeverage: maxLev, onlyIsolated: false});
        _pre(HyperCorePrecompiles.PERP_ASSET_INFO).script(abi.encode(ZEC), abi.encode(info));
    }

    function _scriptPx(uint64 mark, uint64 oracle) internal {
        _pre(HyperCorePrecompiles.MARK_PX).script(abi.encode(ZEC), abi.encode(mark));
        _pre(HyperCorePrecompiles.ORACLE_PX).script(abi.encode(ZEC), abi.encode(oracle));
    }

    function _scriptPosition(int64 szi, uint64 entryNtl, uint32 leverage) internal {
        _pre(HyperCorePrecompiles.POSITION).script(abi.encode(address(acct), uint16(ZEC)), abi.encode(szi, entryNtl, int64(0), leverage, false));
    }

    function _scriptSummary(int64 accountValue, uint64 ntlPos) internal {
        _pre(HyperCorePrecompiles.ACCOUNT_MARGIN_SUMMARY).script(abi.encode(uint32(0), address(acct)), abi.encode(accountValue, uint64(0), ntlPos, accountValue));
    }

    function _scriptSpot(uint64 totalWei) internal {
        _pre(HyperCorePrecompiles.SPOT_BALANCE).script(abi.encode(address(acct), uint64(0)), abi.encode(totalWei, uint64(0), uint64(0)));
    }

    /// The scene after `open`: a live short of SZ at `mark` with `a` of account value and the summary agreeing.
    function _scene(uint64 mark, int64 a, uint256 ntl) internal {
        _scriptPx(mark, mark - 1_717);
        _scriptPosition(-int64(SZ), uint64(NTL), MAX_LEV);
        _scriptSummary(a, uint64(ntl));
    }

    function _owner(bytes memory data) internal returns (bytes memory) {
        vm.prank(alice);
        return acct.execWithCallback(address(venue), 0, data);
    }

    function _open() internal {
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (HyperliquidPerpVenue.OpenParams({sz: SZ, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)}))));
    }

    function _grantKeeper(address k, uint8 rungs, uint64 topUp, uint64 reduceSz) internal {
        vm.prank(alice);
        acct.grant(
            k,
            Permission({
                target: address(venue),
                selector: HyperliquidPerpVenue.protect.selector,
                maxValuePerPeriod: 0,
                tokenLimits: new TokenLimit[](0),
                period: 1 days,
                expiry: uint40(block.timestamp + 30 days),
                allowCallback: true
            })
        );
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (k, uint40(block.timestamp + 30 days), 1 days, rungs, topUp, reduceSz, 50)));
    }

    function _protect(address k, uint8 rung, uint64 topUp, uint64 reduceSz) internal {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(venue), value: 0, data: abi.encodeCall(HyperliquidPerpVenue.protect, (rung, topUp, reduceSz)), callback: false});
        vm.prank(k);
        acct.execAsKeeper(calls);
    }

    function _entry() internal view returns (uint32 d, uint32 hf, uint64 sz, uint64 reserve, uint40 at) {
        return venue.entryOf(address(acct));
    }

    // ---------------------------------------------------- the libraries, pinned to shared

    function test_ladder_isSharedLadderBpsForValueForValue() public view {
        uint256[9] memory entries = [uint256(11000), 12500, 15500, 17497, 17699, 20000, 24230, 50000, 104931];
        uint32[4][9] memory hfs = [
            [uint32(10900), 10700, 10600, 10500],
            [uint32(12300), 11600, 10900, 10500],
            [uint32(15000), 13500, 12000, 10500],
            [uint32(16800), 14800, 12700, 10700],
            [uint32(17000), 14900, 12800, 10700],
            [uint32(19100), 16400, 13600, 10900],
            [uint32(22900), 16400, 13600, 10900],
            [uint32(46400), 16400, 13600, 10900],
            [uint32(96400), 16400, 13600, 10900]
        ];
        uint32[4][9] memory disarms = [
            [uint32(11100), 10900, 10800, 10700],
            [uint32(12500), 11800, 11100, 10700],
            [uint32(15500), 14000, 12500, 11000],
            [uint32(17500), 15500, 13400, 11400],
            [uint32(17700), 15600, 13500, 11400],
            [uint32(20000), 17300, 14500, 11800],
            [uint32(24200), 17300, 14500, 11800],
            [uint32(50000), 17300, 14500, 11800],
            [uint32(105000), 17300, 14500, 11800]
        ];
        uint256[9] memory hyst = [uint256(200), 200, 500, 700, 700, 900, 1300, 3600, 8600];
        for (uint256 i = 0; i < entries.length; i++) {
            (uint32[4] memory hf, uint32[4] memory dis) = h.ladder(entries[i]);
            for (uint256 r = 0; r < 4; r++) {
                assertEq(hf[r], hfs[i][r], "rung threshold");
                assertEq(dis[r], disarms[i][r], "rung disarm");
            }
            assertEq(h.hysteresis(entries[i]), hyst[i], "hysteresis");
        }
    }

    function test_ladder_refusesAnEntryFourRungsDoNotFitUnder() public {
        vm.expectRevert(abi.encodeWithSelector(PerpHealthLib.EntryTooThinForLadder.selector, 10_999));
        h.ladder(10_999);
    }

    function test_distanceAndEquivalentHf_matchSharedOnEveryScene() public view {
        assertEq(h.mmr(MAX_LEV), MMR);
        assertEq(h.ntl(-int64(SZ), MARK, SZ_DEC), NTL);
        assertEq(h.distance(A0, NTL, MMR), D0);
        assertEq(h.hfEq(D0), HF0);
        assertEq(h.distance(A_10, NTL_10, MMR), 3045);
        assertEq(h.hfEq(3045), 14378);
        assertEq(h.distance(A_20, NTL_20, MMR), 1959);
        assertEq(h.hfEq(1959), 12436);
        assertEq(h.distance(A_40, NTL_40, MMR), 250);
        assertEq(h.hfEq(250), 10256);
        assertEq(h.distance(-5, NTL, MMR), 0, "a wiped account is at zero distance, not negative");
        assertEq(h.distance(1e15, 1, MMR), 9900, "clamped at 0.99");
        assertEq(h.hfEq(9900), 1_000_000);
        assertEq(h.entryD(5_000, MMR), 4285, "the proposed floor: half the notional as margin");
        assertEq(h.hfEq(4285), 17497);
        assertEq(h.dForHf(17497), 4284, "the floor round trip loses one bp; comparisons happen in HF space");
        assertEq(h.dForHf(14900), 3288);
        assertEq(h.dForHf(15600), 3589);
        assertEq(h.dForHf(10500), 476, "the emergency floor is a 4.76 % move");
        assertEq(h.entryD(MMR, MMR), 0);
        assertEq(h.aFor(NTL, 4285, MMR), 3_846_777_147);
        assertEq(h.distance(3_846_777_146, NTL, MMR), 4284, "a unit under the floor's account value is under the floor");
        assertEq(h.sizeFor(A_10, MARK_10, 3589, MMR), SZ - 67, "the reduce that reaches the repay disarm at +10 %");
        assertEq(h.sizeFor(A_20, MARK_20, 2592, MMR), SZ - 104, "at +20 %, to the derisk disarm");
        assertEq(h.sizeFor(0, MARK, 3589, MMR), 0);
    }

    function test_notional_refusesALongAndAnEmptyPosition() public {
        vm.expectRevert(abi.encodeWithSelector(PerpHealthLib.NotAShort.selector, int64(5)));
        h.ntl(5, MARK, SZ_DEC);
        vm.expectRevert(abi.encodeWithSelector(PerpHealthLib.NotAShort.selector, int64(0)));
        h.ntl(0, MARK, SZ_DEC);
    }

    function test_encoding_matchesSharedByteForByte_andTheLiveRawActionLog() public view {
        // action 1 [doc]: the open sell of 5.00 ZEC at the mark less 50 bps, prices and sizes in 10^8
        assertEq(
            h.order(ZEC, false, 153_124_699_150, 500_000_000, false, HyperCoreLib.TIF_IOC),
            hex"0100000100000000000000000000000000000000000000000000000000000000000000d6000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000023a6f17c0e000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000"
        );
        // action 7 [doc]
        assertEq(
            h.classTransfer(1_000_000, true),
            hex"0100000700000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000001"
        );
        // action 13, the venue's own withdrawal to the system address
        assertEq(
            h.sendAsset(SYSTEM_USDC, HyperCoreLib.SPOT_DEX, HyperCoreLib.SPOT_DEX, 0, 250_000_000),
            hex"0100000d0000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffff00000000000000000000000000000000000000000000000000000000ffffffff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ee6b280"
        );
        // action 13 as CoreWriter logged it on 2026-09-25 (tx 0xeaf2…acb9, block 46,887,881): the encoding rule from chain
        assertEq(
            h.sendAsset(0xc0e330226EAC3D1a47C91f1D9bae525e5fB28DA0, HyperCoreLib.SPOT_DEX, 0, 0, 7_001_465_300),
            hex"0100000d000000000000000000000000c0e330226eac3d1a47c91f1d9bae525e5fb28da0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a151e1d4"
        );
    }

    // ------------------------------------------------------------ construction

    function test_constructor_refusesAFloorAtOrUnderTheMaintenanceRate_andAnOddMaxLeverage() public {
        vm.expectRevert(HyperliquidPerpVenue.InvalidConfig.selector);
        new HyperliquidPerpVenue(_config(address(messenger), MMR));
        HyperliquidPerpVenue.Config memory c = _config(address(messenger), 5_000);
        c.maxLeverage = 7; // 1/(2×7) is not a whole number of bps
        vm.expectRevert(bytes("mmr"));
        new HyperliquidPerpVenue(c);
        assertEq(venue.mmrBps(), MMR);
        assertEq(venue.minEntryDistanceBps(), 4285);
    }

    // ------------------------------------------------------------ owner path

    function test_fundCore_approvesExactlyDepositsToBothDexesAndResets() public {
        _owner(abi.encodeCall(HyperliquidPerpVenue.fundCore, (400e6, 3_900e6)));
        assertEq(adapter.count(), 2);
        (address from0, uint256 amt0, uint32 dex0) = adapter.deposits(0);
        (address from1, uint256 amt1, uint32 dex1) = adapter.deposits(1);
        assertEq(from0, address(acct));
        assertEq(amt0, 400e6);
        assertEq(dex0, type(uint32).max, "the reserve goes to spot");
        assertEq(from1, address(acct));
        assertEq(amt1, 3_900e6);
        assertEq(dex1, 0, "the margin goes to the perp dex");
        assertEq(usdc.allowance(address(acct), address(adapter)), 0, "no standing approval");
        assertEq(usdc.balanceOf(address(acct)), 10_000e6 - 4_300e6);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.UsdcShort.selector, 20_000e6, 5_700e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.fundCore, (0, 20_000e6)));
        vm.expectRevert(HyperliquidPerpVenue.ZeroAmount.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.fundCore, (0, 0)));
    }

    function test_ownerFunctions_refuseAKeeperEvenWhenMisgranted() public {
        vm.prank(alice);
        acct.grant(
            keeper,
            Permission({target: address(venue), selector: HyperliquidPerpVenue.fundCore.selector, maxValuePerPeriod: 0, tokenLimits: new TokenLimit[](0), period: 1 days, expiry: uint40(block.timestamp + 1 days), allowCallback: true})
        );
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(venue), value: 0, data: abi.encodeCall(HyperliquidPerpVenue.fundCore, (1e6, 0)), callback: false});
        vm.prank(keeper);
        vm.expectRevert(HyperliquidPerpVenue.NotOwnerPath.selector);
        acct.execAsKeeper(calls);
    }

    function test_open_sendsTheDocumentedSellAndRecordsTheEntry() public {
        vm.expectEmit(true, false, false, true, address(venue));
        emit HyperliquidPerpVenue.EntryRecorded(address(acct), D0, HF0, SZ, RESERVE0);
        vm.expectEmit(true, false, false, true, address(venue));
        emit HyperliquidPerpVenue.ShortOpened(address(acct), SZ, MARK, D0, HF0, RESERVE0);
        _open();
        assertEq(coreWriter.count(), 1);
        assertEq(coreWriter.senders(0), address(acct), "the position belongs to the ACCOUNT's address on HyperCore");
        assertEq(coreWriter.actions(0), h.order(ZEC, false, 153_130_000_000, 500_000_000, false, HyperCoreLib.TIF_IOC), "the sell's floor: mark x 0.995 = 1531.24699 rounded UP to five figures, 1531.3 (AUDIT-2026-09-26 P-1)");
        (uint32 d, uint32 hf, uint64 sz, uint64 reserve, uint40 at) = _entry();
        assertEq(d, D0);
        assertEq(hf, HF0);
        assertEq(sz, SZ);
        assertEq(reserve, RESERVE0);
        assertEq(at, uint40(block.timestamp));
        PerpHealthLib.Ladder memory l = venue.ladderOf(address(acct));
        assertEq(l.hf[1], 14900);
        assertEq(l.disarm[1], 15600);
    }

    function test_open_refusalsByName() public {
        HyperliquidPerpVenue.OpenParams memory p = HyperliquidPerpVenue.OpenParams({sz: SZ, maxSlippageBps: 50, deadline: uint40(block.timestamp + 600)});
        // expired, zero, too wide a band
        p.deadline = uint40(block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.Expired.selector, block.timestamp - 1));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        p.deadline = uint40(block.timestamp + 600);
        p.sz = 0;
        vm.expectRevert(HyperliquidPerpVenue.ZeroAmount.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        p.sz = SZ;
        p.maxSlippageBps = 501;
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.SlippageTooLarge.selector, 501, 500));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        p.maxSlippageBps = 50;
        // the venue changed the market's parameters
        _scriptAssetInfo(SZ_DEC, 5);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.VenueParamsChanged.selector, SZ_DEC, 5));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptAssetInfo(SZ_DEC, MAX_LEV);
        // mark and oracle disagree by 10 %
        _scriptPx(MARK, (MARK * 9) / 10);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.MarkOracleDeviation.selector, MARK, (MARK * 9) / 10, 1111));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptPx(MARK, ORACLE);
        // a position already open, another position open, nothing to margin with
        _scriptPosition(-1, 1, MAX_LEV);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.PositionOpen.selector, int64(-1)));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptPosition(0, 0, 0);
        _scriptSummary(A0, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.OtherPositionsOpen.selector, uint64(1_000e6), 0));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptSummary(0, 0);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.AccountValueNotPositive.selector, int64(0)));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        // a unit of USDC under the floor
        _scriptSummary(3_846_777_146, 0);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.EntryDistanceTooLow.selector, 4284, 4285));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptSummary(A0, 0);
        // over the beta cap
        p.sz = 2000;
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.NotionalOverCap.selector, uint256(2000) * MARK, 25_000e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        p.sz = SZ;
        // the reserve a wei short
        _scriptSpot(uint64(RESERVE0) * 100 - 100);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, RESERVE0 - 1, RESERVE0));
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        _scriptSpot(uint64(RESERVE0) * 100);
        _owner(abi.encodeCall(HyperliquidPerpVenue.open, (p)));
        assertEq(coreWriter.count(), 1, "exactly the reserve is enough");
    }

    function test_addMargin_movesSpotToPerpAndRerecords_D9() public {
        _open();
        _scene(MARK, A0, NTL);
        _owner(abi.encodeCall(HyperliquidPerpVenue.addMargin, (50e6)));
        assertEq(coreWriter.actions(1), h.classTransfer(50e6, true));
        (uint32 d, uint32 hf, uint64 sz,,) = _entry();
        assertEq(d, h.distance(A0 + 50e6, NTL, MMR), "the entry is re-recorded with the intended balance");
        assertEq(hf, h.hfEq(d));
        assertEq(sz, SZ);
        assertGt(d, D0);
        // more than the spot holds, or leaving the reserve short (adding margin lowers the reserve a little — the
        // entry distance grows — but not by the 120 USDC this would take out of it)
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, RESERVE0 + 100e6, 1_000e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.addMargin, (1_000e6)));
        vm.expectRevert();
        _owner(abi.encodeCall(HyperliquidPerpVenue.addMargin, (120e6)));
    }

    function test_reduce_sendsReduceOnlyBuyAndRerecordsOrClears_D9() public {
        _open();
        _scene(MARK, A0, NTL);
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (100, 50, uint40(block.timestamp + 600))));
        // the buy is shaded UP by the band then rounded DOWN to the venue's precision: 1546.6 in 10^8, size 1.00 ZEC
        assertEq(coreWriter.actions(1), h.order(ZEC, true, 154_660_000_000, 100_000_000, true, HyperCoreLib.TIF_IOC), "the buy's ceiling: mark x 1.005 = 1546.63641 rounded DOWN to 1546.6");
        (uint32 d,, uint64 sz,,) = _entry();
        assertEq(sz, 400);
        assertEq(d, h.distance(A0, h.ntl(-400, MARK, SZ_DEC), MMR));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceExceedsPosition.selector, 501, SZ));
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (501, 50, uint40(block.timestamp + 600))));
        vm.expectEmit(true, false, false, false, address(venue));
        emit HyperliquidPerpVenue.EntryCleared(address(acct));
        _owner(abi.encodeCall(HyperliquidPerpVenue.reduce, (SZ, 50, uint40(block.timestamp + 600))));
        (,,,, uint40 at) = _entry();
        assertEq(at, 0, "closing the whole short clears the record");
    }

    function test_withdrawToEvm_keepsTheFloorAndTheReserveWhileTheShortIsOpen() public {
        _open();
        _scene(MARK, A0, NTL);
        // taking $100 out of the perp balance leaves d under the floor (A0 is only $53 above it)
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ExitDistanceTooLow.selector, h.distance(A0 - 100e6, NTL, MMR), 4285));
        _owner(abi.encodeCall(HyperliquidPerpVenue.withdrawToEvm, (100e6, 0)));
        // sending the whole spot away leaves the reserve short
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, 0, RESERVE0));
        _owner(abi.encodeCall(HyperliquidPerpVenue.withdrawToEvm, (0, RESERVE0 + 100e6)));
        // $40 out of perp, $100 of spot home: both gates hold
        _owner(abi.encodeCall(HyperliquidPerpVenue.withdrawToEvm, (40e6, 100e6)));
        assertEq(coreWriter.count(), 3);
        assertEq(coreWriter.actions(1), h.classTransfer(40e6, false));
        assertEq(coreWriter.actions(2), h.sendAsset(SYSTEM_USDC, HyperCoreLib.SPOT_DEX, HyperCoreLib.SPOT_DEX, 0, 100e8), "spot -> HyperEVM is a sendAsset to the system address in 10^8 wei");
        (uint32 d,,,,) = _entry();
        assertEq(d, h.distance(A0 - 40e6, NTL, MMR), "the owner's withdrawal re-records the entry (D9)");
        // with no position, only the balance bounds it
        _scriptPosition(0, 0, 0);
        _scriptSummary(200e6, 0);
        _scriptSpot(50e8);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.UsdcShort.selector, 300e6, 200e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.withdrawToEvm, (300e6, 0)));
        _owner(abi.encodeCall(HyperliquidPerpVenue.withdrawToEvm, (200e6, 250e6)));
        assertEq(coreWriter.count(), 5);
    }

    function test_burnToBase_standardOnlyToTheRecordedBaseAccount() public {
        bytes32 home = bytes32(uint256(uint160(makeAddr("alice-base-account"))));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.NoBaseRecipient.selector, address(acct)));
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (1_000e6, 1e6)));
        _owner(abi.encodeCall(HyperliquidPerpVenue.setBaseRecipient, (home)));
        assertEq(venue.baseRecipient(address(acct)), home);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.MaxFeeTooLarge.selector, 11e6, 10e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (1_000e6, 11e6)));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.UsdcShort.selector, 20_000e6, 10_000e6));
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (20_000e6, 1e6)));
        uint256 supply = usdc.totalSupply();
        vm.recordLogs();
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (1_000e6, 1e6)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(messenger) || logs[i].topics[0] != ITokenMessengerV2.DepositForBurn.selector) continue;
            (uint256 amount, bytes32 mintRecipient, uint32 destinationDomain,,, uint256 maxFee,) =
                abi.decode(logs[i].data, (uint256, bytes32, uint32, bytes32, bytes32, uint256, bytes));
            assertEq(amount, 1_000e6);
            assertEq(mintRecipient, home, "only the recorded Base account");
            assertEq(destinationDomain, 6, "only Base");
            assertEq(maxFee, 1e6);
            assertEq(uint256(logs[i].topics[3]), 2000, "Standard finality: HyperEVM has no Fast Transfer");
            seen = true;
        }
        assertTrue(seen, "DepositForBurn emitted");
        assertEq(usdc.totalSupply(), supply - 1_000e6, "burned, not moved");
        assertEq(usdc.allowance(address(acct), address(messenger)), 0);
        // the whole balance, and a deployment without a messenger
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (type(uint256).max, 1e6)));
        assertEq(usdc.balanceOf(address(acct)), 0);
        HyperliquidPerpVenue offline = new HyperliquidPerpVenue(_config(address(0), 5_000));
        vm.prank(alice);
        vm.expectRevert(HyperliquidPerpVenue.CrossChainDisabled.selector);
        acct.execWithCallback(address(offline), 0, abi.encodeCall(HyperliquidPerpVenue.burnToBase, (1, 0)));
    }

    function test_setPerpGrant_validatesCarriesAndClears() public {
        vm.expectRevert(HyperliquidPerpVenue.InvalidGrant.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (address(0), uint40(block.timestamp + 1), 1, 0x0E, 1, 1, 50)));
        vm.expectRevert(HyperliquidPerpVenue.InvalidGrant.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp), 1, 0x0E, 1, 1, 50)));
        vm.expectRevert(HyperliquidPerpVenue.InvalidGrant.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 1), 0, 0x0E, 1, 1, 50)));
        vm.expectRevert(HyperliquidPerpVenue.InvalidGrant.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 1), 1, 0x0F, 1, 1, 50)));
        vm.expectRevert(HyperliquidPerpVenue.InvalidGrant.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 1), 1, 0x10, 1, 1, 50)));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.SlippageTooLarge.selector, 501, 500));
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 1), 1, 0x0E, 1, 1, 501)));

        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        HyperliquidPerpVenue.PerpGrant memory g = venue.perpGrantOf(address(acct));
        assertEq(g.keeper, keeper);
        assertEq(g.allowedRungs, 0x0E);
        assertEq(g.epoch, acct.grantEpoch());
        assertEq(g.periodStart, uint40(block.timestamp));
        // spend, then re-grant inside the period: the spend carries (no refill by re-granting)
        _open();
        _scene(MARK_10, A_10, NTL_10);
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 400e6, 0);
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 30 days), 1 days, 0x0E, 1_000e6, 200, 50)));
        g = venue.perpGrantOf(address(acct));
        assertEq(g.topUpSpent, 400e6, "a re-grant inside a live period carries the spend");
        // a different keeper starts a fresh window
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (otherKeeper, uint40(block.timestamp + 30 days), 1 days, 0x0E, 1_000e6, 200, 50)));
        g = venue.perpGrantOf(address(acct));
        assertEq(g.topUpSpent, 0);
        _owner(abi.encodeCall(HyperliquidPerpVenue.clearPerpGrant, ()));
        g = venue.perpGrantOf(address(acct));
        assertEq(g.keeper, address(0));
    }

    // ------------------------------------------------------------ keeper path

    function test_protect_topUpAtTheRepayRung_insideTheGrant_neverTouchesTheEntry() public {
        _open();
        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        _scene(MARK_10, A_10, NTL_10);
        (bool has,,, int64 a, uint256 ntl, uint256 d, uint256 hf,) = venue.health(address(acct));
        assertTrue(has);
        assertEq(a, A_10);
        assertEq(ntl, NTL_10);
        assertEq(d, 3045);
        assertEq(hf, 14378, "under the 1.49 repay rung, above the 1.28 derisk rung");
        // FINDING (design section 10 item 4): the 1x reserve (349 USDC) is the top-up from EXACTLY the repay rung to its
        // disarm; a +10 % move in one tick lands 243 bps past the rung and the top-up to disarm is 482 USDC, 1.38x the
        // reserve. With only the reserve on spot the venue refuses the full top-up by name, and the keeper's policy
        // must top up what the reserve holds instead. Scripted here with a fuller spot so the rest of the path runs.
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, RESERVE0 + 100e6, 482_363_699));
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 482_363_699, 0);
        _scriptSpot(1_000e8);
        vm.expectEmit(true, true, false, true, address(venue));
        emit HyperliquidPerpVenue.Protected(address(acct), keeper, PerpHealthLib.RUNG_REPAY, 14378, 482_363_699, 0);
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 482_363_699, 0);
        assertEq(coreWriter.count(), 2);
        assertEq(coreWriter.actions(1), h.classTransfer(482_363_699, true), "the top-up shared computes to reach the repay disarm");
        (uint32 ed, uint32 ehf, uint64 esz,,) = _entry();
        assertEq(ed, D0);
        assertEq(ehf, HF0);
        assertEq(esz, SZ, "D9: the keeper does not mark its own homework");
        // the budget, the spot, the rung that has not fired, a reduce where only a top-up is allowed
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.TopUpBudgetExceeded.selector, 600e6, 1_000e6 - 482_363_699));
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 600e6, 0);
        _scriptSpot(100e8);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReserveShort.selector, 100e6, 200e6));
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 200e6, 0);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.RungNotCrossed.selector, PerpHealthLib.RUNG_DERISK, 14378, 12800));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 67);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceNotAllowedAtRung.selector, PerpHealthLib.RUNG_REPAY));
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 0, 67);
        vm.expectRevert(HyperliquidPerpVenue.NothingToDo.selector);
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 0, 0);
        // the period rolls and the budget is whole again
        vm.warp(block.timestamp + 1 days);
        _scriptSpot(1_000e8);
        _protect(keeper, PerpHealthLib.RUNG_REPAY, 600e6, 0);
    }

    function test_protect_reduceAtDerisk_andTheWholeShortAtEmergency_underTheReduceBudget() public {
        _open();
        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        _scene(MARK_20, A_20, NTL_20);
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 104);
        // the buy is shaded up by the GRANT's band (50 bps), reduce-only, IOC: mark × 1.005 in 10^8, 1.04 ZEC
        assertEq(coreWriter.actions(1), h.order(ZEC, true, 185_590_000_000, 104_000_000, true, HyperCoreLib.TIF_IOC), "1855.96365 rounded DOWN to 1855.9");
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceBudgetExceeded.selector, 100, 96));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 100);
        // a top-up is allowed at the derisk rung too
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 100e6, 0);
        // +40 %: the emergency rung; the whole short needs a budget that allows it
        _scene(MARK_40, A_40, NTL_40);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceBudgetExceeded.selector, SZ, 96));
        _protect(keeper, PerpHealthLib.RUNG_EMERGENCY, 0, SZ);
        // a re-grant inside the period carries the 104 already spent: 1,000 − 104 remain, enough for the whole short
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 30 days), 1 days, 0x0E, 1_000e6, 1_000, 50)));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceExceedsPosition.selector, 501, SZ));
        _protect(keeper, PerpHealthLib.RUNG_EMERGENCY, 0, 501);
        _protect(keeper, PerpHealthLib.RUNG_EMERGENCY, 0, SZ);
        assertEq(coreWriter.actions(3), h.order(ZEC, true, 216_520_000_000, 500_000_000, true, HyperCoreLib.TIF_IOC), "2165.290992 rounded DOWN to 2165.2");
        // Advanced's sell-budget-of-zero twin: rungs 3–4 can only top up
        _owner(abi.encodeCall(HyperliquidPerpVenue.setPerpGrant, (keeper, uint40(block.timestamp + 30 days), 1 days, 0x0E, 1_000e6, 0, 50)));
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.ReduceBudgetExceeded.selector, 1, 0));
        _protect(keeper, PerpHealthLib.RUNG_EMERGENCY, 0, 1);
    }

    function test_protect_refusesTheWrongKeeperDeadGrantsStaleEpochsForbiddenRungsAndTheOwnerPath() public {
        _open();
        _scene(MARK_20, A_20, NTL_20);
        // no PerpGrant at all, though the account permission exists
        vm.prank(alice);
        acct.grant(
            keeper,
            Permission({target: address(venue), selector: HyperliquidPerpVenue.protect.selector, maxValuePerPeriod: 0, tokenLimits: new TokenLimit[](0), period: 1 days, expiry: uint40(block.timestamp + 30 days), allowCallback: true})
        );
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.NotGrantedKeeper.selector, keeper));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        // a grant for another keeper
        _grantKeeper(otherKeeper, 0x0E, 1_000e6, 200);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.NotGrantedKeeper.selector, keeper));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        // the right keeper, a rung the grant does not allow (top-up only)
        _grantKeeper(keeper, 0x02, 1_000e6, 200);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.RungNotAllowed.selector, PerpHealthLib.RUNG_DERISK));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.RungNotAllowed.selector, 0));
        _protect(keeper, 0, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.RungNotAllowed.selector, 4));
        _protect(keeper, 4, 1, 0);
        // the owner cannot call the keeper's door
        vm.expectRevert(HyperliquidPerpVenue.NotKeeperPath.selector);
        _owner(abi.encodeCall(HyperliquidPerpVenue.protect, (PerpHealthLib.RUNG_REPAY, 1, 0)));
        // revokeAll kills the account permission; a re-granted permission still meets a stale PerpGrant epoch
        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        vm.prank(alice);
        acct.revokeAll();
        vm.prank(alice);
        acct.grant(
            keeper,
            Permission({target: address(venue), selector: HyperliquidPerpVenue.protect.selector, maxValuePerPeriod: 0, tokenLimits: new TokenLimit[](0), period: 1 days, expiry: uint40(block.timestamp + 30 days), allowCallback: true})
        );
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.GrantEpochStale.selector, acct.grantEpoch() - 1, acct.grantEpoch()));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        // expiry
        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert();
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
    }

    function test_protect_refusesWithoutAnEntryAndWithNoPosition() public {
        _grantKeeper(keeper, 0x0E, 1_000e6, 200);
        _scene(MARK_20, A_20, NTL_20);
        vm.expectRevert(HyperliquidPerpVenue.NoEntry.selector);
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        _scriptPx(MARK, ORACLE);
        _scriptPosition(0, 0, 0);
        _scriptSummary(A0, 0);
        _open();
        // the order landed nowhere (an IOC the book did not fill): an entry with no position
        vm.expectRevert(HyperliquidPerpVenue.NoPosition.selector);
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
        // a second position on the same HyperCore account makes the distance a fiction: refused
        _scene(MARK_20, A_20, NTL_20 + 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpVenue.OtherPositionsOpen.selector, uint64(NTL_20 + 1_000e6), NTL_20));
        _protect(keeper, PerpHealthLib.RUNG_DERISK, 0, 1);
    }

    function test_health_view_andAPrecompileThatDoesNotAnswerIsRefusedByName() public {
        (bool has,, uint64 mark, int64 a,,,, uint256 spot) = venue.health(address(acct));
        assertFalse(has);
        assertEq(mark, MARK);
        assertEq(a, A0);
        assertEq(spot, RESERVE0 + 100e6);
        _open();
        _scene(MARK_40, A_40, NTL_40);
        uint256 d;
        uint256 hf;
        (has,,,,, d, hf,) = venue.health(address(acct));
        assertTrue(has);
        assertEq(d, 250);
        assertEq(hf, 10256, "under the emergency rung");
        _pre(HyperCorePrecompiles.MARK_PX).setFailAll(true);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreLib.PrecompileReadFailed.selector, HyperCorePrecompiles.MARK_PX));
        venue.health(address(acct));
        _grantKeeper(keeper, 0x0E, 1_000e6, 1_000);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreLib.PrecompileReadFailed.selector, HyperCorePrecompiles.MARK_PX));
        _protect(keeper, PerpHealthLib.RUNG_EMERGENCY, 0, SZ);
    }

    // ---------------------------------------------------- D5: the rail in and out (2026-09-26)

    /// A burn message from Base (domain 6 → 19) for the account, delivered by anyone through the transmitter.
    function _arriveFromBase(address to, uint256 amount, uint256 fee, uint256 nonce) internal returns (bytes memory message) {
        CctpMessageV2.Header memory hd = CctpMessageV2.Header({
            version: 1,
            sourceDomain: 6,
            destinationDomain: 19,
            nonce: bytes32(nonce),
            sender: bytes32(uint256(uint160(address(messenger)))),
            recipient: CctpMessageV2.toBytes32(address(messenger)),
            destinationCaller: bytes32(0),
            minFinalityThreshold: 1000,
            finalityThresholdExecuted: 1000
        });
        CctpMessageV2.BurnBody memory b = CctpMessageV2.BurnBody({
            version: 1,
            burnToken: CctpMessageV2.toBytes32(address(usdc)),
            mintRecipient: CctpMessageV2.toBytes32(to),
            amount: amount,
            messageSender: CctpMessageV2.toBytes32(makeAddr("alice-base-account")),
            maxFee: fee,
            feeExecuted: fee,
            expirationBlock: block.number + 7200,
            hookData: ""
        });
        message = CctpMessageV2.encode(hd, b);
        vm.prank(makeAddr("anyone-who-delivers"));
        transmitter.receiveMessage(message, hex"01");
    }

    /// The arrival (design §6 "In"): a Base burn to domain 19 with the account as `mintRecipient` is delivered by
    /// anyone and mints Circle's USDC into the account with no signature from it, less Circle's executed fee (1.3 bp
    /// Fast); a replay is refused; `fundCore` then moves it onto HyperCore — spot for the reserve, perp for the margin.
    function test_receiveMessage_fromBase_mintsToTheAccountAndFundCoreMovesItOntoHyperCore() public {
        uint256 before = usdc.balanceOf(address(acct));
        uint256 supply = usdc.totalSupply();
        uint256 fee = 650_000; // 1.3 bp of 5,000 USDC
        bytes memory m = _arriveFromBase(address(acct), 5_000e6, fee, 1);
        assertEq(usdc.balanceOf(address(acct)), before + 5_000e6 - fee, "amount less Circle's executed fee lands in the account");
        assertEq(usdc.balanceOf(circleFees), fee);
        assertEq(usdc.totalSupply(), supply + 5_000e6, "minted, not moved");
        vm.prank(makeAddr("anyone-who-delivers"));
        vm.expectRevert(abi.encodeWithSelector(MockMessageTransmitterV2.NonceUsed.selector, bytes32(uint256(1))));
        transmitter.receiveMessage(m, hex"01");
        // onto HyperCore: the reserve to spot, the rest to the perp dex, through token 0's adapter
        uint256 toSpot = RESERVE0;
        uint256 toPerp = 5_000e6 - fee - toSpot;
        _owner(abi.encodeCall(HyperliquidPerpVenue.fundCore, (toSpot, toPerp)));
        (address from0, uint256 amount0, uint32 dex0) = adapter.deposits(0);
        (address from1, uint256 amount1, uint32 dex1) = adapter.deposits(1);
        assertEq(from0, address(acct));
        assertEq(amount0, toSpot);
        assertEq(dex0, type(uint32).max, "spot");
        assertEq(from1, address(acct));
        assertEq(amount1, toPerp);
        assertEq(dex1, 0, "the perp dex");
        assertEq(usdc.balanceOf(address(acct)), before, "what arrived is on HyperCore; what was there before stays");
        assertEq(usdc.allowance(address(acct), address(adapter)), 0, "approval reset");
    }

    /// The way home (design §6 "Out"): the message `burnToBase` emits is what Circle attests for Base — domain
    /// 19 → 6, Standard (no Fast out of HyperEVM), anyone may deliver, the recorded Base account left-padded.
    function test_burnToBase_messageIsWhatCircleAttestsForBase() public {
        address home = makeAddr("alice-base-account");
        _owner(abi.encodeCall(HyperliquidPerpVenue.setBaseRecipient, (bytes32(uint256(uint160(home))))));
        _owner(abi.encodeCall(HyperliquidPerpVenue.burnToBase, (2_500e6, 0)));
        (CctpMessageV2.Header memory hd, CctpMessageV2.BurnBody memory b) = CctpMessageV2.decode(transmitter.lastMessage());
        assertEq(hd.sourceDomain, 19);
        assertEq(hd.destinationDomain, 6);
        assertEq(hd.recipient, bytes32(uint256(uint160(address(messenger)))), "Base's messenger, as registered for domain 6");
        assertEq(hd.destinationCaller, bytes32(0), "anyone may deliver on Base");
        assertEq(hd.minFinalityThreshold, 2000, "Standard only out of HyperEVM (facts s.7.4)");
        assertEq(CctpMessageV2.toAddress(b.mintRecipient), home, "the recorded Base account, and no other");
        assertEq(b.amount, 2_500e6);
        assertEq(b.maxFee, 0);
        assertEq(b.messageSender, CctpMessageV2.toBytes32(address(acct)));
        assertEq(b.burnToken, CctpMessageV2.toBytes32(address(usdc)));
    }
}
