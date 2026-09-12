// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {Call, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice Audit wave 3, W3-LOW-7 (`docs/AUDIT-2026-09-11.md`): a re-grant inside a live period
///         carried the spend only of tokens present in BOTH the old and the new list, so a token
///         dropped in one re-grant and re-added in the next came back with its spend at zero — a
///         probe on the unfixed account (run first, then removed) moved 150 USDC in one period
///         against a 100-per-period line, through two owner re-grants. Every spend is now stamped
///         with the grant's spend generation; it counts until the period rolls (or the grant is
///         reissued from dead), listed again or not.
contract GrantCarryTest is Fixture {
    bytes4 constant SEL = IERC20.transfer.selector;

    function _grant(TokenLimit[] memory limits) internal {
        vm.prank(alice);
        acct.grant(keeper, _permPlain(address(usdc), SEL, limits, 0));
    }

    function _spend(uint256 amount) internal returns (bool ok, bytes memory ret) {
        Call[] memory c = new Call[](1);
        c[0] = Call(address(usdc), 0, abi.encodeCall(IERC20.transfer, (bob, amount)), false);
        vm.prank(keeper);
        (ok, ret) = address(acct).call(abi.encodeCall(acct.execAsKeeper, (c)));
    }

    function _spent() internal view returns (uint256 s) {
        (, s) = acct.tokenBudgetOf(keeper, address(usdc), SEL, address(usdc));
    }

    /// Dropped, then re-added inside the same period: the 50 already spent still counts, and the
    /// line still means 100 per period.
    function test_W3_LOW_7_aTokenDroppedAndReAddedInsideThePeriodKeepsItsSpend() public {
        usdc.mint(address(acct), 1_000e6);
        _grant(_limits1(address(usdc), 100e6));
        (bool ok, bytes memory ret) = _spend(50e6);
        assertTrue(ok);
        assertEq(_spent(), 50e6);
        _grant(_limits1(address(weth), 1e18)); // USDC dropped from the list
        assertEq(_spent(), 50e6, "the spend stays on the books while the token is not listed");
        _grant(_limits1(address(usdc), 100e6)); // USDC back, same period
        assertEq(_spent(), 50e6, "re-added: the 50 already spent still counts (on fabf8b6 it read 0)");
        (ok, ret) = _spend(60e6);
        assertFalse(ok, "60 more would be 110 in the period");
        assertEq(ret, abi.encodeWithSelector(OilskinAccount.TokenBudgetExceeded.selector, address(usdc), 60e6, 50e6));
        (ok,) = _spend(50e6);
        assertTrue(ok);
        assertEq(usdc.balanceOf(bob), 100e6, "100 per period means 100");
        (ok,) = _spend(1);
        assertFalse(ok, "and not one unit more");
    }

    /// The period roll clears every spend, a token no longer listed included.
    function test_W3_LOW_7_theRollClearsTheSpendOfATokenNoLongerListed() public {
        usdc.mint(address(acct), 1_000e6);
        _grant(_limits1(address(usdc), 100e6));
        (bool ok,) = _spend(100e6);
        assertTrue(ok);
        _grant(_limits1(address(weth), 1e18)); // dropped with 100 spent
        vm.warp(block.timestamp + 1 days); // the period rolls
        _grant(_limits1(address(usdc), 100e6)); // re-added in the NEXT period
        assertEq(_spent(), 0, "a new period starts clean");
        (ok,) = _spend(100e6);
        assertTrue(ok);
        assertEq(usdc.balanceOf(bob), 200e6, "100 in each of two periods");
    }

    /// Unchanged: a grant reissued from dead (revoked) inside the period starts clean — the owner's
    /// deliberate reset, as before wave 3 — and the stamp keeps an OLDER dead spend from leaking
    /// into the new grant after a later roll.
    function test_W3_LOW_7_aGrantReissuedFromDeadStartsCleanAsBefore() public {
        usdc.mint(address(acct), 1_000e6);
        _grant(_limits1(address(usdc), 100e6));
        (bool ok,) = _spend(100e6);
        assertTrue(ok);
        vm.prank(alice);
        acct.revoke(keeper, address(usdc), SEL);
        _grant(_limits1(address(usdc), 100e6)); // reissued inside the period
        assertEq(_spent(), 0, "reissued from dead: clean, as before");
        (ok,) = _spend(30e6);
        assertTrue(ok);
        assertEq(_spent(), 30e6);
        vm.warp(block.timestamp + 1 days);
        assertEq(_spent(), 0, "the view applies the roll");
        (ok,) = _spend(100e6);
        assertTrue(ok, "a full line in the new period: neither the 100 nor the 30 leaked forward");
    }
}
