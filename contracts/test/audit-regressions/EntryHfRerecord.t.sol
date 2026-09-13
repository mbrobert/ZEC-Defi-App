// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {IOilskinAccount, Call, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice FIX D9 (founder's decision, 2026-09-13) — the entry health factor is re-recorded by an
///         OWNER action that moves debt or collateral, and never by the keeper's.
///
/// WHAT IT WAS. `entryHfWad[account]` was written at every open and by nothing else, while a
/// withdrawal is gated only by the registry floor (1.25). So an owner who opened at HF 2.60 and
/// then legally withdrew collateral down to HF 1.26 kept the 2.60 ladder — warn 2.46, repay 1.64,
/// derisk 1.36 — and the keeper de-risked a position the owner had deliberately moved. Two
/// identical positions sitting at HF 1.26 were treated in opposite ways purely because of the
/// health factor each had been opened at; the more conservative opener was the one punished.
///
/// THE RULE NOW. After `unwind`, if the call moved debt or collateral (`repaid != 0 ||
/// withdrawn != 0`) and the caller is the OWNER, the record becomes the health factor the position
/// now stands at. Three things it must not do, each pinned below:
///   1. it must not fire for the KEEPER — a keeper that could rewrite the ladder it is judged
///      against would loosen its own bounds on every rung it fired;
///   2. it must not fire when the owner only closed liquidity positions, which moves neither debt
///      nor collateral: the health factor is then wherever the market has taken it, and recording
///      it would quietly relax the protection the owner chose, at the worst possible moment;
///   3. a position left with no debt has no entry to speak of — the record is cleared to 0, and the
///      next open writes a fresh one.
///
/// The ladders these records derive are packages/shared `ladderFor`'s, pinned in
/// packages/shared/test/health.test.ts — never typed here.
contract EntryHfRerecordRegressionTest is Fixture {
    uint256 constant ONE_CBBTC = 1e8;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    function _borrowFor(uint256 ltvBps) internal pure returns (uint256) {
        return (PRICE_CBBTC_E8 * ltvBps) / 10_000 / 100;
    }

    function _open(uint256 collateral, uint256 borrow_, uint256 nonce) internal returns (uint256 hf) {
        StrategyRouter.BorrowOnlyParams memory p;
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
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (p)));
        hf = abi.decode(ret, (uint256));
    }

    function _unwind(uint256 repayAmount, uint256 withdrawAmount)
        internal
        pure
        returns (StrategyRouter.UnwindParams memory u)
    {
        u.collateralAsset = address(0); // filled by the caller
        u.repayAmount = repayAmount;
        u.withdrawAmount = withdrawAmount;
    }

    function _ownerUnwind(uint256 repayAmount, uint256 withdrawAmount) internal returns (uint256 hf) {
        StrategyRouter.UnwindParams memory u = _unwind(repayAmount, withdrawAmount);
        u.collateralAsset = address(cbbtc);
        u.deadline = block.timestamp + 15 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (,,, hf) = abi.decode(ret, (uint256, uint256, uint256, uint256));
    }

    // ------------------------------------------------------- the defect, and the fix

    /// The exact scenario: open at 2.60, withdraw to just above the floor, and the record must
    /// follow the position instead of leaving a 2.60 ladder over an HF-1.26 account.
    function test_FIX_D9_anOwnerWithdrawalDownToTheFloorRerecordsTheEntry() public {
        uint256 entry = _open(ONE_CBBTC, _borrowFor(3000), 1); // 30 % LTV → HF 2.60
        assertApproxEqAbs(entry, 2.6e18, 1e15, "opened at 2.60");
        assertEq(router.entryHfWad(address(acct)), entry);

        // Withdraw a little over half the collateral. HF scales with what is left, so 51 % of one
        // cbBTC takes 2.60 down to about 1.27 — still above the 1.25 floor, which is exactly why
        // the router allows it. This is the owner's own, legal action; 52 % would revert
        // `ExitHfTooLow(1.248, 1.25)`, and the floor is the only thing standing in the way.
        uint256 hfAfter = _ownerUnwind(0, (ONE_CBBTC * 51) / 100);
        assertLt(hfAfter, 1.35e18, "the position now sits low");
        assertGe(hfAfter, registry.entryHfFloorWad(), "but above the floor, which is why it was allowed");
        assertEq(router.entryHfWad(address(acct)), hfAfter, "THE FIX: the record is where the owner put it");
        assertLt(router.entryHfWad(address(acct)), 1.35e18, "not the 2.60 it was opened at");
    }

    /// It is emitted, so the keeper's reader and the dashboard see it without a special case.
    function test_FIX_D9_theRerecordIsEmitted() public {
        _open(ONE_CBBTC, _borrowFor(3000), 2);
        vm.expectEmit(true, false, false, false, address(router));
        emit StrategyRouter.EntryHfRecorded(address(acct), 0);
        _ownerUnwind(0, (ONE_CBBTC * 51) / 100);
    }

    /// A repay moves it the other way: the founder's rule is "on any change", both directions.
    function test_FIX_D9_anOwnerRepayRaisesTheRecord() public {
        uint256 borrow_ = _borrowFor(5000); // HF ≈ 1.56
        uint256 entry = _open(ONE_CBBTC, borrow_, 3);
        assertApproxEqAbs(entry, 1.56e18, 2e15);

        // The account keeps the borrowed USDC, so it can hand some straight back.
        uint256 hfAfter = _ownerUnwind(borrow_ / 2, 0);
        assertGt(hfAfter, entry, "half the debt gone");
        assertEq(router.entryHfWad(address(acct)), hfAfter, "the record follows it up");
    }

    // ------------------------------------------------------- what must NOT re-record

    /// (1) The keeper's protective unwind moves debt too — and must leave the record alone. If it
    ///     did not, every rung the keeper fired would loosen the ladder it is judged against.
    function test_FIX_D9_theKEEPERsUnwindDoesNotRerecord() public {
        uint256 borrow_ = _borrowFor(5000);
        uint256 entry = _open(ONE_CBBTC, borrow_, 4);
        assertEq(router.entryHfWad(address(acct)), entry);

        TokenLimit[] memory limits = new TokenLimit[](1);
        limits[0] = TokenLimit(address(usdc), borrow_);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, limits, 0));

        StrategyRouter.UnwindParams memory u = _unwind(borrow_ / 2, 0);
        u.collateralAsset = address(cbbtc);
        u.deadline = block.timestamp + 15 minutes;
        vm.prank(keeper);
        acct.execAsKeeper(_one(_callP(address(router), abi.encodeCall(StrategyRouter.unwind, (u)))));

        assertLt(aaveVenue.debt(address(acct), address(usdc)), borrow_, "the keeper really did repay");
        assertEq(router.entryHfWad(address(acct)), entry, "and the record is untouched: the ladder still judges it");
    }

    /// (2) An unwind that moves neither debt nor collateral must not touch the record — otherwise a
    ///     drifted-down health factor would be written in as the new "entry" and the protection the
    ///     owner chose would quietly relax exactly when the market is against them.
    function test_FIX_D9_anUnwindThatMovesNothingLeavesTheRecordAlone() public {
        uint256 entry = _open(ONE_CBBTC, _borrowFor(5000), 5);
        _ownerUnwind(0, 0);
        assertEq(router.entryHfWad(address(acct)), entry, "no debt moved, no collateral moved, no re-record");
    }

    /// (3) Repaying everything leaves no entry to record: the record is cleared, and the keeper's
    ///     documented reading of 0 — run the registry floor's ladder — is what applies.
    function test_FIX_D9_clearingTheDebtClearsTheRecord() public {
        uint256 borrow_ = _borrowFor(5000);
        _open(ONE_CBBTC, borrow_, 6);
        uint256 hf = _ownerUnwind(borrow_, 0);
        assertEq(hf, type(uint256).max, "no debt: the venue reports an infinite health factor");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(router.entryHfWad(address(acct)), 0, "0 = no record, exactly as a never-opened account reads");
    }

    // ------------------------------------------------------- the seam the rule rests on

    /// The router tells the two apart by asking the account. Outside any call the slot is zero, so a
    /// stale read can never make an owner's action look like a keeper's.
    function test_FIX_D9_keeperActorIsZeroOutsideACall() public view {
        assertEq(IOilskinAccount(address(acct)).keeperActor(), address(0));
    }
}
