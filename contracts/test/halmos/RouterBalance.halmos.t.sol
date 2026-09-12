// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";

/// @title Halmos property — "the router's balance of every token is unchanged across every call"
///        (slice H, 2026-09-11). A bounded attempt: the router's `unwind` walks the registry's venue
///        list and nests into mocks (Aave, Morpho, the engine, the swap router), so halmos needs a
///        loop bound and unrolls every external call symbolically. Expected to be slow or to time
///        out on the full tree; recorded in `AUDIT-2026-09-11.md` §Slice H as what was proved and
///        what was out of reach.
///
/// Run:   cd contracts && halmos --contract RouterBalanceHalmos --loop 3 --solver-timeout-assertion 0
contract RouterBalanceHalmos is Fixture {
    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
    }

    /// For every repay and withdraw amount, an `unwind` with no ids either reverts or leaves the
    /// router holding exactly what it held (a donation of `dust` first makes the delta property
    /// bite: the router must hold `dust` after, never 0 and never more).
    function check_unwindLeavesRouterBalanceUnchanged(uint256 repay, uint256 withdraw, uint96 dust) public {
        // A book on Aave: 1 cbBTC, 30k USDC, the USDC idle in the account.
        StrategyRouter.BorrowOnlyParams memory b;
        b.collateralAsset = address(cbbtc);
        b.collateralAmount = 1e8;
        b.permit = StrategyRouter.Permit2Pull({nonce: 1, deadline: block.timestamp + 1, signature: _signPermit(address(cbbtc), 1e8, 1, block.timestamp + 1, address(acct))});
        b.borrowAmount = 30_000e6;
        b.deadline = block.timestamp + 1;
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (b)));
        usdc.mint(address(router), dust);
        cbbtc.mint(address(router), dust);
        uint256 u0 = usdc.balanceOf(address(router));
        uint256 c0 = cbbtc.balanceOf(address(router));

        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 0, quotedOut: 0, maxSlippageBps: 0, routeData: ""});
        u.repayAmount = repay;
        u.withdrawAmount = withdraw;
        u.deadline = block.timestamp + 1;
        vm.prank(alice);
        (bool ok,) = address(acct).call(abi.encodeCall(acct.execWithCallback, (address(router), 0, abi.encodeCall(StrategyRouter.unwind, (u)))));
        ok; // revert or not, the router's balances did not move
        assert(usdc.balanceOf(address(router)) == u0);
        assert(cbbtc.balanceOf(address(router)) == c0);
    }
}
