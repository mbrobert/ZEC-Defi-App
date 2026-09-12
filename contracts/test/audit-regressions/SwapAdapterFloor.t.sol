// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";
import {AerodromeSwapAdapter} from "../../src/swap/AerodromeSwapAdapter.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";

/// @notice Audit wave 3, W3-LOW-6 (`docs/AUDIT-2026-09-11.md`): `AerodromeSwapAdapter` compared its
///         floor to the SwapRouter's RETURN VALUE while its NatSpec claimed the amount the account
///         actually received. The verified SwapRouter returns what it pays, so nothing was
///         exploitable through it — but the claim was false, and a probe on the unfixed adapter
///         (run first, then removed) showed a router paying 2 % short of what it returned sailing
///         through a 1 % floor. The floor is now on the account's `tokenOut` balance delta, as the
///         pool-direct adapter's has been since slice F.
contract SwapAdapterFloorTest is Fixture {
    function _swap(uint256 amountIn, uint256 quotedOut, uint16 bps) internal returns (bool ok, bytes memory ret) {
        bytes memory data = abi.encodeCall(
            ISwapAdapter.swap, (address(weth), address(usdc), amountIn, amountIn, quotedOut, bps, block.timestamp + 1, abi.encode(int24(100)))
        );
        vm.prank(alice);
        (ok, ret) = address(acct).call(abi.encodeCall(acct.execWithCallback, (address(swapAdapter), 0, data)));
    }

    /// A router that pays 2 % less than it returns is refused by the measured amount, by name.
    function test_W3_LOW_6_aRouterPayingShortOfItsReturnValueIsRefused() public {
        weth.mint(address(acct), 1e18);
        aeroRouter.setShortPayBps(200);
        uint256 quoted = aeroRouter.quote(address(weth), address(usdc), 1e18);
        uint256 paid = quoted - quoted * 200 / 10_000;
        uint256 floor = swapAdapter.minOutFor(1e18, 1e18, quoted, 100);
        (bool ok, bytes memory ret) = _swap(1e18, quoted, 100);
        assertFalse(ok, "refused");
        assertEq(ret, abi.encodeWithSelector(AerodromeSwapAdapter.InsufficientOutput.selector, paid, floor), "the MEASURED amount is what is named, not the router's number");
        assertEq(usdc.balanceOf(address(acct)), 0, "atomic: nothing moved");
        assertEq(weth.balanceOf(address(acct)), 1e18);
    }

    /// Inside the tolerance the measured shortfall passes, and the event carries the measured amount.
    function test_W3_LOW_6_aShortfallInsideTheToleranceIsPaidAndReportedAsMeasured() public {
        weth.mint(address(acct), 1e18);
        aeroRouter.setShortPayBps(50); // 0.5 %, under the 1 % floor
        uint256 quoted = aeroRouter.quote(address(weth), address(usdc), 1e18);
        uint256 paid = quoted - quoted * 50 / 10_000;
        (bool ok, bytes memory ret) = _swap(1e18, quoted, 100);
        assertTrue(ok);
        assertEq(abi.decode(abi.decode(ret, (bytes)), (uint256)), paid, "the adapter reports what the account received, not the router's number");
        assertEq(usdc.balanceOf(address(acct)), paid);
    }

    /// The router's unwind leg carries the same measurement: a lying router cannot get an unwind
    /// through the floor either.
    function test_W3_LOW_6_theUnwindLegIsMeasuredToo() public {
        cbbtc.mint(alice, 1e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        StrategyRouter.OpenParams memory p;
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = 1e8;
        p.permit = StrategyRouter.Permit2Pull({nonce: 1, deadline: block.timestamp + 1, signature: _signPermit(address(cbbtc), 1e8, 1, block.timestamp + 1, address(acct))});
        p.borrowAmount = 30_000e6;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 1;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (uint256 id,) = abi.decode(ret, (uint256, uint256));
        engine.setPendingFee(id, address(weth), 1e18); // a WETH leg to swap on the way out
        aeroRouter.setShortPayBps(200);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 1e18, quotedOut: 2453_450000, maxSlippageBps: 100, routeData: abi.encode(int24(100))});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 1;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        (bool ok, bytes memory res) = address(acct).call(abi.encodeCall(acct.execWithCallback, (address(router), 0, data)));
        assertFalse(ok, "the unwind is refused");
        assertEq(bytes4(res), AerodromeSwapAdapter.InsufficientOutput.selector, "by the adapter's floor, by name");
        uint256 measured;
        uint256 floor;
        assembly {
            measured := mload(add(res, 36))
            floor := mload(add(res, 68))
        }
        assertLt(measured, floor, "the MEASURED amount fell short of the floor");
        // `measured` is what the router paid: 2 % short of the number it returned.
        uint256 returned = measured * 10_000 / 9_800;
        assertGt(returned, floor, "the router's own number would have cleared the 1 % floor: that is exactly what the old check trusted");
    }
}
