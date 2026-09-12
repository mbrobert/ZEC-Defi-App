// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ILpVenue, LpOpenParams} from "../../src/interfaces/ILpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";

/// @notice Audit wave 3, W3-LOW-1 (`docs/AUDIT-2026-09-11.md`): the engine's ids and the Slipstream
///         position manager's are independent counters. `StrategyRouter._lpVenueForIds` asked the
///         engine venue first and routed the whole batch to it whenever it owned the first id, so
///         an account owning engine id N AND Slipstream token N had a plan meant for the direct
///         pool close engine position N instead — and the keeper's `confirm` saw closes and a
///         repay, and CONFIRMED. Both venues are now asked; an id both claim is refused by name.
contract LpVenueRoutingTest is Fixture {
    uint256 constant DEPOSIT = 10_000e6;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
    }

    /// Engine id 1 and Slipstream token 1, both the account's — on a fresh fixture both counters
    /// start at 1, which is exactly the collision the residual described.
    function _collide() internal returns (uint256 engineId, uint256 directId) {
        usdc.mint(address(acct), 2 * DEPOSIT);
        bytes memory ret = _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_WETH_USDC, 0, DEPOSIT, poolWethUsdc))));
        engineId = abi.decode(ret, (uint256));
        ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_ID_DIRECT, DEPOSIT, 0, poolCbzecUsdc))));
        directId = abi.decode(ret, (uint256));
        assertEq(engineId, directId, "the same number on both venues");
        (, bool e) = lpVenue.ownedPool(engineId, address(acct));
        (, bool d) = directVenue.ownedPool(directId, address(acct));
        assertTrue(e && d, "both venues say the account owns it");
    }

    function _unwind(uint256[] memory ids, bool directQuote) internal view returns (StrategyRouter.UnwindParams memory u) {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = directQuote ? _band(poolCbzecUsdc, 1000) : _band(poolWethUsdc, 1000);
        u.swap = directQuote
            ? StrategyRouter.SwapQuote({quotedIn: 1e8, quotedOut: 1_000_000_000, maxSlippageBps: 100, routeData: abi.encode(int24(200))})
            : StrategyRouter.SwapQuote({quotedIn: 1e18, quotedOut: 2453_450000, maxSlippageBps: 100, routeData: abi.encode(int24(100))});
        u.repayAmount = 0;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 15 minutes;
    }

    /// The colliding id is refused by name — never silently routed to the engine's.
    function test_W3_LOW_1_anIdBothVenuesClaimIsRefusedByName() public {
        (uint256 id,) = _collide();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (_unwind(ids, true)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.AmbiguousPositionId.selector, id));
        acct.execWithCallback(address(router), 0, data);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1, "nothing closed on the engine");
        assertEq(directVenue.positionsOf(address(acct)).length, 1, "nothing closed on the direct venue");
    }

    /// Each venue's own `close` still reaches its position: once the direct one is closed there,
    /// the router routes the same number to the engine without ambiguity.
    function test_W3_LOW_1_theVenuesOwnCloseResolvesIt() public {
        (uint256 id,) = _collide();
        _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.close, (id, _band(poolCbzecUsdc, 1000))));
        assertEq(directVenue.positionsOf(address(acct)).length, 0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (_unwind(ids, false))));
        (uint256 usdcFromLp,,,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertGt(usdcFromLp, 0, "the engine position closed through the router");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
    }

    /// A batch whose FIRST id is a stranger's (owned by neither) still resolves on the first owned
    /// id, as before; distinct numbers route to their own venue.
    function test_W3_LOW_1_distinctIdsRouteToTheirOwnVenue() public {
        usdc.mint(address(acct), 3 * DEPOSIT);
        _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_WETH_USDC, 0, DEPOSIT, poolWethUsdc)))); // engine 1
        bytes memory ret = _ownerExec(address(lpVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_WETH_USDC, 0, DEPOSIT, poolWethUsdc)))); // engine 2
        uint256 engine2 = abi.decode(ret, (uint256));
        ret = _ownerExec(address(directVenue), abi.encodeCall(ILpVenue.open, (_openParams(POOL_ID_DIRECT, DEPOSIT, 0, poolCbzecUsdc)))); // direct 1
        uint256 direct1 = abi.decode(ret, (uint256));
        assertEq(engine2, 2);
        assertEq(direct1, 1);
        // [999 (nobody's), 2 (engine)] → the engine; 1 collides and is not in this batch.
        uint256[] memory ids = new uint256[](2);
        ids[0] = 999;
        ids[1] = engine2;
        ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (_unwind(ids, false))));
        (uint256 usdcFromLp,,,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertGt(usdcFromLp, 0);
        assertEq(lpVenue.positionsOf(address(acct)).length, 1, "engine 1 stays; engine 2 closed; 999 reported failed");
        assertEq(directVenue.positionsOf(address(acct)).length, 1, "the direct position untouched");
    }
}
