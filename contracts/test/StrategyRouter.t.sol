// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccount} from "../src/account/OilskinAccount.sol";
import {Call} from "../src/interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../src/interfaces/ICollateralVenue.sol";
import {ILpVenue, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {AerodromeSwapAdapter} from "../src/swap/AerodromeSwapAdapter.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockAerodromeSwapRouter} from "./mocks/MockAerodromeSwapRouter.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";
import {IAerodromeSwapRouter} from "../src/interfaces/IAerodromeSwapRouter.sol";

contract StrategyRouterTest is Fixture {
    uint256 constant COLLATERAL = 1e8; // 1 cbBTC ≈ $79,594
    uint256 constant BORROW = 30_000e6; // ≈ 37.7 % LTV → HF ≈ 2.07

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        vm.prank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
    }

    function _open(uint256 collateral, uint256 borrow, uint256 nonce)
        internal
        view
        returns (StrategyRouter.OpenParams memory p)
    {
        p.collateralAsset = address(cbbtc);
        p.collateralAmount = collateral;
        p.permit = StrategyRouter.Permit2Pull({
            nonce: nonce,
            deadline: block.timestamp + 10 minutes,
            signature: collateral == 0
                ? bytes("")
                : _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
    }

    function _openViaAccount(StrategyRouter.OpenParams memory p)
        internal
        returns (uint256 id, uint256 hf)
    {
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id, hf) = abi.decode(ret, (uint256, uint256));
    }

    function _unwind(uint256[] memory ids, uint256 repay, uint256 withdraw)
        internal
        view
        returns (StrategyRouter.UnwindParams memory u)
    {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolWethUsdc, 1000);
        u.swapMinOut = 1;
        u.swapRouteData = abi.encode(int24(100));
        u.repayAmount = repay;
        u.withdrawAmount = withdraw;
        u.deadline = block.timestamp + 10 minutes;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router holds USDC");
        assertEq(cbbtc.balanceOf(address(router)), 0, "router holds cbBTC");
        assertEq(weth.balanceOf(address(router)), 0, "router holds WETH");
        assertEq(address(router).balance, 0);
    }

    // ------------------------------------------------------------------ open

    function test_openLeveragedLp_fullFlow() public {
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        vm.expectEmit(true, true, true, false);
        emit StrategyRouter.LeveragedLpOpened(address(acct), address(cbbtc), COLLATERAL, BORROW, POOL_WETH_USDC, 1, 0);
        (uint256 id, uint256 hf) = _openViaAccount(p);

        assertEq(id, 1);
        assertEq(cbbtc.balanceOf(alice), 9e8, "Permit2 pulled exactly the collateral");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), COLLATERAL, "collateral under the account");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW, "debt under the account");
        assertEq(hf, aaveVenue.healthFactor(address(acct)));
        assertGe(hf, ENTRY_HF_FLOOR_WAD);
        assertApproxEqRel(hf, (PRICE_CBBTC_E8 * CBBTC_LT / 10_000 * 1e18) / (BORROW * 100), 1e14);
        (, address owner) = lpVenue.poolOf(id);
        assertEq(owner, address(acct), "LP id minted to the account");
        (uint256 a0, uint256 a1) = engine.positionAmounts(id);
        assertEq(a0, 0);
        assertEq(a1, BORROW, "all borrowed USDC deployed single-sided");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(cbbtc.balanceOf(address(acct)), 0);
        assertEq(cbbtc.allowance(address(acct), address(aave)), 0);
        assertEq(usdc.allowance(address(acct), address(engine)), 0);
        _assertRouterEmpty();
    }

    function test_openLeveragedLp_firstTimeUserInOneTransaction() public {
        uint256 bobKey = 0xB0B;
        address bobEoa = vm.addr(bobKey);
        address predicted = factory.accountOf(bobEoa);
        cbbtc.mint(bobEoa, 1e8);
        vm.prank(bobEoa);
        cbbtc.approve(address(permit2), type(uint256).max);

        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 7);
        p.permit.signature =
            _signPermitWith(bobKey, address(cbbtc), COLLATERAL, 7, block.timestamp + 10 minutes, predicted);
        Call[] memory calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p))));
        vm.prank(bobEoa);
        (address account,) = factory.createAccountAndExec(calls);
        assertEq(account, predicted);
        assertEq(aaveVenue.collateral(account, address(cbbtc)), COLLATERAL);
        assertEq(aaveVenue.debt(account, address(usdc)), BORROW);
        (, address owner) = lpVenue.poolOf(1);
        assertEq(owner, account);
        _assertRouterEmpty();
    }

    function test_openLeveragedLp_entryHfFloorEnforced() public {
        // 55 % LTV → HF = 0.78 / 0.55 = 1.418 < 1.55 → refused even though Aave (LTV 73 %) allows it.
        uint256 borrow = (PRICE_CBBTC_E8 * 55) / 100 / 100;
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, borrow, 1);
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(); // EntryHfTooLow(hf, floor) — hf value is data-dependent
        acct.exec(address(router), 0, data);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "atomic: nothing borrowed");
        assertEq(cbbtc.balanceOf(alice), 10e8, "atomic: nothing pulled");
        // exactly the offered maximum (50 %) passes: HF 1.56
        borrow = (PRICE_CBBTC_E8 * registry.maxOfferedLtvBps(address(cbbtc))) / 10_000 / 100;
        p = _open(COLLATERAL, borrow, 1);
        (, uint256 hf) = _openViaAccount(p);
        assertGe(hf, ENTRY_HF_FLOOR_WAD);
        assertApproxEqRel(hf, 1.56e18, 1e14);
    }

    function test_openLeveragedLp_disabledAssetReverts() public {
        StrategyRouter.OpenParams memory p = _open(0, 1_000e6, 1);
        p.collateralAsset = address(cbzec);
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyRouter.AssetDisabled.selector, address(cbzec), "no collateral market on Base yet"
            )
        );
        acct.exec(address(router), 0, data);
        p.collateralAsset = address(aero);
        data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.AssetNotRegistered.selector, address(aero)));
        acct.exec(address(router), 0, data);
    }

    function test_openLeveragedLp_poolMustContainUsdc() public {
        bytes32 pid = keccak256("aero-WETH-cbBTC");
        MockCLPool pool = new MockCLPool(address(weth), address(cbbtc), 100, 500, poolWethUsdc.sqrtPriceX96());
        engine.addPool(pid, address(pool), address(weth), address(cbbtc), 500);
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        p.poolId = pid;
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.PoolWithoutUsdc.selector, pid));
        acct.exec(address(router), 0, data);
    }

    function test_openLeveragedLp_deadlineAndZeroBorrow() public {
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        p.deadline = block.timestamp - 1;
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        acct.exec(address(router), 0, data);
        p = _open(COLLATERAL, 0, 1);
        data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.ZeroBorrow.selector);
        acct.exec(address(router), 0, data);
    }

    function test_openLeveragedLp_bandProtectsTheDeposit() public {
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        uint256 price = poolWethUsdc.sqrtPriceX96();
        poolWethUsdc.setSqrtPrice(uint160((price * 115) / 100)); // moved 15 % after the quote
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert();
        acct.exec(address(router), 0, data);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "nothing borrowed when the LP leg fails");
    }

    function test_openLeveragedLp_againstExistingCollateralNoPermit() public {
        cbbtc.mint(address(acct), 1e8);
        _ownerExec(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), 1e8)));
        StrategyRouter.OpenParams memory p = _open(0, BORROW, 1);
        (uint256 id,) = _openViaAccount(p);
        assertEq(id, 1);
        assertEq(cbbtc.balanceOf(alice), 10e8, "nothing pulled from the wallet");
    }

    function test_openLeveragedLp_accountAlreadyHoldingCollateralNeedsNoSignature() public {
        cbbtc.mint(address(acct), 1e8);
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        p.permit.signature = "";
        _openViaAccount(p);
        assertEq(cbbtc.balanceOf(alice), 10e8);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 1e8);
    }

    function test_permit2_wrongSpenderOrReusedNonceReverts() public {
        // signed for the router as spender — the account is the spender, so it must fail
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        p.permit.signature =
            _signPermit(address(cbbtc), COLLATERAL, 1, block.timestamp + 10 minutes, address(router));
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        vm.expectRevert(MockPermit2.InvalidSigner.selector);
        acct.exec(address(router), 0, data);

        _openViaAccount(_open(COLLATERAL, BORROW, 1));
        data = abi.encodeCall(StrategyRouter.openLeveragedLp, (_open(COLLATERAL, BORROW, 1)));
        vm.prank(alice);
        vm.expectRevert(MockPermit2.InvalidNonce.selector);
        acct.exec(address(router), 0, data);
    }

    // ---------------------------------------------------------------- unwind

    function test_unwind_fullRoundTrip() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        engine.setPendingFee(id, address(weth), 0.5e18); // a WETH leg comes back too
        aave.accrueDebt(address(acct), address(usdc), 50); // +0.5 % interest
        uint256 debt = aaveVenue.debt(address(acct), address(usdc));

        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), type(uint256).max, type(uint256).max);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid, uint256 withdrawn, uint256 hf) =
            abi.decode(ret, (uint256, uint256, uint256, uint256));

        uint256 wethNet = 0.45e18; // 0.5 − 10 % fee
        uint256 swapped = aeroRouter.quote(address(weth), address(usdc), wethNet);
        assertEq(usdcFromLp, BORROW + swapped);
        assertEq(repaid, debt);
        assertEq(withdrawn, COLLATERAL);
        assertEq(hf, type(uint256).max);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0);
        assertEq(cbbtc.balanceOf(address(acct)), COLLATERAL);
        assertEq(usdc.balanceOf(address(acct)), BORROW + swapped - debt, "surplus stays in the account");
        assertEq(weth.balanceOf(address(acct)), 0, "non-USDC leg swapped back");
        assertEq(weth.balanceOf(treasury), 0.05e18, "fee only on the realised WETH");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        assertEq(usdc.allowance(address(acct), address(aave)), 0);
        assertEq(weth.allowance(address(acct), address(aeroRouter)), 0);
        _assertRouterEmpty();
    }

    function test_unwind_worksOnADisabledAsset() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "delisted");
        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(cbbtc.balanceOf(address(acct)), COLLATERAL, "exit never gated on enabled");
    }

    function test_unwind_repayOnlyKeepsCollateral() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        uint256 hf0 = aaveVenue.healthFactor(address(acct));
        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), 10_000e6, 0);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (,uint256 repaid, uint256 withdrawn, uint256 hf) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(repaid, 10_000e6);
        assertEq(withdrawn, 0);
        assertGt(hf, hf0);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW - 10_000e6);
        assertEq(usdc.balanceOf(address(acct)), BORROW - 10_000e6, "rest of the LP proceeds held");
        _assertRouterEmpty();
    }

    function test_unwind_withdrawBelowFloorReverts() public {
        _openViaAccount(_open(COLLATERAL, BORROW, 1));
        uint256[] memory none;
        StrategyRouter.UnwindParams memory u = _unwind(none, 0, 0.6e8); // keeps debt, halves collateral
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(); // ExitHfTooLow
        acct.exec(address(router), 0, data);
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), COLLATERAL);
        // a withdraw that keeps HF ≥ floor passes
        u = _unwind(none, 0, 0.1e8);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        assertEq(cbbtc.balanceOf(address(acct)), 0.1e8);
    }

    function test_unwind_swapMinOutEnforced() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        engine.setPendingFee(id, address(weth), 1e18);
        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), 0, 0);
        u.swapMinOut = 10_000e6; // 0.9 WETH is worth ~2208 USDC
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(MockAerodromeSwapRouter.TooLittleReceived.selector);
        acct.exec(address(router), 0, data);
        u.swapMinOut = 0;
        data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(AerodromeSwapAdapter.ZeroMinOut.selector);
        acct.exec(address(router), 0, data);
    }

    function test_unwind_skipsRefusedIdsAndReports() public {
        (uint256 a,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        usdc.mint(address(acct), 1_000e6);
        uint256 b = abi.decode(
            _ownerExec(
                address(lpVenue),
                abi.encodeCall(ILpVenue.increase, (a, 0, 1_000e6, _band(poolWethUsdc, 1000), block.timestamp + 60))
            ),
            (uint256)
        );
        engine.setWithdrawRefused(b, true);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        StrategyRouter.UnwindParams memory u = _unwind(ids, 0, 0);
        vm.expectEmit(true, true, false, true);
        emit StrategyRouter.LeveragedLpUnwound(
            address(acct), address(cbbtc), 1, 1, BORROW, 0, 0, aaveVenue.healthFactor(address(acct))
        );
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp,,,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(usdcFromLp, BORROW, "what closed was paid");
        uint256[] memory left = lpVenue.positionsOf(address(acct));
        assertEq(left.length, 1);
        assertEq(left[0], b, "the refused id is still the account's");
        _assertRouterEmpty();
    }

    function test_unwind_deadline() public {
        uint256[] memory none;
        StrategyRouter.UnwindParams memory u = _unwind(none, 0, 0);
        u.deadline = block.timestamp - 1;
        bytes memory data = abi.encodeCall(StrategyRouter.unwind, (u));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        acct.exec(address(router), 0, data);
    }

    function test_unwind_byKeeperWithinGrant() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        engine.setPendingFee(id, address(weth), 0.5e18);
        // The ladder's "repay" rung: close the LP, swap, repay half. Token ops in the tree:
        // WETH fee transfer (0.05) + WETH approve for the swap (0.45) = 0.5 WETH; USDC approve for
        // the repay (15k). Budget exactly that.
        vm.prank(alice);
        acct.grant(
            keeper,
            _perm(
                address(router),
                StrategyRouter.unwind.selector,
                _limits2(address(usdc), 15_000e6, address(weth), 0.5e18),
                0
            )
        );
        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), 15_000e6, 0);
        Call[] memory calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.unwind, (u))));
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), BORROW - 15_000e6);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(weth.balanceOf(keeper), 0);
        // Over budget: a second repay of 1 USDC in the same period is refused.
        u = _unwind(new uint256[](0), 1, 0);
        calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.unwind, (u))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
    }

    function test_keeperCannotOpenWithoutGrant() public {
        StrategyRouter.OpenParams memory p = _open(0, BORROW, 1);
        Call[] memory calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
    }

    // ----------------------------------------------------------------- sweep

    function test_sweepPaysTheOwnerOnly() public {
        (uint256 id,) = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        engine.setPendingFee(id, address(weth), 1e18);
        StrategyRouter.UnwindParams memory u = _unwind(_ids(id), type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        address[] memory toks = new address[](3);
        (toks[0], toks[1], toks[2]) = (address(usdc), address(cbbtc), address(weth));
        uint256 u0 = usdc.balanceOf(address(acct));
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.sweep, (toks)));
        assertEq(usdc.balanceOf(alice), u0);
        assertEq(cbbtc.balanceOf(alice), 10e8);
        assertEq(usdc.balanceOf(address(acct)), 0);
        _assertRouterEmpty();
    }

    function test_routerCannotBeCalledFromAnEoa() public {
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, BORROW, 1);
        vm.prank(alice);
        vm.expectRevert();
        router.openLeveragedLp(p);
        assertEq(cbbtc.balanceOf(alice), 10e8);
    }

    function test_routerConstructorRejectsZero() public {
        vm.expectRevert(StrategyRouter.ZeroAddress.selector);
        new StrategyRouter(registry, lpVenue, swapAdapter, permit2, address(0));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_openRespectsFloorAndRouterHoldsNothing(uint256 borrow) public {
        borrow = bound(borrow, 1e6, (PRICE_CBBTC_E8 * 70) / 100 / 100);
        StrategyRouter.OpenParams memory p = _open(COLLATERAL, borrow, 1);
        uint256 expectedHf = (PRICE_CBBTC_E8 * CBBTC_LT / 10_000 * 1e18) / (borrow * 100);
        bytes memory data = abi.encodeCall(StrategyRouter.openLeveragedLp, (p));
        vm.prank(alice);
        if (expectedHf < ENTRY_HF_FLOOR_WAD) {
            vm.expectRevert();
            acct.exec(address(router), 0, data);
            assertEq(aaveVenue.debt(address(acct), address(usdc)), 0);
        } else {
            acct.exec(address(router), 0, data);
            assertGe(aaveVenue.healthFactor(address(acct)), ENTRY_HF_FLOOR_WAD);
        }
        _assertRouterEmpty();
    }
}

