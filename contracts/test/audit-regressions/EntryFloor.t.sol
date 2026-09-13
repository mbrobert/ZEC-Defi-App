// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Fixture} from "../Fixture.sol";
import {OilskinAccount} from "../../src/account/OilskinAccount.sol";
import {StrategyRouter} from "../../src/router/StrategyRouter.sol";
import {AaveV3Venue} from "../../src/venues/AaveV3Venue.sol";
import {ICollateralVenue} from "../../src/interfaces/ICollateralVenue.sol";
import {IAavePool} from "../../src/interfaces/IAaveV3.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {Call, Permission, TokenLimit} from "../../src/interfaces/IOilskinAccount.sol";

/// @notice Harvested from wave-1 lens A (`test/poc/ExitAndEntryFloor.t.sol`), expectations flipped
///         to the FIXED behaviour with the attack setups kept intact.
///
///   A-HIGH-1  the shipped "hold" strategy built `execBatch([permit2, supply, borrow])` and never
///             touched the router, so `EntryHfTooLow` never ran and a first-time user could open at
///             HF 1.07 against an advertised 1.25. The floor is a property of the VENUE CALL now, so
///             no reachable sequence through the venue opens debt below it, and the router carries a
///             first-class `openBorrowOnly` so no product flow ever needs a hand-built batch.
///   Controls: the owner exit guarantee, unchanged and re-proved in every broken state.
contract EntryFloorRegressionTest is Fixture {
    address thief = makeAddr("thief");

    uint256 constant ONE_CBBTC = 1e8;

    function setUp() public override {
        super.setUp();
        cbbtc.mint(alice, 10e8);
        weth.mint(alice, 100e18);
        vm.startPrank(alice);
        cbbtc.approve(address(permit2), type(uint256).max);
        weth.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    /// The three calls `web/lib/plan.ts` emits for strategy = "hold", verbatim.
    function _holdBatch(
        address account,
        address owner_,
        uint256 key,
        uint256 collateral,
        uint256 borrow_,
        uint256 nonce
    ) internal view returns (Call[] memory calls) {
        bytes memory sig =
            _signPermitWith(key, address(cbbtc), collateral, nonce, block.timestamp + 20 minutes, account);
        IPermit2.PermitTransferFrom memory permit = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: address(cbbtc), amount: collateral}),
            nonce: nonce,
            deadline: block.timestamp + 20 minutes
        });
        IPermit2.SignatureTransferDetails memory details =
            IPermit2.SignatureTransferDetails({to: account, requestedAmount: collateral});
        calls = new Call[](3);
        calls[0] =
            _call(address(permit2), abi.encodeCall(IPermit2.permitTransferFrom, (permit, details, owner_, sig)));
        calls[1] =
            _callP(address(aaveVenue), abi.encodeCall(ICollateralVenue.supply, (address(cbbtc), collateral)));
        calls[2] =
            _callP(address(aaveVenue), abi.encodeCall(ICollateralVenue.borrow, (address(usdc), borrow_)));
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

    // =====================================================================
    // FIX A-HIGH-1 (D2). The exact hold batch now hits the floor at the VENUE.
    // =====================================================================

    function test_FIX_E1_theHoldBatchNoLongerBypassesTheEntryFloor() public {
        uint256 maxBorrow = (PRICE_CBBTC_E8 * CBBTC_LTV) / 10_000 / 100; // Aave's full 73 % LTV
        Call[] memory calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, maxBorrow, 1);

        vm.prank(alice);
        vm.expectPartialRevert(AaveV3Venue.EntryHfTooLow.selector);
        acct.execBatch(calls);

        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "atomic: nothing borrowed");
        assertEq(cbbtc.balanceOf(alice), 10e8, "atomic: nothing pulled from the wallet");
        // floor(7800 × 100 / 125) = 6240, under Aave's LTV 7300; no product cap above it.
        assertEq(registry.maxOfferedLtvBps(address(cbbtc)), 6240);

        // The advertised maximum still works, through the very same batch.
        uint256 offered = (PRICE_CBBTC_E8 * registry.maxOfferedLtvBps(address(cbbtc))) / 10_000 / 100;
        calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, offered, 2);
        vm.prank(alice);
        acct.execBatch(calls);
        uint256 hf = aaveVenue.healthFactor(address(acct));
        console2.log("hold-path HF at the advertised maximum:", hf);
        assertGe(hf, registry.entryHfFloorWad(), "what the registry advertises is what the chain enforces");
    }

    /// The same for a FIRST-TIME user: one transaction, account created and maxed out. Refused.
    function test_FIX_E2_firstTimeUserCannotOpenAnUnprotectedPosition() public {
        uint256 newKey = 0xBEEF;
        address newbie = vm.addr(newKey);
        cbbtc.mint(newbie, ONE_CBBTC);
        vm.prank(newbie);
        cbbtc.approve(address(permit2), type(uint256).max);

        address predicted = factory.accountOf(newbie);
        uint256 maxBorrow = (PRICE_CBBTC_E8 * CBBTC_LTV) / 10_000 / 100;
        Call[] memory calls = _holdBatch(predicted, newbie, newKey, ONE_CBBTC, maxBorrow, 7);

        vm.prank(newbie);
        vm.expectPartialRevert(AaveV3Venue.EntryHfTooLow.selector);
        factory.createAccountAndExec(calls);
        assertEq(predicted.code.length, 0, "atomic: not even the account was created");
    }

    /// E3b: no attacker, no client bug. The wizard quotes the registry's 62.4 % maximum, cbBTC drops
    /// 10 % inside the 20-minute permit deadline, and the borrow amount is fixed in USDC: 69.3 % of
    /// the new price — still inside Aave's own 73 % LTV, so Aave would lend — HF 0.78 / 0.693 =
    /// 1.125 against the 1.25 floor. The chain re-checks it now. (A 20 % drop would put the fixed
    /// borrow at 78 %, past Aave's LTV, and Aave's refusal would arrive before the floor's.)
    function test_FIX_E3b_priceDriftBetweenQuoteAndInclusionIsCaught() public {
        uint256 quotedBorrow = (PRICE_CBBTC_E8 * registry.maxOfferedLtvBps(address(cbbtc))) / 10_000 / 100;
        Call[] memory calls = _holdBatch(address(acct), alice, aliceKey, ONE_CBBTC, quotedBorrow, 11);
        aave.setPrice(address(cbbtc), (PRICE_CBBTC_E8 * 9000) / 10_000);

        vm.prank(alice);
        vm.expectPartialRevert(AaveV3Venue.EntryHfTooLow.selector);
        acct.execBatch(calls);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "no position opened below the floor");
    }

    // =====================================================================
    // FIX D2. `openBorrowOnly` — the first-class router entry point for the hold strategy, with
    // the same registry gate, the same deadline and the same floor as `openLeveragedLp`.
    // =====================================================================

    function test_FIX_D2_openBorrowOnlyIsTheSupportedHoldPath() public {
        uint256 offered = (PRICE_CBBTC_E8 * registry.maxOfferedLtvBps(address(cbbtc))) / 10_000 / 100;
        vm.expectEmit(true, true, false, false);
        emit StrategyRouter.BorrowOnlyOpened(address(acct), address(cbbtc), ONE_CBBTC, offered, 0);
        bytes memory ret = _ownerExec(
            address(router), abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, offered, 3)))
        );
        uint256 hf = abi.decode(ret, (uint256));
        assertGe(hf, registry.entryHfFloorWad());
        assertEq(usdc.balanceOf(address(acct)), offered, "the borrowed USDC is in the account, undeployed");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), ONE_CBBTC);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(cbbtc.balanceOf(address(router)), 0);
    }

    function test_FIX_D2b_openBorrowOnlyRefusesTheSameOversizedBorrow() public {
        uint256 maxBorrow = (PRICE_CBBTC_E8 * CBBTC_LTV) / 10_000 / 100;
        bytes memory data =
            abi.encodeCall(StrategyRouter.openBorrowOnly, (_borrowOnly(ONE_CBBTC, maxBorrow, 4)));
        vm.prank(alice);
        vm.expectPartialRevert(AaveV3Venue.EntryHfTooLow.selector);
        acct.execWithCallback(address(router), 0, data);
        assertEq(cbbtc.balanceOf(alice), 10e8, "atomic");
    }

    function test_FIX_D2c_openBorrowOnlyCarriesTheRegistryGateAndTheDeadline() public {
        StrategyRouter.BorrowOnlyParams memory p = _borrowOnly(0, 1_000e6, 5);
        p.collateralAsset = address(cbzec);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyRouter.AssetDisabled.selector, address(cbzec), "no collateral market on Base yet"
            )
        );
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openBorrowOnly, (p)));

        p = _borrowOnly(0, 1_000e6, 6);
        p.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openBorrowOnly, (p)));

        p = _borrowOnly(0, 0, 7);
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.ZeroBorrow.selector);
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openBorrowOnly, (p)));
    }

    /// The sequence that DOES remain open to a user hand-writing their own calldata: going straight
    /// to Aave's pool. That is the account owner's right and it is what the exit guarantee is made
    /// of — the product's job is never to build such a sequence for them, and it no longer does.
    function test_FIX_D2d_rawAavePoolCallsRemainTheOwnersRight() public {
        cbbtc.mint(address(acct), ONE_CBBTC);
        uint256 maxBorrow = (PRICE_CBBTC_E8 * CBBTC_LTV) / 10_000 / 100;
        vm.startPrank(alice);
        acct.exec(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (address(aave), ONE_CBBTC)));
        acct.exec(
            address(aave), 0, abi.encodeCall(IAavePool.supply, (address(cbbtc), ONE_CBBTC, address(acct), 0))
        );
        acct.exec(
            address(aave), 0, abi.encodeCall(IAavePool.borrow, (address(usdc), maxBorrow, 2, 0, address(acct)))
        );
        vm.stopPrank();
        assertLt(aaveVenue.healthFactor(address(acct)), registry.entryHfFloorWad());
        // Documented, not fixed: the account is a general-purpose smart account and its owner can
        // always call any protocol directly. Nothing the product builds does this.
    }

    // =====================================================================
    // Controls: the owner exit guarantee, unchanged.
    // =====================================================================

    function _supplyAndBorrow(uint256 collateral, uint256 borrow_) internal {
        cbbtc.mint(address(acct), collateral);
        vm.startPrank(alice);
        acct.exec(address(cbbtc), 0, abi.encodeCall(IERC20.approve, (address(aave), collateral)));
        acct.exec(address(aave), 0, abi.encodeCall(IAavePool.supply, (address(cbbtc), collateral, address(acct), 0)));
        acct.exec(address(aave), 0, abi.encodeCall(IAavePool.borrow, (address(usdc), borrow_, 2, 0, address(acct))));
        vm.stopPrank();
    }

    function test_FIX_E4_ownerStillExitsWhileEverythingElseIsBroken() public {
        _supplyAndBorrow(ONE_CBBTC, 20_000e6);
        vm.prank(registryOwner);
        registry.setEnabled(address(cbbtc), false, "paused by ops");
        engine.setPaused(true);
        vm.prank(alice);
        acct.grant(
            keeper,
            _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 1), 0)
        );

        vm.startPrank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.approve, (address(aave), 20_000e6)));
        acct.exec(address(aave), 0, abi.encodeCall(IAavePool.repay, (address(usdc), 20_000e6, 2, address(acct))));
        acct.exec(address(aave), 0, abi.encodeCall(IAavePool.withdraw, (address(cbbtc), type(uint256).max, alice)));
        vm.stopPrank();
        assertEq(cbbtc.balanceOf(alice), 10e8 + ONE_CBBTC, "collateral fully recovered");
        assertEq(aave.debtOf(address(acct), address(usdc)), 0);
    }

    function test_FIX_E5_ownerExitsARebasingB20MidFlight() public {
        cbzec.mint(address(acct), 100e8);
        cbzec.setMultiplier(1.37e18);
        uint256 bal = cbzec.balanceOf(address(acct));
        vm.prank(alice);
        acct.exec(address(cbzec), 0, abi.encodeCall(IERC20.transfer, (alice, bal)));
        assertEq(cbzec.balanceOf(alice), bal);
        assertEq(cbzec.balanceOf(address(acct)), 0);
    }

    function testFuzz_FIX_E7_ownerAlwaysExitsUnderAnyKeeperGrantState(uint256 amount, uint8 mode) public {
        amount = bound(amount, 1, 1_000_000e6);
        usdc.mint(address(acct), amount);
        vm.prank(alice);
        acct.grant(
            keeper,
            _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), amount), 0)
        );
        if (mode % 3 == 1) {
            vm.prank(alice);
            acct.revokeAll();
        } else if (mode % 3 == 2) {
            vm.warp(block.timestamp + 60 days);
        }
        vm.prank(alice);
        acct.exec(address(usdc), 0, abi.encodeCall(IERC20.transfer, (alice, amount)));
        assertEq(usdc.balanceOf(address(acct)), 0);
    }
}
