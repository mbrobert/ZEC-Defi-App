// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AerodromeSwapAdapter} from "../../src/swap/AerodromeSwapAdapter.sol";

/// @notice NI-HIGH-1 (`AUDIT-2026-09-12.md`), found by the nightly invariant configuration
///         (runs=1500 × depth=120) on its first local run, 2026-09-12: the LP close paid the
///         account 6,192 wei of WETH (a 6,880-wei fee net of the venue's 10 %); the router swapped
///         that leg with the caller's honest quote (1 WETH → 2,453.45 USDC, 100 bps); the adapter's
///         floor for it rounds to ZERO USDC, so `swap` refused `ZeroQuote()` and the WHOLE unwind —
///         the web's single Close and the keeper's protective `unwind` alike — reverted for a fee
///         worth less than one USDC unit. Fixed: `_toUsdc` asks the adapter for the floor first; a
///         zero floor under a real quote keeps the leg in the account (`DustLegKept`) and goes on.
///         The attack setup is the shrunk sequence's essence — one dust WETH fee on an open LP.
contract DustLegCloseRegressionTest is Fixture {
    uint256 constant COLLATERAL = 1e8;
    uint256 constant BORROW = 30_000e6;
    uint256 constant DUST_FEE = 6880; // wei of WETH, the fuzz's own number
    uint256 constant DUST_NET = DUST_FEE - (DUST_FEE * PERF_BPS) / 10_000; // 6,192 after the venue's cut

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

    // --------------------------------------------------------------- helpers

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
            signature: _signPermit(address(cbbtc), collateral, nonce, block.timestamp + 10 minutes, address(acct))
        });
        p.borrowAmount = borrow;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
    }

    function _openViaAccount(StrategyRouter.OpenParams memory p) internal returns (uint256 id) {
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLeveragedLp, (p)));
        (id,) = abi.decode(ret, (uint256, uint256));
    }

    /// The web's exact Close and the keeper's exact unwind share this shape (RouterDonation.t.sol).
    function _unwind(uint256[] memory ids, uint256 repay, uint256 withdraw)
        internal
        view
        returns (StrategyRouter.UnwindParams memory u)
    {
        u.collateralAsset = address(cbbtc);
        u.positionIds = ids;
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({
            quotedIn: 1e18,
            quotedOut: 2453_450000,
            maxSlippageBps: 100,
            routeData: abi.encode(int24(100))
        });
        u.repayAmount = repay;
        u.withdrawAmount = withdraw;
        u.deadline = block.timestamp + 10 minutes;
    }

    function _idsOf(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    /// An open LP with `feeWei` of WETH accrued on it (the engine's pending fee, as the Handler's
    /// `accrueYield` sets it), and the account funded to cover its whole debt — the probe's state.
    function _openWithWethFee(uint256 feeWei) internal returns (uint256 id) {
        id = _openViaAccount(_open(COLLATERAL, BORROW, 1));
        engine.setPendingFee(id, address(weth), feeWei);
        uint256 debt = aaveVenue.debt(address(acct), address(usdc));
        uint256 held = usdc.balanceOf(address(acct));
        if (debt > held) usdc.mint(address(acct), debt - held);
    }

    function _dustKeptLogs(Vm.Log[] memory logs) internal view returns (uint256 n, uint256 amount) {
        // By signature, not `StrategyRouter.DustLegKept.selector`, so this file compiles against the
        // unfixed router too and the failed-first run is a real run.
        bytes32 topic = keccak256("DustLegKept(address,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == topic) {
                n++;
                amount = abi.decode(logs[i].data, (uint256));
            }
        }
    }

    // =====================================================================
    // FIX NI-HIGH-1: a dust leg no longer reverts the Close
    // =====================================================================

    /// Failed first on c7d90f1 with `ZeroQuote()` from the adapter; passes with the fix.
    function test_FIX_NI1_dustWethLegNoLongerRevertsTheSingleClose() public {
        uint256 id = _openWithWethFee(DUST_FEE);
        assertEq(weth.balanceOf(address(acct)), 0, "no WETH before the close");

        vm.recordLogs();
        StrategyRouter.UnwindParams memory u = _unwind(_idsOf(id), type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 n, uint256 kept) = _dustKeptLogs(vm.getRecordedLogs());

        assertEq(n, 1, "one DustLegKept for the one dust leg");
        assertEq(kept, DUST_NET, "the leg reported is the fee net of the venue's cut");
        assertEq(weth.balanceOf(address(acct)), DUST_NET, "the dust stays in the account, still the user's");
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the debt was repaid");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0, "the collateral came back");
        assertEq(lpVenue.positionsOf(address(acct)).length, 0, "the position is closed");
        assertEq(weth.balanceOf(address(router)), 0, "the router holds nothing");
        assertEq(weth.balanceOf(address(swapAdapter)), 0, "the adapter holds nothing");
    }

    /// The keeper's protection is the same call: inside its grant, on the same state, it must run.
    function test_FIX_NI1_keeperProtectiveUnwindSurvivesADustLeg() public {
        uint256 id = _openWithWethFee(DUST_FEE);
        TokenLimit[] memory lims = _limits2(address(usdc), 1_000_000e6, address(weth), 10e18);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, lims, 0));

        Call[] memory calls = new Call[](1);
        calls[0] = _callP(address(router), abi.encodeCall(StrategyRouter.unwind, (_unwind(_idsOf(id), type(uint256).max, 0))));
        vm.prank(keeper);
        acct.execAsKeeper(calls);

        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the protective unwind ran");
        assertEq(weth.balanceOf(address(acct)), DUST_NET, "the dust stays with the user; nothing was charged to the grant for it");
    }

    /// A leg the quote CAN price is still swapped, and a quote with no numbers is still refused by
    /// the adapter's name — the fix changes nothing but the unpriceable-leg case.
    function test_FIX_NI1_aRealLegStillSwapsAndAZeroQuoteStillReverts() public {
        uint256 id = _openWithWethFee(0.1e18);
        uint256 usdcBefore = usdc.balanceOf(address(acct));

        vm.recordLogs();
        StrategyRouter.UnwindParams memory u = _unwind(_idsOf(id), type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 n,) = _dustKeptLogs(vm.getRecordedLogs());
        assertEq(n, 0, "a priceable leg is swapped, not kept");
        assertEq(weth.balanceOf(address(acct)), 0, "the whole WETH leg went to USDC");
        assertGt(usdc.balanceOf(address(acct)), usdcBefore, "and the USDC came back to the account");

        // A second position with the same real leg, closed with an empty quote: the adapter's
        // `ZeroQuote` — the caller gave nothing to protect the swap with — is untouched by the fix.
        uint256 id2 = _openViaAccount(_open(COLLATERAL, BORROW, 2));
        engine.setPendingFee(id2, address(weth), 0.1e18);
        StrategyRouter.UnwindParams memory u2 = _unwind(_idsOf(id2), 0, 0);
        u2.swap.quotedOut = 0;
        vm.expectRevert(AerodromeSwapAdapter.ZeroQuote.selector);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u2)));
    }

    /// The boundary is exactly the adapter's floor — the code that enforces the swap decides what
    /// counts as dust, never a constant of the router's. Below it the leg is kept, at or above it
    /// the leg is swapped; the Close succeeds on both sides.
    function testFuzz_FIX_NI1_theBoundaryIsTheAdaptersFloor(uint256 feeWei) public {
        feeWei = bound(feeWei, 1, 1e15); // 1 wei … 0.001 WETH: both sides of the ≈ 4.1e8-wei floor
        uint256 net = feeWei - (feeWei * PERF_BPS) / 10_000;
        uint256 id = _openWithWethFee(feeWei);
        bool expectKept = swapAdapter.minOutFor(net, 1e18, 2453_450000, 100) == 0;

        vm.recordLogs();
        StrategyRouter.UnwindParams memory u = _unwind(_idsOf(id), type(uint256).max, type(uint256).max);
        _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 n, uint256 kept) = _dustKeptLogs(vm.getRecordedLogs());

        if (expectKept) {
            assertEq(n, 1, "kept exactly when the adapter's floor is zero");
            assertEq(kept, net);
            assertEq(weth.balanceOf(address(acct)), net);
        } else {
            assertEq(n, 0, "swapped exactly when the adapter's floor is non-zero");
            assertEq(weth.balanceOf(address(acct)), 0);
        }
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "the Close cleared the debt either way");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0, "and returned the collateral either way");
    }
}
