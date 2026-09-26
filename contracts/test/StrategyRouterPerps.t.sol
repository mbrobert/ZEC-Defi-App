// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OilskinAccountFactory} from "../src/account/OilskinAccountFactory.sol";
import {Call} from "../src/interfaces/IOilskinAccount.sol";
import {ILpVenue} from "../src/interfaces/ILpVenue.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ICctpV2.sol";
import {StrategyRouter} from "../src/router/StrategyRouter.sol";
import {CctpMessageV2, MockTokenMessengerV2} from "./mocks/MockCctpV2.sol";

/// @notice BUILD-PLAN Stream D step D5 (2026-09-26): the perps rail's Base half (`PERPS-DESIGN-2026-09-25.md`
///         §6 "In"). The user's Base account burns USDC through CCTP to domain 19 with its OWN HyperEVM account
///         as `mintRecipient` — a 20-byte address left-padded — recorded by the owner (`setPerpRecipient`) and
///         never a parameter of the burn. When the HyperEVM factory and implementation are known the record is
///         checked by CREATE2 derivation: only the address the SAME owner's account has there is accepted. The
///         message the transmitter emits is what Circle attests for HyperEVM, byte for byte.
contract StrategyRouterPerpsTest is Fixture {
    uint256 constant MARGIN = 5_000e6;
    /// Stands in for the `OilskinAccountFactory` deployed on HyperEVM: a second factory, another address.
    OilskinAccountFactory perpFactory;
    /// Alice's account on "HyperEVM" — the address her Base account may burn to, and no other.
    address perpAcct;
    /// A router that knows the HyperEVM factory (the fixture's router does not: both zero, unchecked).
    StrategyRouter checked;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(acct), MARGIN);
        perpFactory = new OilskinAccountFactory(address(permit2));
        perpAcct = perpFactory.accountOf(alice);
        checked = new StrategyRouter(
            registry,
            lpVenue,
            swapAdapter,
            IPermit2(address(permit2)),
            address(usdc),
            ILpVenue(address(0)),
            ISwapAdapter(address(0)),
            ITokenMessengerV2(address(cctpMessenger)),
            CCTP_DOMAIN_SOLANA,
            CCTP_DOMAIN_HYPEREVM,
            address(perpFactory),
            perpFactory.IMPLEMENTATION()
        );
    }

    // ------------------------------------------------------------ helpers

    function _p(uint256 amount, uint256 maxFee, uint32 finality) internal view returns (StrategyRouter.BurnToPerpParams memory p) {
        p.amount = amount;
        p.maxFee = maxFee;
        p.minFinalityThreshold = finality;
        p.deadline = block.timestamp + 10 minutes;
    }

    function _setRecipient(StrategyRouter r, address a) internal {
        _ownerExecPlain(address(r), abi.encodeCall(StrategyRouter.setPerpRecipient, (a)));
    }

    function _burnAs(StrategyRouter r, StrategyRouter.BurnToPerpParams memory p) internal returns (uint256 burned) {
        burned = abi.decode(_ownerExec(address(r), abi.encodeCall(StrategyRouter.burnToPerp, (p))), (uint256));
    }

    function _expectRevertBurn(StrategyRouter r, StrategyRouter.BurnToPerpParams memory p, bytes memory err) internal {
        vm.prank(alice);
        vm.expectRevert(err);
        acct.execWithCallback(address(r), 0, abi.encodeCall(StrategyRouter.burnToPerp, (p)));
    }

    // ------------------------------------------------------------ the recorded recipient

    function test_setPerpRecipient_unchecked_isTheAccountsOwnRecordAndCanBeCleared() public {
        assertEq(router.PERP_FACTORY(), address(0), "the fixture's router does not know the HyperEVM factory");
        address anywhere = makeAddr("some-hyperevm-address");
        assertEq(router.perpRecipient(address(acct)), address(0));
        vm.expectEmit(true, true, false, false, address(router));
        emit StrategyRouter.PerpRecipientSet(address(acct), anywhere);
        _setRecipient(router, anywhere);
        assertEq(router.perpRecipient(address(acct)), anywhere, "unchecked: the owner's word");
        assertEq(router.perpRecipient(alice), address(0), "the record is the account's, not the wallet's");
        _setRecipient(router, address(0));
        assertEq(router.perpRecipient(address(acct)), address(0));
    }

    function test_setPerpRecipient_checked_acceptsOnlyTheSameOwnersAccountOnHyperEvm() public {
        assertEq(checked.PERP_FACTORY(), address(perpFactory));
        assertEq(checked.PERP_ACCOUNT_IMPLEMENTATION(), perpFactory.IMPLEMENTATION());
        assertTrue(perpAcct != address(acct), "another factory, another address: the check is real");
        // the same owner's account there: accepted, whether or not it is deployed yet
        assertEq(perpAcct.code.length, 0, "not deployed on this chain - the derivation needs no state");
        _setRecipient(checked, perpAcct);
        assertEq(checked.perpRecipient(address(acct)), perpAcct);
        // bob's account there, an EOA, and alice's BASE account: each refused by name with the address expected
        address bobs = perpFactory.accountOf(bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.PerpRecipientMismatch.selector, bobs, perpAcct));
        acct.exec(address(checked), 0, abi.encodeCall(StrategyRouter.setPerpRecipient, (bobs)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.PerpRecipientMismatch.selector, alice, perpAcct));
        acct.exec(address(checked), 0, abi.encodeCall(StrategyRouter.setPerpRecipient, (alice)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StrategyRouter.PerpRecipientMismatch.selector, address(acct), perpAcct));
        acct.exec(address(checked), 0, abi.encodeCall(StrategyRouter.setPerpRecipient, (address(acct))));
        assertEq(checked.perpRecipient(address(acct)), perpAcct, "the record stands");
        // zero clears without a check
        _setRecipient(checked, address(0));
        assertEq(checked.perpRecipient(address(acct)), address(0));
        // the derivation is the factory's own: deploying the account there lands where the router said
        assertEq(perpFactory.createAccount(alice), perpAcct);
    }

    // ------------------------------------------------------------ burnToPerp

    function test_burnToPerp_burnsIdleUsdcToTheRecordedHyperEvmAccount_fastThenStandard() public {
        _setRecipient(router, perpAcct);
        uint256 supply = usdc.totalSupply();
        StrategyRouter.BurnToPerpParams memory p = _p(3_000e6, 1e6, 1000);

        vm.expectEmit(true, true, false, false, address(cctpMessenger));
        emit ITokenMessengerV2.DepositForBurn(address(usdc), 0, address(acct), CctpMessageV2.toBytes32(perpAcct), CCTP_DOMAIN_HYPEREVM, HYPEREVM_TOKEN_MESSENGER_B32, bytes32(0), 1e6, 1000, "");
        vm.expectEmit(true, true, false, true, address(router));
        emit StrategyRouter.BurnedToPerp(address(acct), 3_000e6, perpAcct, 1e6, 1000);
        uint256 burned = _burnAs(router, p);

        assertEq(burned, 3_000e6);
        assertEq(usdc.balanceOf(address(acct)), MARGIN - 3_000e6, "a fixed amount leaves the rest");
        assertEq(usdc.totalSupply(), supply - 3_000e6, "a real burn: the supply fell");
        assertEq(usdc.allowance(address(acct), address(cctpMessenger)), 0, "approval reset");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        assertEq(cctpMessenger.burnCount(), 1);

        // The message the transmitter emitted is what Circle attests for HyperEVM: domain 6 → 19, to Base's own
        // messenger address there, anyone may deliver, Fast asked, the recipient the recorded account left-padded,
        // the amount what was burned, the sender the account.
        (CctpMessageV2.Header memory h, CctpMessageV2.BurnBody memory body) = CctpMessageV2.decode(cctpTransmitter.lastMessage());
        assertEq(h.sourceDomain, CCTP_DOMAIN_BASE);
        assertEq(h.destinationDomain, CCTP_DOMAIN_HYPEREVM);
        assertEq(h.recipient, HYPEREVM_TOKEN_MESSENGER_B32);
        assertEq(h.destinationCaller, bytes32(0), "anyone may deliver on HyperEVM");
        assertEq(h.minFinalityThreshold, 1000, "Fast is offered into HyperEVM (facts s.7.4)");
        assertEq(body.mintRecipient, bytes32(uint256(uint160(perpAcct))), "a 20-byte address, left-padded");
        assertEq(CctpMessageV2.toAddress(body.mintRecipient), perpAcct);
        assertEq(body.amount, 3_000e6);
        assertEq(body.maxFee, 1e6);
        assertEq(body.messageSender, CctpMessageV2.toBytes32(address(acct)));
        assertEq(body.burnToken, CctpMessageV2.toBytes32(address(usdc)));

        // "everything", Standard
        burned = _burnAs(router, _p(type(uint256).max, 0, 2000));
        assertEq(burned, MARGIN - 3_000e6);
        assertEq(usdc.balanceOf(address(acct)), 0);
        (h,) = CctpMessageV2.decode(cctpTransmitter.lastMessage());
        assertEq(h.minFinalityThreshold, 2000);
        assertEq(cctpMessenger.burnCount(), 2);
    }

    function test_burnToPerp_refusalsByName() public {
        // no recipient recorded
        _expectRevertBurn(router, _p(1_000e6, 0, 2000), abi.encodeWithSelector(StrategyRouter.NoPerpRecipient.selector, address(acct)));
        _setRecipient(router, perpAcct);
        // a zero amount
        _expectRevertBurn(router, _p(0, 0, 2000), abi.encodeWithSelector(StrategyRouter.ZeroAmount.selector));
        // more than held
        _expectRevertBurn(router, _p(MARGIN + 1, 0, 2000), abi.encodeWithSelector(StrategyRouter.UsdcShort.selector, MARGIN + 1, MARGIN));
        // a fee that would eat the whole amount, and one over the 1 % cap
        _expectRevertBurn(router, _p(1_000e6, 1_000e6, 1000), abi.encodeWithSelector(StrategyRouter.MaxFeeNotBelowAmount.selector, 1_000e6, 1_000e6));
        _expectRevertBurn(router, _p(1_000e6, 11e6, 1000), abi.encodeWithSelector(StrategyRouter.MaxFeeTooLarge.selector, 11e6, 10e6));
        // expired
        StrategyRouter.BurnToPerpParams memory p = _p(1_000e6, 0, 2000);
        p.deadline = block.timestamp - 1;
        _expectRevertBurn(router, p, abi.encodeWithSelector(StrategyRouter.Expired.selector, block.timestamp - 1));
        // Circle's denylist bubbles up by name
        cctpMessenger.setDenylisted(address(acct), true);
        _expectRevertBurn(router, _p(1_000e6, 0, 2000), abi.encodeWithSelector(MockTokenMessengerV2.Denylisted.selector, address(acct)));
        cctpMessenger.setDenylisted(address(acct), false);
        // nothing burned by any of those
        assertEq(usdc.balanceOf(address(acct)), MARGIN);
        assertEq(cctpMessenger.burnCount(), 0);
        // "everything" when there is nothing
        _ownerExecPlain(address(usdc), abi.encodeCall(IERC20.transfer, (alice, MARGIN)));
        _expectRevertBurn(router, _p(type(uint256).max, 0, 2000), abi.encodeWithSelector(StrategyRouter.ZeroAmount.selector));
    }

    function test_eachRailIsSwitchedByItsOwnDomain() public {
        // a deployment with the messenger and ONLY the Solana rail: burnToPerp refuses by name, closeLpAndBurn works
        StrategyRouter solanaOnly = new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(cctpMessenger)), CCTP_DOMAIN_SOLANA, 0, address(0), address(0)
        );
        _setRecipient(solanaOnly, perpAcct);
        _expectRevertBurn(solanaOnly, _p(1_000e6, 0, 2000), abi.encodeWithSelector(StrategyRouter.CrossChainDisabled.selector));
        _ownerExecPlain(address(solanaOnly), abi.encodeCall(StrategyRouter.setSolanaRecipient, (bytes32(uint256(0x22)))));
        uint256[] memory none;
        StrategyRouter.BurnParams memory b;
        b.positionIds = none;
        b.band = _band(poolWethUsdc, 1000);
        b.burnAmount = 1_000e6;
        b.minFinalityThreshold = 1000;
        b.deadline = block.timestamp + 10 minutes;
        _ownerExec(address(solanaOnly), abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        assertEq(cctpMessenger.burnCount(), 1);
        // and the other way round: the perps rail alone; the Solana burn refuses by name
        StrategyRouter perpsOnly = new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(cctpMessenger)), 0, CCTP_DOMAIN_HYPEREVM, address(0), address(0)
        );
        _ownerExecPlain(address(perpsOnly), abi.encodeCall(StrategyRouter.setSolanaRecipient, (bytes32(uint256(0x22)))));
        vm.prank(alice);
        vm.expectRevert(StrategyRouter.CrossChainDisabled.selector);
        acct.execWithCallback(address(perpsOnly), 0, abi.encodeCall(StrategyRouter.closeLpAndBurn, (b)));
        _setRecipient(perpsOnly, perpAcct);
        assertEq(_burnAs(perpsOnly, _p(1_000e6, 0, 2000)), 1_000e6);
        assertEq(cctpMessenger.burnCount(), 2);
        // no messenger at all: both refuse
        StrategyRouter off = new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(0)), 0, 0, address(0), address(0)
        );
        _setRecipient(off, perpAcct);
        _expectRevertBurn(off, _p(1_000e6, 0, 2000), abi.encodeWithSelector(StrategyRouter.CrossChainDisabled.selector));
        // a messenger with no domain on either rail cannot be built; a factory without its implementation neither
        vm.expectRevert(StrategyRouter.ZeroAddress.selector);
        this.deployMessengerWithNoRail();
        vm.expectRevert(StrategyRouter.ZeroAddress.selector);
        this.deployFactoryWithoutImplementation();
    }

    /// @dev External so `expectRevert` watches a plain call (Foundry 1.8 links `new` in a test through `vm.deployCode`).
    function deployMessengerWithNoRail() external {
        new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(cctpMessenger)), 0, 0, address(0), address(0)
        );
    }

    function deployFactoryWithoutImplementation() external {
        new StrategyRouter(
            registry, lpVenue, swapAdapter, IPermit2(address(permit2)), address(usdc), ILpVenue(address(0)), ISwapAdapter(address(0)), ITokenMessengerV2(address(cctpMessenger)), CCTP_DOMAIN_SOLANA, CCTP_DOMAIN_HYPEREVM, address(perpFactory), address(0)
        );
    }

    function test_burnToPerp_byKeeperInsideAGrantIsBoundedByTheUsdcBudgetAndCannotRedirect() public {
        // Not a product flow (beta's margin is user-signed, design §10 item 5), but the invariant must hold: a
        // grant on the selector is bounded by its USDC budget — the approve is the one token operation charged
        // against it — and no grant names the destination.
        _setRecipient(router, perpAcct);
        vm.prank(alice);
        acct.grant(keeper, _perm(address(router), StrategyRouter.burnToPerp.selector, _limits1(address(usdc), 3_000e6), 0));
        Call[] memory calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.burnToPerp, (_p(2_000e6, 2e6, 1000)))));
        vm.prank(keeper);
        acct.execAsKeeper(calls);
        assertEq(usdc.balanceOf(address(acct)), MARGIN - 2_000e6);
        assertEq(usdc.balanceOf(keeper), 0, "nothing reached the keeper");
        // over the remaining budget (1,000): refused by the account, nothing burned
        calls = _one(_callP(address(router), abi.encodeCall(StrategyRouter.burnToPerp, (_p(2_000e6, 2e6, 1000)))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(cctpMessenger.burnCount(), 1);
        // the keeper cannot move the destination: no grant names setPerpRecipient
        calls = _one(_call(address(router), abi.encodeCall(StrategyRouter.setPerpRecipient, (makeAddr("elsewhere")))));
        vm.prank(keeper);
        vm.expectRevert();
        acct.execAsKeeper(calls);
        assertEq(router.perpRecipient(address(acct)), perpAcct, "the owner's record stands");
    }
}
