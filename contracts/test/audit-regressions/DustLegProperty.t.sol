// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceBand} from "../../src/interfaces/ILpVenue.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AerodromeSwapAdapter} from "../../src/swap/AerodromeSwapAdapter.sol";
import {MockAerodromeSwapRouter} from "../mocks/MockAerodromeSwapRouter.sol";

/// @notice NI-HIGH-1 as a PROPERTY (slice O, 2026-09-13; `AUDIT-2026-09-12.md` "Properties"), not the
///         four cases of `DustLegClose.t.sol`: for ANY leg amount and ANY quote the router accepts —
///         any `quotedIn`, any `quotedOut` inside the band, any tolerance up to the adapter's cap —
///         `StrategyRouter._toUsdc` does exactly one of two things. Either the adapter's floor for the
///         leg is at least one USDC unit and the swap is ATTEMPTED under that floor (it then succeeds,
///         paying USDC into the account and leaving no token behind, or the adapter refuses it by name
///         with that same floor in the error — never a zero floor), or the floor is zero and the leg is
///         KEPT: one `DustLegKept(account, token, amount)`, the token balance in the account exactly the
///         leg, nothing swapped. The boundary between the two is the adapter's own `minOutFor`, never a
///         number of the router's.
contract DustLegPropertyTest is Fixture {
    uint256 constant COLLATERAL = 1e8;
    uint256 constant BORROW = 30_000e6;
    /// The fixture's mock router pays 2,453.45 USDC per WETH; the pool's band is ±10 % on the sqrt
    /// price (≈ ±21 % on the price), so every quoted price in [0.82, 1.20] × that is inside the band.
    uint256 constant ROUTER_USDC_PER_WETH = 2453_450000;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
        weth.mint(address(aave), 1_000e18);
        aero.mint(address(engine), 1_000_000e18);
    }

    function _open(uint256 nonce) internal view returns (StrategyRouter.OpenParams memory p) {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = COLLATERAL;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 10 minutes,
            signature: _signPermit(address(cbbtc), COLLATERAL, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = BORROW;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
    }

    /// An open LP with `feeWei` of WETH pending on it and the account funded to cover its whole debt.
    function _openWithWethFee(uint256 feeWei) internal returns (uint256 id) {
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (_open(1))));
        (id,) = abi.decode(ret, (uint256, uint256));
        engine.setPendingFee(id, address(weth), feeWei);
        uint256 debt = aaveVenue.debt(address(acct), address(usdc));
        uint256 held = usdc.balanceOf(address(acct));
        if (debt > held) usdc.mint(address(acct), debt - held);
    }

    function _logs(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 n, Vm.Log memory last) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) {
                n++;
                last = logs[i];
            }
        }
    }

    /// For every leg and every accepted quote: swapped under a floor ≥ 1, or kept with the balance untouched.
    function testFuzz_PROP_NI1_everyLegIsSwappedUnderAFloorOfAtLeastOneUnitOrKeptUntouched(
        uint256 feeWei,
        uint256 quotedIn,
        uint256 priceBps,
        uint16 maxSlippageBps
    ) public {
        feeWei = bound(feeWei, 1, 1e15); // 1 wei … 0.001 WETH: both sides of the floor at every quote shape
        quotedIn = bound(quotedIn, 1e12, 1e24); // 1e-6 … 1,000,000 WETH of quoted input (three significant digits of USDC out)
        priceBps = bound(priceBps, 8200, 12000); // the quoted price as a share of the mock's, inside the band
        maxSlippageBps = uint16(bound(maxSlippageBps, 0, swapAdapter.MAX_SLIPPAGE_BPS()));
        uint256 quotedOut = (quotedIn * ROUTER_USDC_PER_WETH * priceBps) / (10_000 * 1e18);
        vm.assume(quotedOut > 0); // a quote with no numbers is the adapter's ZeroQuote, a different case
        // Only quotes the router ACCEPTS: the price the quote implies must sit inside the band (the
        // router's own `_requireQuoteInBand`, G-MED-1) - rounding at the edges is not this property.
        PriceBand memory band = _band(poolWethUsdc, 1000);
        {
            uint256 impliedSqrt = Math.sqrt(Math.mulDiv(quotedOut, 2 ** 192, quotedIn)); // WETH is token0 of the mock pool
            vm.assume(impliedSqrt >= band.minSqrtPriceX96 && impliedSqrt <= band.maxSqrtPriceX96);
        }
        uint256 net = feeWei - (feeWei * PERF_BPS) / 10_000;

        uint256 id = _openWithWethFee(feeWei);
        uint256 floor = swapAdapter.minOutFor(net, quotedIn, quotedOut, maxSlippageBps);
        bool expectKept = floor == 0;
        uint256 usdcBefore = usdc.balanceOf(address(acct));

        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = new uint256[](1);
        u.positionIds[0] = id;
        u.band = band;
        u.swap = StrategyRouter.SwapQuote({quotedIn: quotedIn, quotedOut: quotedOut, maxSlippageBps: maxSlippageBps, routeData: abi.encode(int24(100))});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = type(uint256).max;
        u.deadline = block.timestamp + 10 minutes;

        vm.recordLogs();
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(acct).call(
            abi.encodeCall(acct.execWithCallback, (address(router), 0, abi.encodeCall(StrategyRouter.unwind, (u))))
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 kept, Vm.Log memory keptLog) = _logs(logs, address(router), keccak256("DustLegKept(address,address,uint256)"));
        (uint256 swapped, Vm.Log memory swapLog) = _logs(logs, address(swapAdapter), keccak256("Swapped(address,address,address,uint256,uint256,uint256)"));

        if (expectKept) {
            assertTrue(ok, "a kept leg never fails the unwind");
            assertEq(kept, 1, "exactly one DustLegKept for the one dust leg");
            assertEq(address(uint160(uint256(keptLog.topics[1]))), address(acct), "DustLegKept.account");
            assertEq(address(uint160(uint256(keptLog.topics[2]))), address(weth), "DustLegKept.token");
            assertEq(abi.decode(keptLog.data, (uint256)), net, "DustLegKept.amount is the whole leg");
            assertEq(swapped, 0, "nothing was swapped");
            assertEq(weth.balanceOf(address(acct)), net, "the leg stays in the account, untouched");
            assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "and the Close still cleared the debt");
        } else if (ok) {
            assertEq(kept, 0, "a priceable leg is never kept");
            assertEq(swapped, 1, "one swap for the one leg");
            assertEq(address(uint160(uint256(swapLog.topics[2]))), address(weth), "Swapped.tokenIn");
            (uint256 amountIn, uint256 amountOut, uint256 minOut) = abi.decode(swapLog.data, (uint256, uint256, uint256));
            assertEq(amountIn, net, "the whole leg was swapped");
            assertGe(minOut, 1, "the enforced floor is at least one USDC unit");
            assertEq(minOut, floor, "the enforced floor is the adapter's own");
            assertGe(amountOut, minOut, "the adapter enforced it");
            assertEq(weth.balanceOf(address(acct)), 0, "no WETH left behind");
            assertGe(usdc.balanceOf(address(acct)), usdcBefore, "the USDC came back to the account");
        } else {
            // The swap was ATTEMPTED under a real floor and refused for it - a quote above what the
            // router pays. The adapter hands its floor to the router as `amountOutMinimum`, so the
            // refusal is the router's own `TooLittleReceived()` (the verified SwapRouter refuses the
            // same way); it can only fire when that minimum exceeds what the router pays, i.e. when
            // the floor is at least one unit - a zero floor never reaches the router. Should the
            // router pay short instead (W3-LOW-6), the adapter's `InsufficientOutput` names the floor.
            bytes4 sel;
            assembly ("memory-safe") { sel := mload(add(ret, 32)) }
            assertGe(floor, 1, "a refused swap was attempted under a floor of at least one unit");
            if (sel == MockAerodromeSwapRouter.TooLittleReceived.selector) {
                assertLt(aeroRouter.quote(address(weth), address(usdc), net), floor, "the router pays less than the adapter's floor");
            } else {
                assertEq(sel, AerodromeSwapAdapter.InsufficientOutput.selector, "the only other refusal a real floor allows");
                bytes memory args = new bytes(ret.length - 4);
                for (uint256 i = 0; i < args.length; i++) args[i] = ret[i + 4];
                (uint256 amountOut, uint256 minOut) = abi.decode(args, (uint256, uint256));
                assertEq(minOut, floor, "the floor the adapter refused under is its own");
                assertLt(amountOut, minOut);
            }
            assertEq(kept, 0, "a refused swap is never a kept leg");
        }
        assertEq(weth.balanceOf(address(router)), 0, "the router holds nothing");
        assertEq(weth.balanceOf(address(swapAdapter)), 0, "the adapter holds nothing");
    }
}
