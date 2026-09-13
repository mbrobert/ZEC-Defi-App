// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call} from "../src/interfaces/IOilskinAccount.sol";
import {ILpVenue, PriceBand} from "../src/interfaces/ILpVenue.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ICctpV2.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {CctpMessageV2, MockMessageTransmitterV2, MockTokenMessengerV2} from "./mocks/MockCctpV2.sol";
import {MockCLPool} from "./mocks/MockCLPool.sol";

/// @notice BUILD-PLAN-2026-09-12 D6 / step A5 (2026-09-13): the cross-chain loop's Base half. USDC that
///         Circle's CCTP V2 minted into the user's own account (no signature from the account) goes into
///         an Aerodrome position with `openLpOnly` — no collateral, no borrow, no entry-HF record on this
///         chain; the protective mirror `closeLpAndBurn` closes ids, swaps the non-USDC leg, and burns
///         USDC to the ONE Solana recipient the owner recorded, under the same grant budgets as `unwind`.
///         The CCTP doubles reproduce the V2 message byte layout (VERIFIED-SOLANA-FACTS Addendum 3) so
///         the arriving message here is what Circle's attesters would sign for a Solana burn.
contract StrategyRouterCrossChainTest is Fixture {
    /// The Account's USDC token account on Solana — 32 opaque bytes to this chain, never an address.
    bytes32 constant SOLANA_USDC_ATA = 0x2222222222222222222222222222222222222222222222222222222222222222;
    /// What the Solana program burned for this Base account (its own `mint_recipient`), 10,000 USDC.
    uint256 constant ARRIVED = 10_000e6;
    address relayer = makeAddr("anyone-who-delivers");

    function setUp() public override {
        super.setUp();
        usdc.mint(address(engine), 1_000_000e6);
        weth.mint(address(engine), 1_000e18);
    }

    // ------------------------------------------------------------ helpers

    /// A burn message from Solana (domain 5 → 6) for `to`, delivered by anyone through the transmitter.
    function _arrive(address to, uint256 amount, uint256 fee, uint256 nonce) internal returns (bytes memory message) {
        CctpMessageV2.Header memory h = CctpMessageV2.Header({
            version: 1,
            sourceDomain: CCTP_DOMAIN_SOLANA,
            destinationDomain: CCTP_DOMAIN_BASE,
            nonce: bytes32(nonce),
            sender: SOLANA_TOKEN_MESSENGER_B32,
            recipient: CctpMessageV2.toBytes32(address(cctpMessenger)),
            destinationCaller: bytes32(0),
            minFinalityThreshold: 1000,
            finalityThresholdExecuted: 1000
        });
        CctpMessageV2.BurnBody memory b = CctpMessageV2.BurnBody({
            version: 1,
            burnToken: SOLANA_USDC_MINT_B32,
            mintRecipient: CctpMessageV2.toBytes32(to),
            amount: amount,
            messageSender: SOLANA_USDC_ATA,
            maxFee: fee,
            feeExecuted: fee,
            expirationBlock: block.number + 7200,
            hookData: ""
        });
        message = CctpMessageV2.encode(h, b);
        vm.prank(relayer);
        cctpTransmitter.receiveMessage(message, hex"01");
    }

    function _lpOnly(uint256 amount) internal view returns (StrategyRouter.LpOnlyParams memory p) {
        p.usdcAmount = amount;
        p.poolId = POOL_WETH_USDC;
        p.rangeWidthBps = 1500;
        p.rebalanceDelay = 12 hours;
        p.autoCompound = true;
        p.band = _band(poolWethUsdc, 1000);
        p.deadline = block.timestamp + 10 minutes;
    }

    function _burn(uint256[] memory ids, uint256 amount, uint256 maxFee) internal view returns (StrategyRouter.BurnParams memory b) {
        b.positionIds = ids;
        b.band = _band(poolWethUsdc, 1000);
        // A real quote at the mock router's live rate (1 WETH = 2,453.45 USDC), 1 % tolerance.
        b.swap = StrategyRouter.SwapQuote({quotedIn: 1e18, quotedOut: 2453_450000, maxSlippageBps: 100, routeData: abi.encode(int24(100))});
        b.burnAmount = amount;
        b.maxFee = maxFee;
        b.minFinalityThreshold = 1000;
        b.deadline = block.timestamp + 10 minutes;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    function _setRecipient(bytes32 r) internal {
        _ownerExecPlain(address(router), abi.encodeCall(StrategyRouter.setSolanaRecipient, (r)));
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router holds USDC");
        assertEq(weth.balanceOf(address(router)), 0, "router holds WETH");
    }

    // ------------------------------------------------------------ the arrival

    function test_receiveMessage_mintsToTheAccountWithNoSignatureFromItAndRefusesReplayAndWrongDomain() public {
        uint256 supply = usdc.totalSupply();
        bytes memory m = _arrive(address(acct), ARRIVED, 1e6, 1);
        assertEq(usdc.balanceOf(address(acct)), ARRIVED - 1e6, "amount less Circle's executed fee lands in the account");
        assertEq(usdc.balanceOf(cctpFeeRecipient), 1e6);
        assertEq(usdc.totalSupply(), supply + ARRIVED, "minted, not moved");
        assertEq(cctpTransmitter.usedNonces(bytes32(uint256(1))), 1);
        // the same message a second time
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockMessageTransmitterV2.NonceUsed.selector, bytes32(uint256(1))));
        cctpTransmitter.receiveMessage(m, hex"01");
        // a message for another chain
        (CctpMessageV2.Header memory h, CctpMessageV2.BurnBody memory b) = CctpMessageV2.decode(m);
        assertEq(b.mintRecipient, CctpMessageV2.toBytes32(address(acct)));
        assertEq(b.amount, ARRIVED);
        h.destinationDomain = 0;
        h.nonce = bytes32(uint256(2));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockMessageTransmitterV2.WrongDestinationDomain.selector, 0, 6));
        cctpTransmitter.receiveMessage(CctpMessageV2.encode(h, b), hex"01");
        // no attestation at all
        h.destinationDomain = CCTP_DOMAIN_BASE;
        vm.prank(relayer);
        vm.expectRevert(MockMessageTransmitterV2.EmptyAttestation.selector);
        cctpTransmitter.receiveMessage(CctpMessageV2.encode(h, b), "");
    }

    // ------------------------------------------------------------ openLpOnly

    function test_openLpOnly_deploysArrivedUsdcWithNoDebtNoEntryRecordAndNothingOnTheRouter() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        StrategyRouter.LpOnlyParams memory p = _lpOnly(ARRIVED);
        vm.expectEmit(true, true, false, false, address(router));
        emit StrategyRouter.LpOnlyOpened(address(acct), ARRIVED, POOL_WETH_USDC, 0);
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.openLpOnly, (p)));
        uint256 id = abi.decode(ret, (uint256));
        (bytes32 pid, bool owned) = lpVenue.ownedPool(id, address(acct));
        assertTrue(owned && pid == POOL_WETH_USDC, "the id is the account's, in the pool asked for");
        (uint256 a0, uint256 a1) = engine.positionAmounts(id);
        assertEq(a0, 0, "single-sided: no WETH went in");
        assertEq(a1, ARRIVED, "every USDC that arrived is in the position");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(aaveVenue.debt(address(acct), address(usdc)), 0, "no borrow on this chain");
        assertEq(aaveVenue.collateral(address(acct), address(cbbtc)), 0, "no collateral on this chain");
        assertEq(router.entryHfWad(address(acct)), 0, "no entry-HF record: the debt is Solana's");
        _assertRouterEmpty();
    }

    function test_openLpOnly_refusals() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        StrategyRouter.LpOnlyParams memory p = _lpOnly(ARRIVED);
        p.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLpOnly, (p)));

        p = _lpOnly(0);
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.ZeroAmount.selector);
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLpOnly, (p)));

        p = _lpOnly(ARRIVED + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.UsdcShort.selector, ARRIVED + 1, ARRIVED));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLpOnly, (p)));

        p = _lpOnly(ARRIVED);
        p.poolId = keccak256("no-such-pool");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.UnknownPool.selector, p.poolId));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLpOnly, (p)));

        bytes32 pid = keccak256("weth-cbbtc");
        MockCLPool pool = new MockCLPool(address(weth), address(cbbtc), 100, 500, poolWethUsdc.sqrtPriceX96());
        engine.addPool(pid, address(pool), address(weth), address(cbbtc), 500);
        p = _lpOnly(ARRIVED);
        p.poolId = pid;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.PoolWithoutUsdc.selector, pid));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.openLpOnly, (p)));
    }

    function test_openLpOnly_isNotAKeeperPowerWithoutAGrant() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.openLpOnly, (_lpOnly(ARRIVED)))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(address(acct)), ARRIVED, "untouched");
    }

    // ------------------------------------------------------------ the recorded recipient

    function test_setSolanaRecipient_isTheAccountsOwnRecordAndCanBeCleared() public {
        assertEq(router.solanaRecipient(address(acct)), bytes32(0));
        vm.expectEmit(true, false, false, true, address(router));
        emit StrategyRouter.SolanaRecipientSet(address(acct), SOLANA_USDC_ATA);
        _setRecipient(SOLANA_USDC_ATA);
        assertEq(router.solanaRecipient(address(acct)), SOLANA_USDC_ATA);
        assertEq(router.solanaRecipient(alice), bytes32(0), "the record is the account's, not the wallet's");
        _setRecipient(bytes32(0));
        assertEq(router.solanaRecipient(address(acct)), bytes32(0));
    }

    // ------------------------------------------------------------ closeLpAndBurn

    function test_closeLpAndBurn_closesSwapsTheLegAndBurnsEverythingToThePinnedRecipient() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        uint256 id = abi.decode(_ownerExec(address(router), abi.encodeCall(StrategyRouter.openLpOnly, (_lpOnly(ARRIVED)))), (uint256));
        engine.setPendingFee(id, address(weth), 0.5e18);
        _setRecipient(SOLANA_USDC_ATA);
        uint256 supply = usdc.totalSupply();

        StrategyRouter.BurnParams memory b = _burn(_ids(id), type(uint256).max, 2e6);
        vm.expectEmit(true, true, false, false, address(cctpMessenger));
        emit ITokenMessengerV2.DepositForBurn(address(usdc), 0, address(acct), SOLANA_USDC_ATA, CCTP_DOMAIN_SOLANA, SOLANA_TOKEN_MESSENGER_B32, bytes32(0), 2e6, 1000, "");
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        (uint256 usdcFromLp, uint256 burned) = abi.decode(ret, (uint256, uint256));

        assertGt(usdcFromLp, ARRIVED, "principal back plus the WETH fee swapped to USDC");
        assertEq(burned, usdcFromLp, "everything the close produced was burned");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(weth.balanceOf(address(acct)), 0, "the WETH leg was swapped, not left");
        assertEq(usdc.totalSupply(), supply - burned, "a real burn: the supply fell");
        assertEq(usdc.allowance(address(acct), address(cctpMessenger)), 0, "approval reset");
        assertEq(cctpMessenger.burnCount(), 1);
        assertEq(lpVenue.positionsOf(address(acct)).length, 0);
        _assertRouterEmpty();

        // The message the transmitter emitted is what Circle would attest for Solana: domain 6 → 5,
        // the recipient is the recorded token account, the amount is what was burned, the sender is
        // the account.
        (CctpMessageV2.Header memory h, CctpMessageV2.BurnBody memory body) = CctpMessageV2.decode(cctpTransmitter.lastMessage());
        assertEq(h.sourceDomain, CCTP_DOMAIN_BASE);
        assertEq(h.destinationDomain, CCTP_DOMAIN_SOLANA);
        assertEq(h.recipient, SOLANA_TOKEN_MESSENGER_B32);
        assertEq(h.destinationCaller, bytes32(0), "anyone may deliver on Solana");
        assertEq(h.minFinalityThreshold, 1000);
        assertEq(body.mintRecipient, SOLANA_USDC_ATA);
        assertEq(body.amount, burned);
        assertEq(body.maxFee, 2e6);
        assertEq(body.messageSender, CctpMessageV2.toBytes32(address(acct)));
        assertEq(body.burnToken, CctpMessageV2.toBytes32(address(usdc)));
    }

    function test_closeLpAndBurn_aFixedAmountLeavesTheRestAndIdleUsdcBurnsWithNoIds() public {
        _arrive(address(acct), 5_000e6, 0, 1);
        _setRecipient(SOLANA_USDC_ATA);
        uint256[] memory none;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (_burn(none, 2_000e6, 1e6))));
        (uint256 usdcFromLp, uint256 burned) = abi.decode(ret, (uint256, uint256));
        assertEq(usdcFromLp, 0);
        assertEq(burned, 2_000e6);
        assertEq(usdc.balanceOf(address(acct)), 3_000e6);
        ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (_burn(none, type(uint256).max, 1e6))));
        (, burned) = abi.decode(ret, (uint256, uint256));
        assertEq(burned, 3_000e6);
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(cctpMessenger.burnCount(), 2);
    }

    function test_closeLpAndBurn_refusalsByName() public {
        uint256[] memory none;
        StrategyRouter.BurnParams memory b;
        // (every params struct is built BEFORE the expectRevert: the band helper's price read is a call)
        // no recipient recorded
        _arrive(address(acct), 1_000e6, 0, 1);
        b = _burn(none, type(uint256).max, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.NoSolanaRecipient.selector, address(acct)));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        _setRecipient(SOLANA_USDC_ATA);
        // a zero amount
        b = _burn(none, 0, 0);
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.ZeroAmount.selector);
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        // more than held
        b = _burn(none, 1_000e6 + 1, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.UsdcShort.selector, 1_000e6 + 1, 1_000e6));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        // a fee that would eat the whole amount
        b = _burn(none, 1_000e6, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.MaxFeeNotBelowAmount.selector, 1_000e6, 1_000e6));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        // expired
        b = _burn(none, 1_000e6, 0);
        b.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        // Circle's denylist bubbles up by name
        cctpMessenger.setDenylisted(address(acct), true);
        b = _burn(none, 1_000e6, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockTokenMessengerV2.Denylisted.selector, address(acct)));
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        cctpMessenger.setDenylisted(address(acct), false);
        // nothing burned by any of those
        assertEq(usdc.balanceOf(address(acct)), 1_000e6);
        assertEq(cctpMessenger.burnCount(), 0);
        // "everything" when there is nothing
        _ownerExecPlain(address(usdc), abi.encodeCall(IERC20.transfer, (alice, 1_000e6)));
        b = _burn(none, type(uint256).max, 0);
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.ZeroAmount.selector);
        acct.execWithCallback(address(router), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        // a deployment without the loop refuses by name, and a messenger with no domain cannot be built
        StrategyRouter off = new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(0)), 0
        );
        b = _burn(none, 1_000e6, 0);
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.CrossChainDisabled.selector);
        acct.execWithCallback(address(off), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        vm.expectRevert(StrategyRouter.ZeroAddress.selector);
        this.deployRouterWithAMessengerButNoDomain();
    }

    /// @dev External so `expectRevert` watches a plain call (Foundry 1.8 links `new` in a test through
    ///      `vm.deployCode`, which the cheatcode cannot watch directly).
    function deployRouterWithAMessengerButNoDomain() external {
        new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(cctpMessenger)), 0
        );
    }

    function test_closeLpAndBurn_byKeeperInsideAGrantIsBoundedByTheUsdcBudgetAndCannotRedirect() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        _setRecipient(SOLANA_USDC_ATA);
        // The grant: this selector, a USDC budget of 6,000 per period; the approve for the burn is the one
        // token operation in the tree, charged against it.
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.closeLpAndBurn.selector, _limits1(address(usdc), 6_000e6), 0));
        uint256[] memory none;
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (_burn(none, 4_000e6, 4e6)))));
        vm.expectEmit(true, true, false, false, address(router));
        emit StrategyRouter.BurnedToSolana(address(acct), 4_000e6, SOLANA_USDC_ATA, 4e6, 1000, 0, 0, 0);
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(address(acct)), ARRIVED - 4_000e6);
        assertEq(usdc.balanceOf(keeper), 0, "nothing reached the keeper");
        // over the remaining budget (2,000): refused by the account, nothing burned
        calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (_burn(none, 3_000e6, 3e6)))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(address(acct)), ARRIVED - 4_000e6);
        assertEq(cctpMessenger.burnCount(), 1);
        // the keeper cannot move the destination: no grant names setSolanaRecipient
        calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.setSolanaRecipient, (bytes32(uint256(0xbad))))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(router.solanaRecipient(address(acct)), SOLANA_USDC_ATA, "the owner's record stands");
    }

    function test_closeLpAndBurn_aGrantForUnwindDoesNotCoverTheBurn() public {
        _arrive(address(acct), ARRIVED, 0, 1);
        _setRecipient(SOLANA_USDC_ATA);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.unwind.selector, _limits1(address(usdc), 100_000e6), 0));
        uint256[] memory none;
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.closeLpAndBurn, (_burn(none, 1_000e6, 0)))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(cctpMessenger.burnCount(), 0);
    }

    function test_unwind_stillClosesAndRepaysAsBefore_theSharedLegIsUnchanged() public {
        // The close-and-settle leg is now shared with closeLpAndBurn; unwind's own path is unchanged:
        // an LP-only position (no debt) unwound with repay = max and withdraw = 0 is a no-op on the
        // venues and leaves the USDC in the account.
        _arrive(address(acct), ARRIVED, 0, 1);
        uint256 id = abi.decode(_ownerExec(address(router), abi.encodeCall(StrategyRouter.openLpOnly, (_lpOnly(ARRIVED)))), (uint256));
        StrategyRouter.UnwindParams memory u;
        u.collateralAsset = address(cbbtc);
        u.positionIds = _ids(id);
        u.band = _band(poolWethUsdc, 1000);
        u.swap = StrategyRouter.SwapQuote({quotedIn: 1e18, quotedOut: 2453_450000, maxSlippageBps: 100, routeData: abi.encode(int24(100))});
        u.repayAmount = type(uint256).max;
        u.withdrawAmount = 0;
        u.deadline = block.timestamp + 10 minutes;
        bytes memory ret = _ownerExec(address(router), abi.encodeCall(StrategyRouter.unwind, (u)));
        (uint256 usdcFromLp, uint256 repaid,,) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        assertEq(usdcFromLp, ARRIVED);
        assertEq(repaid, 0, "no debt on this chain");
        assertEq(usdc.balanceOf(address(acct)), ARRIVED);
        _assertRouterEmpty();
    }
}