contract AerodromeSwapAdapterTest is Fixture {
    function setUp() public override {
        super.setUp();
        usdc.mint(address(acct), 100_000e6);
    }

    function _swap(address tIn, address tOut, uint256 amt, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISwapAdapter.swap, (tIn, tOut, amt, minOut, deadline, abi.encode(int24(100))));
    }

    function test_swapPaysTheAccountAndResetsAllowance() public {
        uint256 expected = aeroRouter.quote(address(usdc), address(weth), 2453_450000);
        bytes memory ret = _ownerExec(
            address(swapAdapter), _swap(address(usdc), address(weth), 2453_450000, expected, block.timestamp + 60)
        );
        assertEq(abi.decode(ret, (uint256)), expected);
        assertEq(weth.balanceOf(address(acct)), expected);
        assertEq(usdc.allowance(address(acct), address(aeroRouter)), 0);
        assertEq(usdc.balanceOf(address(swapAdapter)) + weth.balanceOf(address(swapAdapter)), 0);
    }

    function test_swapGuards() public {
        vm.startPrank(alice);
        vm.expectRevert(AerodromeSwapAdapter.ZeroMinOut.selector);
        acct.exec(address(swapAdapter), 0, _swap(address(usdc), address(weth), 1e6, 0, block.timestamp + 60));
        vm.expectRevert(abi.encodeWithSelector(AerodromeSwapAdapter.Expired.selector, block.timestamp - 1));
        acct.exec(address(swapAdapter), 0, _swap(address(usdc), address(weth), 1e6, 1, block.timestamp - 1));
        vm.expectRevert(AerodromeSwapAdapter.SameToken.selector);
        acct.exec(address(swapAdapter), 0, _swap(address(usdc), address(usdc), 1e6, 1, block.timestamp + 60));
        vm.expectRevert(AerodromeSwapAdapter.ZeroAmount.selector);
        acct.exec(address(swapAdapter), 0, _swap(address(usdc), address(weth), 0, 1, block.timestamp + 60));
        vm.expectRevert(MockAerodromeSwapRouter.TooLittleReceived.selector);
        acct.exec(address(swapAdapter), 0, _swap(address(usdc), address(weth), 1e6, 1e18, block.timestamp + 60));
        vm.stopPrank();
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        new AerodromeSwapAdapter(IAerodromeSwapRouter(address(0)));
    }

    function test_keeperSwapIsBoundedByBudgetAndCannotRedirect() public {
        vm.prank(alice);
        acct.grant(keeper, _perm(address(swapAdapter), ISwapAdapter.swap.selector, _limits1(address(usdc), 1_000e6), 0));
        Call[] memory calls = _one(
            _call(address(swapAdapter), _swap(address(usdc), address(weth), 1_000e6, 1, block.timestamp + 60))
        );
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertGt(weth.balanceOf(address(acct)), 0, "output lands in the account");
        assertEq(weth.balanceOf(keeper), 0);
        calls = _one(_call(address(swapAdapter), _swap(address(usdc), address(weth), 1, 1, block.timestamp + 60)));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
    }
}
