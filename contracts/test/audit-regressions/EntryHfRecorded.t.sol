// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";

/// @notice BUILD-PLAN-2026-09-12 D7 / step A4 (2026-09-12): the user chooses the entry health factor
///         on a continuous slider above ONE registry floor, and the keeper derives the ladder from
///         the entry HF the position was opened at — never from a global table. The record is the
///         router's `entryHfWad[account]`, written by every open (leveraged or borrow-only) as the
///         venue measured it, and emitted as `EntryHfRecorded`.
///
///   The floor is the founder's number (1.25 proposed; 1.55 deployed until he pins it). These tests
///   move it with the owner's setter and prove what the record says at 1.30 and at 1.25, and that a
///   borrow under the floor still reverts `EntryHfTooLow` at the venue with nothing recorded.
contract EntryHfRecordedRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    /// USDC to borrow against ONE cbBTC at `ltvBps` of its mock-oracle value.
    function _borrowFor(uint256 ltvBps) internal pure returns (uint256) {
        return (PRICE_CBBTC_E8 * ltvBps) / 10_000 / 100;
    }

    function _borrowOnly(uint256 collateral, uint256 borrow_, uint256 nonce)
        internal
        view
        returns (StrategyRouter.BorrowOnlyParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 20 minutes,
            signature: collateral == 0
                ? bytes("")
                : _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, address(acct))
        });
        p.borrowAmount = borrow_;
        p.deadline = block.timestamp + 15 minutes;
    }

    function _open(uint256 collateral, uint256 borrow_, uint256 nonce) internal returns (uint256 hf) {
        bytes memory ret = _ownerExec(
            address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(collateral, borrow_, nonce)))
        );
        hf = abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------ the record

    function test_A4_anAccountThatNeverOpenedReadsZero() public view {
        assertEq(router.entryHfWad(address(acct)), 0, "0 = no record; the keeper runs the floor's ladder and says so");
    }

    function test_A4_anOpenRecordsTheEntryHfTheVenueMeasuredAndEmitsIt() public {
        uint256 borrow_ = _borrowFor(registry.maxOfferedLtvBps(address(cbbtc))); // 50 % → HF 1.56
        vm.expectEmit(true, false, false, false, address(router));
        emit StrategyRouter.EntryHfRecorded(address(acct), 0);
        uint256 hf = _open(ONE_CBBTC, borrow_, 1);
        assertEq(router.entryHfWad(address(acct)), hf, "the record is the returned health factor");
        assertEq(hf, aaveVenue.healthFactor(address(acct)), "which is the venue's own measurement");
        assertApproxEqAbs(hf, 1.56e18, 1e15, "LT 78 % over LTV 50 %");
        assertGe(hf, registry.entryHfFloorWad());
    }

    function test_A4_aTopUpRecordsTheNewEntryHf() public {
        _open(ONE_CBBTC, _borrowFor(3000), 2); // 30 % → HF 2.60
        assertApproxEqAbs(router.entryHfWad(address(acct)), 2.6e18, 1e15);
        // Borrow more against the collateral already there: the record moves to the new HF.
        uint256 hf2 = _open(0, _borrowFor(2000), 3); // 50 % in total → HF 1.56
        assertApproxEqAbs(hf2, 1.56e18, 1e15);
        assertEq(router.entryHfWad(address(acct)), hf2, "the last open is the record");
    }

    // ------------------------------------------------------------ the floor as a parameter

    /// The two worked rows of BUILD-PLAN §2b: with the registry floor at 1.25 a position opens at
    /// HF 1.30 (LTV 60 %) and at HF 1.25 (LTV 62.4 %) and each is recorded; at 63 % (HF 1.238) the
    /// venue refuses `EntryHfTooLow` and nothing is recorded. The rungs those records derive
    /// (1.27 / 1.19 / 1.11 / 1.05 and 1.23 / 1.16 / 1.09 / 1.05) are packages/shared `ladderFor`'s,
    /// pinned in packages/shared/test/health.test.ts and read by the keeper — not typed here.
    function test_A4_withTheFloorAt125_openAt130And125AreRecordedAndBelowTheFloorIsNot() public {
        vm.prank(registryOwner);
        registry.setEntryHfFloor(1.25e18);
        assertEq(registry.entryHfFloorWad(), 1.25e18);
        assertEq(
            registry.maxOfferedLtvBps(address(cbbtc)),
            5000,
            "the 50 % product cap still binds the OFFER on cbBTC at a 1.25 floor (62.4 % derived)"
        );

        uint256 hf130 = _open(ONE_CBBTC, _borrowFor(6000), 4);
        assertApproxEqAbs(hf130, 1.3e18, 1e15, "60 % LTV against LT 78 %");
        assertEq(router.entryHfWad(address(acct)), hf130);

        // A second account for the 1.25 row (the first one's debt would compound the numbers).
        (address bobAcct,) = _secondAccount();
        uint256 hf125 = _openAs(bobAcct, ONE_CBBTC, _borrowFor(6240), 5, false);
        assertApproxEqAbs(hf125, 1.25e18, 1e15, "62.4 % LTV against LT 78 % lands exactly on the floor");
        assertEq(router.entryHfWad(bobAcct), hf125);

        // Under the floor: the venue refuses by name, atomically, and the record is untouched.
        (address carolAcct,) = _thirdAccount();
        _openAs(carolAcct, ONE_CBBTC, _borrowFor(6300), 6, true);
        assertEq(router.entryHfWad(carolAcct), 0, "nothing recorded on a refused open");
    }

    // ------------------------------------------------------------ helpers: more accounts

    uint256 bobKey = 0xB0B;
    uint256 carolKey = 0xCA201;

    function _secondAccount() internal returns (address account, address owner_) {
        return _accountFor(bobKey);
    }

    function _thirdAccount() internal returns (address account, address owner_) {
        return _accountFor(carolKey);
    }

    function _accountFor(uint256 key) internal returns (address account, address owner_) {
        owner_ = vm.addr(key);
        account = factory.createAccount(owner_);
        cbbtc.mint(owner_, 10e8);
        vm.prank(owner_);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    /// `expectFloorRevert`: the venue must refuse `EntryHfTooLow`; the expectation is armed right
    /// before the account call so no view call in between is the one the cheatcode watches.
    function _openAs(address account, uint256 collateral, uint256 borrow_, uint256 nonce, bool expectFloorRevert)
        internal
        returns (uint256 hf)
    {
        address owner_ = payable(account) == payable(address(acct)) ? alice : _ownerOf(account);
        uint256 key = owner_ == vm.addr(bobKey) ? bobKey : carolKey;
        StrategyRouter.BorrowOnlyParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 20 minutes,
            signature: _signPermitWith(key, address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, account)
        });
        p.borrowAmount = borrow_;
        p.deadline = block.timestamp + 15 minutes;
        bytes memory data = abi.encodeCall(StrategyRouter.openBorrowOnly, (p));
        vm.prank(owner_);
        if (expectFloorRevert) {
            vm.expectPartialRevert(AaveV3Venue.EntryHfTooLow.selector);
            OilskinAccountLike(account).execWithCallback(address(router), 0, data);
            return 0;
        }
        bytes memory ret = OilskinAccountLike(account).execWithCallback(address(router), 0, data);
        hf = abi.decode(ret, (uint256));
    }

    function _ownerOf(address account) internal view returns (address) {
        return OilskinAccountLike(account).owner();
    }
}

interface OilskinAccountLike {
    function owner() external view returns (address);
    function execWithCallback(address target, uint256 value, bytes calldata data) external returns (bytes memory);
}
